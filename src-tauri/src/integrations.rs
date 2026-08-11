//! Connected service accounts (GitHub, Supabase, Vercel, …).
//! Tokens live in the OS keyring; non-secret metadata in integrations.json.
//! Credentials are attached only to an explicitly selected service operation;
//! generic shell and git processes never receive the integration token set.

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Built-in integration catalog.
#[derive(Debug, Clone, Serialize)]
pub struct IntegrationDef {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub token_label: &'static str,
    pub docs_url: &'static str,
    /// Env vars set when the token is present (first is primary).
    pub env_keys: &'static [&'static str],
    pub test_hint: &'static str,
}

pub const INTEGRATIONS: &[IntegrationDef] = &[
    IntegrationDef {
        id: "github",
        label: "GitHub",
        description: "Push/pull, PRs, gh CLI, git over HTTPS with token auth.",
        token_label: "Personal Access Token (classic or fine-grained)",
        docs_url: "https://github.com/settings/tokens",
        env_keys: &["GITHUB_TOKEN", "GH_TOKEN"],
        test_hint: "Calls api.github.com/user",
    },
    IntegrationDef {
        id: "supabase",
        label: "Supabase",
        description: "Supabase CLI, Management API, project deploy & DB tools.",
        token_label: "Access Token (Account → Access Tokens)",
        docs_url: "https://supabase.com/dashboard/account/tokens",
        env_keys: &["SUPABASE_ACCESS_TOKEN"],
        test_hint: "Lists projects via Management API",
    },
    IntegrationDef {
        id: "vercel",
        label: "Vercel",
        description: "Deploy with vercel CLI, env, domains, project link.",
        token_label: "API Token",
        docs_url: "https://vercel.com/account/tokens",
        env_keys: &["VERCEL_TOKEN"],
        test_hint: "Calls api.vercel.com/v2/user",
    },
    IntegrationDef {
        id: "netlify",
        label: "Netlify",
        description: "Netlify CLI deploy and site management.",
        token_label: "Personal Access Token",
        docs_url: "https://app.netlify.com/user/applications#personal-access-tokens",
        env_keys: &["NETLIFY_AUTH_TOKEN", "NETLIFY_TOKEN"],
        test_hint: "Calls api.netlify.com/api/v1/user",
    },
    IntegrationDef {
        id: "cloudflare",
        label: "Cloudflare",
        description: "Workers, Pages, DNS via API token.",
        token_label: "API Token",
        docs_url: "https://dash.cloudflare.com/profile/api-tokens",
        env_keys: &["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
        test_hint: "Verifies token via Cloudflare API",
    },
    IntegrationDef {
        id: "railway",
        label: "Railway",
        description: "Railway CLI and GraphQL API deploys.",
        token_label: "Account / Project Token",
        docs_url: "https://railway.app/account/tokens",
        env_keys: &["RAILWAY_TOKEN"],
        test_hint: "Token saved (lightweight check)",
    },
    IntegrationDef {
        id: "render",
        label: "Render",
        description: "Render.com API for services and deploys.",
        token_label: "API Key",
        docs_url: "https://dashboard.render.com/u/settings#api-keys",
        env_keys: &["RENDER_API_KEY"],
        test_hint: "Calls api.render.com/v1/owners",
    },
    IntegrationDef {
        id: "fly",
        label: "Fly.io",
        description: "flyctl auth and API access.",
        token_label: "API Token (fly tokens create)",
        docs_url: "https://fly.io/user/personal_access_tokens",
        env_keys: &["FLY_API_TOKEN", "FLY_ACCESS_TOKEN"],
        test_hint: "Token saved for flyctl",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IntegrationExtras {
    /// Optional non-secret fields (e.g. supabase project ref, vercel team id).
    #[serde(default)]
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IntegrationsFile {
    /// id → extras
    #[serde(default)]
    pub services: HashMap<String, IntegrationExtras>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub id: String,
    pub label: String,
    pub description: String,
    pub token_label: String,
    pub docs_url: String,
    pub connected: bool,
    pub env_keys: Vec<String>,
    pub test_hint: String,
    pub extras: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationTestResult {
    pub ok: bool,
    pub message: String,
    pub detail: Option<String>,
}

fn def(id: &str) -> Result<&'static IntegrationDef> {
    INTEGRATIONS
        .iter()
        .find(|d| d.id == id)
        .with_context(|| format!("Unknown integration: {id}"))
}

fn validate_id(id: &str) -> Result<()> {
    def(id)?;
    Ok(())
}

fn keyring_entry(id: &str) -> Result<keyring::Entry> {
    validate_id(id)?;
    // Separate service namespace from LLM provider keys
    Ok(keyring::Entry::new(
        "ai-forge-integrations",
        &format!("token:{id}"),
    )?)
}

fn extras_path() -> Result<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .context("could not determine config dir")?;
    let dir = proj.config_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("integrations.json"))
}

fn load_file() -> Result<IntegrationsFile> {
    let p = extras_path()?;
    if !p.exists() {
        return Ok(IntegrationsFile::default());
    }
    let raw = std::fs::read_to_string(&p)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_file(f: &IntegrationsFile) -> Result<()> {
    let p = extras_path()?;
    let raw = serde_json::to_string_pretty(f)?;
    std::fs::write(p, raw)?;
    Ok(())
}

pub fn store_token(id: &str, token: &str) -> Result<()> {
    validate_id(id)?;
    let token = token.trim();
    ensure!(
        (8..=8192).contains(&token.len()),
        "Token must be between 8 and 8192 characters."
    );
    ensure!(
        !token.chars().any(char::is_control),
        "Token cannot contain control characters."
    );
    let entry = keyring_entry(id)?;
    entry.set_password(token)?;
    Ok(())
}

pub fn load_token(id: &str) -> Result<String> {
    validate_id(id)?;
    let entry = keyring_entry(id)?;
    Ok(entry.get_password()?)
}

pub fn has_token(id: &str) -> bool {
    load_token(id).is_ok()
}

/// Tokens currently held by the app, for in-process output redaction only.
/// Never serialize or return this collection from a command/tool.
pub(crate) fn loaded_tokens() -> Vec<String> {
    INTEGRATIONS
        .iter()
        .filter_map(|integration| load_token(integration.id).ok())
        .filter(|token| token.trim().len() >= 8)
        .collect()
}

pub fn clear_token(id: &str) -> Result<()> {
    validate_id(id)?;
    let entry = keyring_entry(id)?;
    let _ = entry.delete_credential();
    Ok(())
}

pub fn set_extras(id: &str, fields: HashMap<String, String>) -> Result<()> {
    validate_id(id)?;
    let mut clean = HashMap::new();
    for (k, v) in fields {
        let k = k.trim().to_string();
        let v = v.trim().to_string();
        if k.is_empty() || v.is_empty() {
            continue;
        }
        ensure!(k.len() <= 64 && v.len() <= 512, "Extra field too long.");
        ensure!(
            !k.chars().any(char::is_control) && !v.chars().any(char::is_control),
            "Extras cannot contain control characters."
        );
        // Never store secrets in extras
        let kl = k.to_ascii_lowercase();
        ensure!(
            !kl.contains("token") && !kl.contains("secret") && !kl.contains("password"),
            "Do not put secrets in extra fields — use the token field."
        );
        clean.insert(k, v);
    }
    let mut f = load_file()?;
    f.services
        .insert(id.to_string(), IntegrationExtras { fields: clean });
    save_file(&f)
}

pub fn list_status() -> Result<Vec<IntegrationStatus>> {
    let file = load_file().unwrap_or_default();
    let mut out = Vec::with_capacity(INTEGRATIONS.len());
    for d in INTEGRATIONS {
        let extras = file
            .services
            .get(d.id)
            .map(|e| e.fields.clone())
            .unwrap_or_default();
        out.push(IntegrationStatus {
            id: d.id.to_string(),
            label: d.label.to_string(),
            description: d.description.to_string(),
            token_label: d.token_label.to_string(),
            docs_url: d.docs_url.to_string(),
            connected: has_token(d.id),
            env_keys: d.env_keys.iter().map(|s| (*s).to_string()).collect(),
            test_hint: d.test_hint.to_string(),
            extras,
        });
    }
    Ok(out)
}

pub fn status_for(id: &str) -> Result<IntegrationStatus> {
    validate_id(id)?;
    list_status()?
        .into_iter()
        .find(|status| status.id == id)
        .with_context(|| format!("Unknown integration: {id}"))
}

/// Environment for one explicitly selected integration operation.
/// Never call this for a generic shell or git command.
pub fn env_for_service(id: &str) -> Result<HashMap<String, String>> {
    let d = def(id)?;
    let mut map = HashMap::new();
    let file = load_file().unwrap_or_default();
    let token = load_token(id).with_context(|| format!("{} is not connected", d.label))?;
    for key in d.env_keys {
        map.insert((*key).to_string(), token.clone());
    }
    if let Some(extras) = file.services.get(d.id) {
        for (key, value) in &extras.fields {
            let env_name = format!(
                "HORMA_{}_{}",
                d.id.to_ascii_uppercase(),
                key.to_ascii_uppercase().replace('-', "_")
            );
            map.insert(env_name, value.clone());
            if d.id == "supabase" && key.eq_ignore_ascii_case("project_ref") {
                map.insert("SUPABASE_PROJECT_REF".into(), value.clone());
            }
            if d.id == "supabase" && key.eq_ignore_ascii_case("project_url") {
                map.insert("SUPABASE_URL".into(), value.clone());
            }
            if d.id == "vercel" && key.eq_ignore_ascii_case("team_id") {
                map.insert("VERCEL_TEAM_ID".into(), value.clone());
            }
            if d.id == "vercel" && key.eq_ignore_ascii_case("org_id") {
                map.insert("VERCEL_ORG_ID".into(), value.clone());
            }
        }
    }
    Ok(map)
}

/// Short summary for the agent system prompt (no secrets).
pub fn prompt_summary() -> String {
    let mut connected: Vec<String> = Vec::new();
    for d in INTEGRATIONS {
        if has_token(d.id) {
            connected.push(format!("- {} (credential stored securely)", d.label));
        }
    }
    if connected.is_empty() {
        return "CONNECTED ACCOUNTS: none. User can add GitHub / Supabase / Vercel tokens in Settings → Integrations.\n".into();
    }
    format!(
        "CONNECTED ACCOUNTS (credentials remain in the OS keyring):\n{}\n\
Generic run_command and git operations do not receive these credentials. Use only dedicated, service-scoped operations and never ask the user to paste a token into chat.\n",
        connected.join("\n")
    )
}

/// Live API probe (does not return the token).
pub async fn test_connection(id: &str) -> Result<IntegrationTestResult> {
    let d = def(id)?;
    let token = match load_token(id) {
        Ok(t) => t,
        Err(_) => {
            return Ok(IntegrationTestResult {
                ok: false,
                message: format!("No {} token saved yet.", d.label),
                detail: None,
            });
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Hormachuelos/0.1")
        .build()?;

    let result = match id {
        "github" => {
            let res = client
                .get("https://api.github.com/user")
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if status.is_success() {
                let login = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("login")?.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "user".into());
                IntegrationTestResult {
                    ok: true,
                    message: format!("GitHub OK — signed in as {login}"),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("GitHub API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "vercel" => {
            let res = client
                .get("https://api.vercel.com/v2/user")
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if status.is_success() {
                let name = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| {
                        v.get("user")
                            .and_then(|u| u.get("username").or_else(|| u.get("name")))
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                v.get("username")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_string())
                            })
                    })
                    .unwrap_or_else(|| "account".into());
                IntegrationTestResult {
                    ok: true,
                    message: format!("Vercel OK — {name}"),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("Vercel API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "supabase" => {
            let res = client
                .get("https://api.supabase.com/v1/projects")
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if status.is_success() {
                let n = serde_json::from_str::<Vec<serde_json::Value>>(&body)
                    .map(|v| v.len())
                    .unwrap_or(0);
                IntegrationTestResult {
                    ok: true,
                    message: format!("Supabase OK — {n} project(s) visible"),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("Supabase API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "netlify" => {
            let res = client
                .get("https://api.netlify.com/api/v1/user")
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if status.is_success() {
                let email = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("email")?.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "user".into());
                IntegrationTestResult {
                    ok: true,
                    message: format!("Netlify OK — {email}"),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("Netlify API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "cloudflare" => {
            let res = client
                .get("https://api.cloudflare.com/client/v4/user/tokens/verify")
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            let ok = status.is_success()
                && serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("success")?.as_bool())
                    .unwrap_or(false);
            if ok {
                IntegrationTestResult {
                    ok: true,
                    message: "Cloudflare OK — token verified".into(),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("Cloudflare API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "render" => {
            let res = client
                .get("https://api.render.com/v1/owners")
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if status.is_success() {
                IntegrationTestResult {
                    ok: true,
                    message: "Render OK — API key accepted".into(),
                    detail: None,
                }
            } else {
                IntegrationTestResult {
                    ok: false,
                    message: format!("Render API {status}"),
                    detail: Some(trim_body(&body)),
                }
            }
        }
        "railway" | "fly" => IntegrationTestResult {
            ok: true,
            message: format!("{} token saved. Live provider probe skipped.", d.label),
            detail: None,
        },
        _ => IntegrationTestResult {
            ok: true,
            message: format!("{} token is stored.", d.label),
            detail: None,
        },
    };

    Ok(result)
}

/// Synchronous adapter for agent tools, which already run on a blocking worker.
pub fn test_connection_blocking(id: &str) -> Result<IntegrationTestResult> {
    validate_id(id)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to create integration verification runtime")?;
    runtime.block_on(test_connection(id))
}

fn trim_body(s: &str) -> String {
    let t = s.trim();
    if t.len() > 240 {
        let mut end = 240;
        while end > 0 && !t.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &t[..end])
    } else {
        t.to_string()
    }
}

/// Apply one integration's environment to a dedicated service command.
pub fn apply_service_to_command(id: &str, cmd: &mut std::process::Command) -> Result<()> {
    for (k, v) in env_for_service(id)? {
        cmd.env(k, v);
    }
    Ok(())
}

fn validate_browser_url(url: &str) -> Result<String> {
    let url = url.trim();
    ensure!(url.len() <= 2048, "URL too long.");
    ensure!(
        !url.is_empty() && !url.chars().any(char::is_control),
        "URL is empty or contains control characters."
    );
    let parsed = reqwest::Url::parse(url).context("Invalid browser URL.")?;
    ensure!(
        matches!(parsed.scheme(), "https" | "http"),
        "Only http(s) URLs can be opened."
    );
    ensure!(
        parsed.host_str().is_some(),
        "Browser URL must include a host."
    );
    ensure!(
        parsed.username().is_empty() && parsed.password().is_none(),
        "Credentials are not allowed in browser URLs."
    );
    Ok(url.to_string())
}

/// Open a validated URL in the user's default browser (works from headless agent context).
/// Do **not** rely on `gh`/`vercel` spawning the browser under CREATE_NO_WINDOW — it fails.
pub fn open_browser(url: &str) -> Result<()> {
    let url = validate_browser_url(url)?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // Avoid cmd.exe: metacharacters in an otherwise valid URL must never
        // become shell syntax.
        let status = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .context("Failed to launch browser")?;
        ensure!(status.success(), "Browser open command failed.");
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&url)
            .status()
            .context("Failed to launch browser")?;
        ensure!(status.success(), "Browser open command failed.");
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(&url)
            .status()
            .context("Failed to launch browser")?;
        ensure!(status.success(), "Browser open command failed.");
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(anyhow::anyhow!("Browser open not supported on this OS"))
}

/// Docs / token pages for browser-based connect when CLI device flow is unavailable.
fn token_page(id: &str) -> Option<&'static str> {
    INTEGRATIONS.iter().find(|d| d.id == id).map(|d| d.docs_url)
}

/// Start browser-based connect for a service.
/// - GitHub: runs `gh auth login --web`, opens verification URL via OS browser, stores token.
/// - Others: open the official page while the app focuses its secure credential form.
pub fn browser_connect(id: &str) -> Result<IntegrationTestResult> {
    validate_id(id)?;
    match id {
        "github" => github_web_auth(),
        "vercel" => {
            open_browser("https://vercel.com/account/tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Vercel in your browser. Vercel is not connected until you enter the token only in the secure Settings → Integrations → Vercel form. Never send the token in chat.".into(),
                detail: Some("After Save, the credential remains in the OS keyring and is used only by dedicated Vercel operations.".into()),
            })
        }
        "supabase" => {
            open_browser("https://supabase.com/dashboard/account/tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Supabase Access Tokens. Enter the token only in the secure Settings → Integrations → Supabase form; never send it in chat.".into(),
                detail: Some("After Save, the credential remains in the OS keyring and is used only by dedicated Supabase operations.".into()),
            })
        }
        "netlify" => {
            open_browser("https://app.netlify.com/user/applications#personal-access-tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Netlify tokens. Enter the PAT only in the secure Settings → Integrations → Netlify form; never send it in chat.".into(),
                detail: None,
            })
        }
        "cloudflare" => {
            open_browser("https://dash.cloudflare.com/profile/api-tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Cloudflare API tokens. Enter the token only in the secure Settings → Integrations → Cloudflare form; never send it in chat.".into(),
                detail: None,
            })
        }
        "railway" => {
            open_browser("https://railway.app/account/tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Railway tokens. Enter the token only in the secure Settings → Integrations → Railway form; never send it in chat.".into(),
                detail: None,
            })
        }
        "render" => {
            open_browser("https://dashboard.render.com/u/settings#api-keys")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Render API keys. Enter the key only in the secure Settings → Integrations → Render form; never send it in chat.".into(),
                detail: None,
            })
        }
        "fly" => {
            open_browser("https://fly.io/user/personal_access_tokens")?;
            Ok(IntegrationTestResult {
                ok: true,
                message: "Opened Fly.io tokens. Enter the token only in the secure Settings → Integrations → Fly.io form; never send it in chat.".into(),
                detail: None,
            })
        }
        _ => {
            if let Some(url) = token_page(id) {
                open_browser(url)?;
                Ok(IntegrationTestResult {
                    ok: true,
                    message: format!("Opened {id} token page. Enter the token only in the in-chat Connect card (or Settings → Integrations); never send it in a chat message."),
                    detail: None,
                })
            } else {
                Err(anyhow::anyhow!("Unknown service"))
            }
        }
    }
}

fn open_browser_once(url: &str, opened: &std::sync::Arc<std::sync::Mutex<bool>>) {
    let Ok(mut opened) = opened.lock() else {
        return;
    };
    if *opened {
        return;
    }
    *opened = open_browser(url).is_ok();
}

/// GitHub web login via `gh` device flow + OS browser (not the headless shell's broken open).
fn github_web_auth() -> Result<IntegrationTestResult> {
    // Prefer already-stored Hormachuelos token
    if has_token("github") {
        return Ok(IntegrationTestResult {
            ok: true,
            message: "GitHub is already connected in Hormachuelos (token saved securely). Generic shell and git commands do not receive it.".into(),
            detail: Some("Disconnect in Settings → Integrations if you want to re-auth.".into()),
        });
    }

    // If gh already logged in, import token
    if let Ok(existing) = run_gh_capture(&["auth", "token"]) {
        let t = existing.trim();
        if t.len() >= 8 && !t.contains(' ') && !t.to_lowercase().contains("error") {
            store_token("github", t)?;
            return Ok(IntegrationTestResult {
                ok: true,
                message: "Imported existing `gh` login into Hormachuelos. GitHub is connected."
                    .into(),
                detail: None,
            });
        }
    }

    if which_gh().is_none() {
        open_browser("https://github.com/settings/tokens?type=beta")?;
        return Ok(IntegrationTestResult {
            ok: true,
            message: "GitHub CLI (gh) is not installed, so browser device login is unavailable. Enter a PAT only in the secure Settings → Integrations → GitHub form; never send it in chat. To enable device login: winget install GitHub.cli".into(),
            detail: None,
        });
    }

    // Start web/device login. gh may fail to open the browser itself under a service context —
    // we scrape the URL from output and open it with open_browser().
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new("gh");
    cmd.args(["auth", "login", "-h", "github.com", "-p", "https", "-w"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().context("Failed to start `gh auth login`")?;

    // Answer any residual prompts with newlines / defaults
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin);
        let _ = stdin.flush();
    }

    let opened = Arc::new(Mutex::new(false));
    let opened_c = opened.clone();
    let mut combined = String::new();

    let scrape = |line: &str, opened: &Arc<Mutex<bool>>, combined: &mut String| {
        combined.push_str(line);
        combined.push('\n');
        // Open any github.com URL (device login / authorize)
        for word in line.split_whitespace() {
            let w = word.trim_matches(|c: char| c == '"' || c == '\'' || c == ')' || c == '(');
            if w.starts_with("https://github.com/") || w.starts_with("http://github.com/") {
                open_browser_once(w, opened);
            }
        }
        // Also open device page if one-time code is mentioned but URL missing
        if line.to_lowercase().contains("one-time code") || line.contains("one-time code:") {
            open_browser_once("https://github.com/login/device", opened);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let opened_out = opened_c.clone();
    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));
    let out_c = out_buf.clone();
    let err_c = err_buf.clone();

    let t_out = thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(std::result::Result::ok) {
                let mut c = out_c.lock().unwrap();
                scrape(&line, &opened_out, &mut c);
            }
        }
    });
    let opened_err = opened.clone();
    let t_err = thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(std::result::Result::ok) {
                let mut c = err_c.lock().unwrap();
                scrape(&line, &opened_err, &mut c);
            }
        }
    });

    // Always open device page proactively so user sees a browser immediately
    thread::sleep(Duration::from_millis(400));
    open_browser_once("https://github.com/login/device", &opened);

    // Wait up to 4 minutes for user to finish browser auth
    let status = {
        let start = std::time::Instant::now();
        loop {
            if let Some(st) = child.try_wait().context("wait gh")? {
                break st;
            }
            if start.elapsed() > Duration::from_secs(240) {
                let _ = child.kill();
                let _ = t_out.join();
                let _ = t_err.join();
                return Ok(IntegrationTestResult {
                    ok: false,
                    message: "GitHub browser login timed out (4 min). Try again, or enter a PAT only in the secure Settings → Integrations → GitHub form.".into(),
                    detail: Some(format!(
                        "{}{}",
                        out_buf.lock().unwrap(),
                        err_buf.lock().unwrap()
                    )),
                });
            }
            thread::sleep(Duration::from_millis(300));
        }
    };

    let _ = t_out.join();
    let _ = t_err.join();
    combined.push_str(&out_buf.lock().unwrap());
    combined.push_str(&err_buf.lock().unwrap());

    if !status.success() {
        // Fallback: open PAT page
        let _ = open_browser("https://github.com/settings/tokens?type=beta");
        return Ok(IntegrationTestResult {
            ok: false,
            message: "GitHub browser login did not complete. Opened the token page; enter a PAT only in the secure Settings → Integrations → GitHub form.".into(),
            detail: Some(trim_body(&combined)),
        });
    }

    // Import token from gh into Hormachuelos keyring
    match run_gh_capture(&["auth", "token"]) {
        Ok(tok) => {
            let t = tok.trim();
            if t.len() >= 8 {
                store_token("github", t)?;
                return Ok(IntegrationTestResult {
                    ok: true,
                    message: "GitHub browser login succeeded. Token saved securely for dedicated GitHub operations.".into(),
                    detail: None,
                });
            }
        }
        Err(e) => {
            return Ok(IntegrationTestResult {
                ok: false,
                message: format!("gh login finished but token import failed: {e}. Run Settings → Integrations or `gh auth token`."),
                detail: Some(trim_body(&combined)),
            });
        }
    }

    Ok(IntegrationTestResult {
        ok: true,
        message: "GitHub login finished.".into(),
        detail: None,
    })
}

fn which_gh() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let out = std::process::Command::new("where")
            .arg("gh")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let line = s.lines().next()?.trim();
        if line.is_empty() {
            None
        } else {
            Some(PathBuf::from(line))
        }
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("which")
            .arg("gh")
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let line = s.lines().next()?.trim();
        if line.is_empty() {
            None
        } else {
            Some(PathBuf::from(line))
        }
    }
}

fn run_gh_capture(args: &[&str]) -> Result<String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().context("gh failed to run")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_core_services() {
        let ids: Vec<_> = INTEGRATIONS.iter().map(|d| d.id).collect();
        assert!(ids.contains(&"github"));
        assert!(ids.contains(&"supabase"));
        assert!(ids.contains(&"vercel"));
    }

    #[test]
    fn rejects_unknown_id() {
        assert!(def("not-a-service").is_err());
    }

    #[test]
    fn browser_urls_reject_credentials_and_non_http_schemes() {
        assert!(validate_browser_url("https://example.com/login").is_ok());
        assert!(validate_browser_url("https://user:secret@example.com/").is_err());
        assert!(validate_browser_url("file:///C:/secret.txt").is_err());
        assert!(validate_browser_url("https://example.com/\nmalicious").is_err());
    }

    #[test]
    fn response_body_truncation_preserves_utf8_boundaries() {
        let body = "😀".repeat(100);
        let trimmed = trim_body(&body);
        assert!(trimmed.ends_with('…'));
        assert!(trimmed.is_char_boundary(trimmed.len()));
        assert!(trimmed.len() <= 243);
    }
}
