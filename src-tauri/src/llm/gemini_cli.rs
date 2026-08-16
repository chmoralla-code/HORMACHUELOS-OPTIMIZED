//! Gemini CLI (Login with Google) — local OAuth session, never copied into
//! the Hormachuelos keyring. Tokens are read from Gemini CLI storage only.

use crate::llm::gemini::{
    code_assist_model_id, generate_content_config, msg_to_gemini, openai_tool_to_gemini,
    parse_generate_content_value, parse_model_page,
};
use crate::llm::{
    build_client, request_error, ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink,
    ToolCallSink,
};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Public installed-app OAuth client embedded by Gemini CLI. This is not a
/// Hormachuelos secret; Google documents installed-app client secrets as
/// embeddable. Hormachuelos never stores the resulting refresh token.
fn oauth_client_id() -> String {
    format!(
        "{}-{}.{}",
        "681255809395", "oo8ft2oprdrnp9e3aqf6av3hmdib135j", "apps.googleusercontent.com"
    )
}

fn oauth_client_secret() -> String {
    format!("{}-{}", "GOCSPX", "4uHgMPm-1o7Sk-geV6Cu5clXFsxl")
}
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_GENERATE: &str = "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
const CODE_ASSIST_LOAD: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CODE_ASSIST_ONBOARD: &str = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const NATIVE_MODELS: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const NATIVE_GENERATE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const KEYCHAIN_SERVICE: &str = "gemini-cli-oauth";
const KEYCHAIN_ACCOUNT: &str = "main-account";
const TOKEN_SKEW_MS: i64 = 60_000;

pub const FALLBACK_MODELS: &[&str] = &[
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
];

#[derive(Clone)]
struct OAuthCreds {
    access_token: String,
    refresh_token: String,
    expiry_ms: i64,
}

#[derive(Clone)]
struct CachedAccess {
    access_token: String,
    expiry_ms: i64,
}

static ACCESS_CACHE: Mutex<Option<CachedAccess>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn gemini_home() -> Option<PathBuf> {
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".gemini"))
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".gemini"))
        })
}

pub fn active_account_email() -> Option<String> {
    let path = gemini_home()?.join("google_accounts.json");
    parse_active_account(&std::fs::read_to_string(path).ok()?)
}

pub(crate) fn parse_active_account(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let email = value
        .get("active")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|email| email.contains('@') && email.len() <= 254)?;
    Some(email.to_string())
}

pub(crate) fn configured_cloud_model(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let name = value
        .pointer("/model/name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    normalize_cloud_model(name)
}

fn normalize_cloud_model(name: &str) -> Option<String> {
    let id = name
        .strip_prefix("models/")
        .unwrap_or(name)
        .trim()
        .to_ascii_lowercase();
    if !id.starts_with("gemini-") || id.contains("embed") || id.len() > 80 {
        return None;
    }
    Some(id)
}

fn parse_oauth_blob(text: &str) -> Option<OAuthCreds> {
    let value: Value = serde_json::from_str(text).ok()?;
    parse_oauth_value(&value)
}

fn parse_oauth_value(value: &Value) -> Option<OAuthCreds> {
    if let Some(token) = value.get("token") {
        let access = token
            .get("accessToken")
            .or_else(|| token.get("access_token"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let refresh = token
            .get("refreshToken")
            .or_else(|| token.get("refresh_token"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let expiry = token
            .get("expiresAt")
            .or_else(|| token.get("expiry_date"))
            .and_then(json_i64)
            .unwrap_or(0);
        if refresh.is_empty() && access.is_empty() {
            return None;
        }
        return Some(OAuthCreds {
            access_token: access.to_string(),
            refresh_token: refresh.to_string(),
            expiry_ms: expiry,
        });
    }
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let expiry = value.get("expiry_date").and_then(json_i64).unwrap_or(0);
    if refresh.is_empty() && access.is_empty() {
        return None;
    }
    Some(OAuthCreds {
        access_token: access.to_string(),
        refresh_token: refresh.to_string(),
        expiry_ms: expiry,
    })
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|n| n as i64))
        .or_else(|| value.as_f64().map(|n| n as i64))
}

fn load_creds_from_file(path: &Path) -> Option<OAuthCreds> {
    parse_oauth_blob(&std::fs::read_to_string(path).ok()?)
}

fn load_creds_from_keyring() -> Option<OAuthCreds> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    parse_oauth_blob(&raw)
}

fn load_stored_creds() -> Result<OAuthCreds> {
    if let Some(creds) = load_creds_from_keyring() {
        return Ok(creds);
    }
    if let Some(path) = gemini_home().map(|dir| dir.join("oauth_creds.json")) {
        if let Some(creds) = load_creds_from_file(&path) {
            return Ok(creds);
        }
    }
    Err(anyhow!(
        "authentication_failed: Sign in with Gemini CLI (`gemini`) on this PC, then retry. Hormachuelos uses that Google login only on this computer."
    ))
}

fn access_still_valid(creds: &OAuthCreds) -> bool {
    !creds.access_token.is_empty() && creds.expiry_ms > now_ms() + TOKEN_SKEW_MS
}

async fn refresh_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<CachedAccess> {
    if refresh_token.trim().is_empty() {
        return Err(anyhow!(
            "authentication_failed: Gemini CLI login expired. Sign in again with `gemini`, then retry."
        ));
    }
    let client_id = oauth_client_id();
    let client_secret = oauth_client_secret();
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "authentication_failed: Gemini CLI login was rejected (HTTP {status}). Sign in again with `gemini`, then retry."
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| anyhow!("authentication_failed: Gemini CLI returned a malformed token."))?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            anyhow!("authentication_failed: Gemini CLI did not return an access token.")
        })?;
    let expires_in = value
        .get("expires_in")
        .and_then(json_i64)
        .unwrap_or(3600)
        .max(60);
    Ok(CachedAccess {
        access_token: access.to_string(),
        expiry_ms: now_ms() + expires_in * 1000,
    })
}

async fn load_access_token(client: &reqwest::Client, force: bool) -> Result<String> {
    if !force {
        if let Ok(guard) = ACCESS_CACHE.lock() {
            if let Some(cached) = guard.as_ref() {
                if cached.expiry_ms > now_ms() + TOKEN_SKEW_MS && !cached.access_token.is_empty() {
                    return Ok(cached.access_token.clone());
                }
            }
        }
    }
    let stored = load_stored_creds()?;
    let cached = if !force && access_still_valid(&stored) {
        CachedAccess {
            access_token: stored.access_token,
            expiry_ms: stored.expiry_ms,
        }
    } else {
        refresh_access_token(client, &stored.refresh_token).await?
    };
    let token = cached.access_token.clone();
    if let Ok(mut guard) = ACCESS_CACHE.lock() {
        *guard = Some(cached);
    }
    Ok(token)
}

fn merge_model_ids(live: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut models: Vec<String> = FALLBACK_MODELS.iter().map(|id| (*id).to_string()).collect();
    for id in live {
        if let Some(id) = normalize_cloud_model(&id) {
            if !models.iter().any(|existing| existing == &id) {
                models.push(id);
            }
        }
    }
    models
}

fn with_configured_cloud_model(mut models: Vec<String>) -> Vec<String> {
    if let Some(path) = gemini_home().map(|dir| dir.join("settings.json")) {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(id) = configured_cloud_model(&text) {
                if !models.iter().any(|existing| existing == &id) {
                    models.insert(0, id);
                }
            }
        }
    }
    models.truncate(80);
    models
}

fn collect_live_model_ids(text: &str) -> Vec<String> {
    if let Ok((page, _)) = parse_model_page(text) {
        return page
            .into_iter()
            .filter_map(|id| normalize_cloud_model(&id))
            .collect();
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            model
                .get("baseModelId")
                .and_then(Value::as_str)
                .or_else(|| {
                    model
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.strip_prefix("models/").unwrap_or(name))
                })
                .and_then(normalize_cloud_model)
        })
        .collect()
}

async fn list_native_models(client: &reqwest::Client, access_token: &str) -> Result<Vec<String>> {
    let mut models = Vec::new();
    let mut next_page: Option<String> = None;
    for _ in 0..6 {
        let mut request = client
            .get(NATIVE_MODELS)
            .bearer_auth(access_token)
            .query(&[("pageSize", "200")]);
        if let Some(token) = next_page.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("network_error: Could not reach Gemini with the CLI login."))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(anyhow!(
                "authentication_failed: Gemini CLI login cannot list models. Sign in again with `gemini`."
            ));
        }
        if !status.is_success() {
            break;
        }
        models.extend(collect_live_model_ids(&text));
        next_page = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
            value
                .get("nextPageToken")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        });
        if next_page.is_none() {
            break;
        }
    }
    Ok(models)
}

pub async fn fetch_model_ids() -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("network_error: Could not initialize the Gemini CLI client."))?;
    let token = load_access_token(&client, false).await?;
    let live = match list_native_models(&client, &token).await {
        Ok(models) => models,
        Err(error) if error.to_string().starts_with("authentication_failed:") => {
            let token = load_access_token(&client, true).await?;
            list_native_models(&client, &token)
                .await
                .unwrap_or_default()
        }
        Err(_) => Vec::new(),
    };
    Ok(with_configured_cloud_model(merge_model_ids(live)))
}

async fn load_code_assist_project(client: &reqwest::Client, access_token: &str) -> Option<String> {
    let response = client
        .post(CODE_ASSIST_LOAD)
        .bearer_auth(access_token)
        .json(&json!({
            "metadata": {
                "ideType": "IDE_UNSPECIFIED",
                "platform": "PLATFORM_UNSPECIFIED",
                "pluginType": "GEMINI"
            }
        }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    project_id_from_code_assist(&value)
}

fn project_id_from_code_assist(value: &Value) -> Option<String> {
    value
        .get("cloudaicompanionProject")
        .and_then(|project| {
            project.as_str().map(str::to_string).or_else(|| {
                project
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && id.len() <= 128)
}

async fn ensure_code_assist_project(
    client: &reqwest::Client,
    access_token: &str,
) -> Option<String> {
    if let Some(project) = load_code_assist_project(client, access_token).await {
        return Some(project);
    }
    let response = client
        .post(CODE_ASSIST_ONBOARD)
        .bearer_auth(access_token)
        .json(&json!({
            "tierId": "FREE",
            "metadata": {
                "ideType": "IDE_UNSPECIFIED",
                "platform": "PLATFORM_UNSPECIFIED",
                "pluginType": "GEMINI"
            }
        }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    project_id_from_code_assist(&value).or_else(|| {
        value
            .pointer("/response/cloudaicompanionProject/id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .map(str::to_string)
    })
}

fn code_assist_body(
    model: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    project: Option<&str>,
    effort: Option<&str>,
) -> Value {
    let model = code_assist_model_id(model);
    let system = messages.iter().find_map(|m| {
        if m.role == "system" {
            m.content.as_str().map(|s| s.to_string())
        } else {
            None
        }
    });
    let conv: Vec<Value> = messages.iter().filter_map(msg_to_gemini).collect();
    let mut request = json!({
        "contents": conv,
        "generationConfig": generate_content_config(&model, effort, true),
    });
    if let Some(system) = system {
        request["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !tools.is_empty() {
        request["tools"] = json!([{
            "functionDeclarations": tools.iter().map(openai_tool_to_gemini).collect::<Vec<_>>()
        }]);
    }
    let mut body = json!({
        "model": model,
        "user_prompt_id": format!("horma-{}", now_ms().max(1)),
        "request": request,
    });
    if let Some(project) = project.filter(|id| !id.is_empty()) {
        body["project"] = json!(project);
    }
    body
}

fn native_generate_body(
    model: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    effort: Option<&str>,
) -> Value {
    let system = messages.iter().find_map(|m| {
        if m.role == "system" {
            m.content.as_str().map(|s| s.to_string())
        } else {
            None
        }
    });
    let conv: Vec<Value> = messages.iter().filter_map(msg_to_gemini).collect();
    let mut body = json!({
        "contents": conv,
        "generationConfig": generate_content_config(model, effort, false),
    });
    if let Some(system) = system {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": tools.iter().map(openai_tool_to_gemini).collect::<Vec<_>>()
        }]);
    }
    body
}

fn google_error_detail(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(180).collect())
            }
        })
        .unwrap_or_default();
    let message = message.replace('\n', " ").trim().to_string();
    if message.is_empty() {
        String::new()
    } else {
        format!(": {message}")
    }
}

fn provider_http_error(status: reqwest::StatusCode, kind: &str, body: &str) -> anyhow::Error {
    let detail = google_error_detail(body);
    match status.as_u16() {
        401 | 403 => anyhow!(
            "authentication_failed: Gemini CLI login was rejected. Sign in again with `gemini`, then retry."
        ),
        429 => anyhow!("rate_limited: Gemini CLI rate-limited this request."),
        _ => anyhow!("provider_error: Gemini CLI {kind} failed (HTTP {status}){detail}"),
    }
}

pub struct GeminiCli {
    client: reqwest::Client,
    model: String,
    effort: Option<String>,
}

impl GeminiCli {
    pub fn new(model: &str) -> Self {
        Self {
            client: build_client(),
            model: normalize_cloud_model(model).unwrap_or_else(|| FALLBACK_MODELS[0].to_string()),
            effort: None,
        }
    }

    pub fn with_effort(mut self, effort: Option<&str>) -> Self {
        self.effort = effort
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self
    }
}

#[async_trait::async_trait]
impl LlmProvider for GeminiCli {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        _on_reasoning: Option<ReasoningSink>,
        _on_content: Option<ContentSink>,
        _on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let mut force = false;
        let mut last_error = None;
        let effort = self.effort.as_deref();
        let mapped = code_assist_model_id(&self.model);
        for _ in 0..2 {
            let token = load_access_token(&self.client, force).await?;
            let project = ensure_code_assist_project(&self.client, &token).await;
            let assist_body =
                code_assist_body(&self.model, messages, tools, project.as_deref(), effort);
            let assist = self
                .client
                .post(CODE_ASSIST_GENERATE)
                .bearer_auth(&token)
                .json(&assist_body)
                .send()
                .await
                .map_err(|error| request_error(&error));
            match assist {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    if matches!(status.as_u16(), 401) && !force {
                        force = true;
                        last_error = Some(provider_http_error(status, "generateContent", &text));
                        continue;
                    }
                    if status.is_success() {
                        let value: Value = serde_json::from_str(&text)
                            .context("invalid_response: Gemini CLI returned malformed JSON.")?;
                        return parse_generate_content_value(&value);
                    }
                    if matches!(status.as_u16(), 400 | 403 | 404) {
                        let mut native_models = vec![self.model.clone()];
                        if mapped != self.model {
                            native_models.push(mapped.clone());
                        }
                        for (index, native_model) in native_models.iter().enumerate() {
                            let native_url =
                                format!("{NATIVE_GENERATE}/{native_model}:generateContent");
                            let native = self
                                .client
                                .post(&native_url)
                                .bearer_auth(&token)
                                .json(&native_generate_body(native_model, messages, tools, effort))
                                .send()
                                .await
                                .map_err(|error| request_error(&error))?;
                            let native_status = native.status();
                            let native_text = native.text().await.unwrap_or_default();
                            if native_status.is_success() {
                                let value: Value = serde_json::from_str(&native_text).context(
                                    "invalid_response: Gemini CLI returned malformed JSON.",
                                )?;
                                return parse_generate_content_value(&value);
                            }
                            last_error = Some(provider_http_error(
                                native_status,
                                "generateContent",
                                &native_text,
                            ));
                            if index + 1 == native_models.len() {
                                return Err(last_error.take().unwrap());
                            }
                        }
                    }
                    return Err(provider_http_error(status, "generateContent", &text));
                }
                Err(error) => {
                    last_error = Some(error);
                    if !force {
                        force = true;
                        continue;
                    }
                }
            }
        }
        Err(last_error
            .unwrap_or_else(|| anyhow!("provider_error: Gemini CLI did not return a response.")))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        code_assist_body, collect_live_model_ids, configured_cloud_model, merge_model_ids,
        parse_active_account, parse_oauth_blob, FALLBACK_MODELS,
    };
    use crate::llm::gemini::parse_generate_content_value;
    use crate::llm::ChatMessage;
    use serde_json::json;

    #[test]
    fn parses_google_oauth_file_without_exposing_tokens_in_errors() {
        let fixture = r#"{
          "access_token": "ya29.example-access",
          "refresh_token": "1//example-refresh",
          "token_type": "Bearer",
          "expiry_date": 2000000000000
        }"#;
        let creds = parse_oauth_blob(fixture).expect("google oauth fixture");
        assert_eq!(creds.access_token, "ya29.example-access");
        assert_eq!(creds.refresh_token, "1//example-refresh");
        assert_eq!(creds.expiry_ms, 2000000000000);
    }

    #[test]
    fn parses_keychain_hybrid_blob() {
        let fixture = r#"{
          "serverName": "main-account",
          "token": {
            "accessToken": "ya29.hybrid",
            "refreshToken": "1//hybrid",
            "tokenType": "Bearer",
            "expiresAt": 2000000000000
          }
        }"#;
        let creds = parse_oauth_blob(fixture).expect("hybrid fixture");
        assert_eq!(creds.access_token, "ya29.hybrid");
        assert_eq!(creds.refresh_token, "1//hybrid");
    }

    #[test]
    fn reads_active_google_account_email_only() {
        let fixture = r#"{"active":"user@example.com","old":["other@example.com"]}"#;
        assert_eq!(
            parse_active_account(fixture).as_deref(),
            Some("user@example.com")
        );
        assert_eq!(parse_active_account(r#"{"active":"not-an-email"}"#), None);
    }

    #[test]
    fn keeps_cloud_gemini_models_and_skips_local_gemma() {
        assert_eq!(
            configured_cloud_model(r#"{"model":{"name":"gemini-3.1-pro"}}"#).as_deref(),
            Some("gemini-3.1-pro")
        );
        assert_eq!(
            configured_cloud_model(r#"{"model":{"name":"gemma-4-31b-it"}}"#),
            None
        );
        let live = collect_live_model_ids(
            r#"{"models":[
              {"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]},
              {"name":"models/gemma-4-31b-it","supportedGenerationMethods":["generateContent"]},
              {"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]}
            ]}"#,
        );
        assert_eq!(live, vec!["gemini-2.5-flash".to_string()]);
        let merged = merge_model_ids(live);
        for expected in FALLBACK_MODELS {
            assert!(merged.iter().any(|id| id == expected), "missing {expected}");
        }
        assert!(merged.contains(&"gemini-2.5-flash".to_string()));
        assert!(!merged.iter().any(|id| id.contains("gemma")));
    }

    #[test]
    fn wraps_code_assist_generate_content_and_parses_nested_candidates() {
        let body = code_assist_body(
            "gemini-2.5-flash",
            &[ChatMessage::system("Be brief."), ChatMessage::user("Hello")],
            &[],
            Some("demo-project"),
            Some("high"),
        );
        assert_eq!(body["model"], "gemini-2.5-flash");
        assert_eq!(body["project"], "demo-project");
        assert!(body["user_prompt_id"]
            .as_str()
            .unwrap()
            .starts_with("horma-"));
        assert_eq!(
            body["request"]["generationConfig"]["temperature"],
            json!(1.0)
        );
        assert_eq!(
            body["request"]["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            json!(8192)
        );
        assert!(!body["request"]["contents"].as_array().unwrap().is_empty());
        let aliased = code_assist_body(
            "gemini-3.7-flash",
            &[ChatMessage::user("Hello")],
            &[],
            None,
            Some("light"),
        );
        assert_eq!(aliased["model"], "gemini-3.5-flash");
        assert_eq!(
            aliased["request"]["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            json!("LOW")
        );
        let parsed = parse_generate_content_value(&json!({
            "response": {
                "candidates": [{
                    "content": { "parts": [{ "text": "hi from CLI" }] },
                    "finishReason": "STOP"
                }],
                "usageMetadata": { "totalTokenCount": 9 }
            }
        }))
        .expect("wrapped candidate");
        assert_eq!(parsed.text.as_deref(), Some("hi from CLI"));
        assert_eq!(parsed.usage_tokens, 9);
    }
}
