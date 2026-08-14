use crate::llm::{
    build_client, request_error, ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink,
    ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

pub use crate::config::COMMANDCODE_PROVIDER_API_BASE_URL as COMMAND_CODE_PROVIDER_API;

/// Command Code Studio keys look like `user_` plus a long token. Google AI
/// Studio keys start with `AIza`.
pub fn is_command_code_api_key(key: &str) -> bool {
    let key = key.trim();
    key.starts_with("user_")
        && (48..=200).contains(&key.len())
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub fn is_google_gemini_api_key(key: &str) -> bool {
    key.trim().starts_with("AIza")
}

pub fn uses_command_code_provider_api(api_key: &str, base_url: Option<&str>) -> bool {
    is_command_code_api_key(api_key) || base_url.is_some_and(|url| url.contains("commandcode.ai"))
}

pub fn uses_hosted_gemini_proxy(api_key: &str, base_url: Option<&str>) -> bool {
    !uses_command_code_provider_api(api_key, base_url)
        && !is_google_gemini_api_key(api_key)
        && base_url.is_some_and(|url| url.contains("hormachuelos.vercel.app"))
}

/// Map picker aliases such as `gemini-3.7-flash` to Command Code / OpenRouter ids.
pub fn command_code_gemini_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() {
        return "google/gemini-3.7-flash".into();
    }
    if model.contains('/') {
        return model.to_string();
    }
    match model {
        "gemini-3-7-flash" => "google/gemini-3.7-flash".into(),
        other => format!("google/{other}"),
    }
}

fn parse_model_page(text: &str) -> Result<(Vec<String>, Option<String>)> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: Gemini returned malformed model data."))?;
    let mut models: Vec<String> = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            model
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .any(|method| method.as_str() == Some("generateContent"))
                })
        })
        .filter_map(|model| {
            model
                .get("baseModelId")
                .and_then(Value::as_str)
                .or_else(|| {
                    model
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(|name| name.strip_prefix("models/"))
                })
        })
        .filter(|model| !model.is_empty() && model.len() <= 200)
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    let next_page = value
        .get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    Ok((models, next_page))
}

pub async fn fetch_model_ids(api_key: &str, base_url: &str) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("network_error: Could not initialize the Gemini client."))?;
    let endpoint = format!("{}/v1beta/models", base_url.trim_end_matches('/'));
    let mut models = Vec::new();
    let mut next_page: Option<String> = None;

    for _ in 0..10 {
        let mut request = client
            .get(&endpoint)
            .header("x-goog-api-key", api_key)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = next_page.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("network_error: Could not reach Gemini."))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|_| anyhow!("invalid_response: Gemini's model list could not be read."))?;
        if !status.is_success() {
            return Err(match status.as_u16() {
                400 | 401 | 403 => {
                    anyhow!("authentication_failed: Gemini rejected the saved API key.")
                }
                429 => anyhow!("rate_limited: Gemini rate-limited the model request."),
                _ => anyhow!("provider_error: Gemini could not list models (HTTP {status})."),
            });
        }
        let (page, token) = parse_model_page(&text)?;
        models.extend(page);
        next_page = token;
        if next_page.is_none() {
            break;
        }
    }
    models.sort();
    models.dedup();
    models.truncate(200);
    if models.is_empty() {
        return Err(anyhow!(
            "no_compatible_models: Gemini returned no generateContent models."
        ));
    }
    Ok(models)
}

pub struct Gemini {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
}

impl Gemini {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str) -> Self {
        Self {
            client: build_client(),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://generativelanguage.googleapis.com")
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
        }
    }
}

fn msg_to_gemini(m: &ChatMessage) -> Option<Value> {
    let role = match m.role.as_str() {
        "user" => "user",
        "assistant" => "model",
        "tool" => "user",
        _ => return None,
    };
    let mut parts = Vec::new();
    if let Some(t) = m.content.as_str() {
        if !t.is_empty() {
            parts.push(json!({ "text": t }));
        }
    }
    if let Some(tcs) = &m.tool_calls {
        for tc in tcs {
            parts.push(json!({
                "functionCall": {
                    "name": tc.name,
                    "args": tc.arguments,
                },
                "id": tc.id,
            }));
        }
    }
    if let Some(id) = &m.tool_call_id {
        parts.push(json!({
            "functionResponse": {
                "id": id,
                "name": m.name.clone().unwrap_or_default(),
                "response": { "result": m.content.clone() },
            },
        }));
    }
    if parts.is_empty() {
        return None;
    }
    Some(json!({ "role": role, "parts": parts }))
}

fn openai_tool_to_gemini(t: &Value) -> Value {
    let f = t.get("function").cloned().unwrap_or(Value::Null);
    json!({
        "name": f.get("name").cloned().unwrap_or(Value::Null),
        "description": f.get("description").cloned().unwrap_or(Value::Null),
        "parameters": f.get("parameters").cloned().unwrap_or(json!({})),
    })
}

#[async_trait::async_trait]
impl LlmProvider for Gemini {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        _on_reasoning: Option<ReasoningSink>,
        _on_content: Option<ContentSink>,
        _on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
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
            "generationConfig": { "temperature": 0.2 },
        });
        if let Some(s) = system {
            body["systemInstruction"] = json!({ "parts": [{ "text": s }] });
        }
        if !tools.is_empty() {
            body["tools"] = json!({ "functionDeclarations": tools.iter().map(openai_tool_to_gemini).collect::<Vec<_>>() });
        }

        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.base_url, self.model, self.api_key
        );

        // Retry transient upstream failures (429/5xx) with short backoff so a
        // blip does not abort an active run.
        let mut response = None;
        for attempt in 0..3 {
            let result = self
                .client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|error| request_error(&error));
            match result {
                Ok(res) => {
                    let status = res.status();
                    let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
                    let text = res.text().await.context("failed reading gemini response")?;
                    if retryable && attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                        continue;
                    }
                    if !status.is_success() {
                        return Err(anyhow!("Gemini error {status}: {text}"));
                    }
                    response = Some(text);
                    break;
                }
                Err(error) => {
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        let text = response.ok_or_else(|| anyhow!("Gemini did not return a response."))?;

        let v: Value = serde_json::from_str(&text)?;
        let candidates = v
            .get("candidates")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let cand = candidates
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("no candidates: {text}"))?;
        let parts = cand
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        let mut text_out = String::new();
        let mut tool_calls = Vec::new();
        for p in &parts {
            if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                text_out.push_str(t);
            }
            if let Some(fc) = p.get("functionCall") {
                let name = fc
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = fc.get("args").cloned().unwrap_or(Value::Null);
                let id = fc
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("call")
                    .to_string();
                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments: args,
                });
            }
        }

        let stop = cand
            .get("finishReason")
            .and_then(|f| f.as_str())
            .unwrap_or("STOP")
            .to_string();
        let usage = v
            .get("usageMetadata")
            .and_then(|u| u.get("totalTokenCount"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);

        Ok(LlmResponse {
            text: if text_out.is_empty() {
                None
            } else {
                Some(text_out)
            },
            tool_calls,
            reasoning_content: None,
            stop_reason: stop,
            usage_tokens: usage,
        })
    }
}

#[cfg(test)]
mod model_tests {
    use super::{
        command_code_gemini_model, is_command_code_api_key, is_google_gemini_api_key,
        parse_model_page, uses_command_code_provider_api, uses_hosted_gemini_proxy,
    };

    #[test]
    fn routes_command_code_keys_to_provider_gemini_ids() {
        let command_code_key = format!("user_{}", "a".repeat(60));
        assert!(is_command_code_api_key(&command_code_key));
        assert!(!is_command_code_api_key("user_short"));
        assert!(!is_command_code_api_key("AIzaSyDummyGoogleKeyValue"));
        assert!(is_google_gemini_api_key("AIzaSyDummyGoogleKeyValue"));
        assert!(uses_command_code_provider_api(
            &command_code_key,
            Some("https://hormachuelos.vercel.app/api/v1")
        ));
        assert!(uses_hosted_gemini_proxy(
            "HORMA-TEST",
            Some("https://hormachuelos.vercel.app/api/v1")
        ));
        assert!(!uses_hosted_gemini_proxy(
            &command_code_key,
            Some("https://hormachuelos.vercel.app/api/v1")
        ));
        assert_eq!(
            command_code_gemini_model("gemini-3.7-flash"),
            "google/gemini-3.7-flash"
        );
        assert_eq!(
            command_code_gemini_model("gemini-3-7-flash"),
            "google/gemini-3.7-flash"
        );
        assert_eq!(
            command_code_gemini_model("google/gemini-3.7-flash"),
            "google/gemini-3.7-flash"
        );
    }

    #[test]
    fn keeps_only_generate_content_models_and_page_token() {
        let fixture = r#"{
          "models": [
            {"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]},
            {"baseModelId":"text-embedding-004","supportedGenerationMethods":["embedContent"]},
            {"baseModelId":"gemini-2.5-pro","supportedGenerationMethods":["generateContent"]}
          ],
          "nextPageToken":"next"
        }"#;
        let (models, next) = parse_model_page(fixture).expect("fixture should parse");
        assert_eq!(
            models,
            vec!["gemini-2.5-flash".to_string(), "gemini-2.5-pro".to_string()]
        );
        assert_eq!(next.as_deref(), Some("next"));
    }
}
