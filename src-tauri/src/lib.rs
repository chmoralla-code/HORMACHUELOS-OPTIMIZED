pub mod agent;
pub mod app_updater;
pub mod checkpoint;
pub mod computer_use;
pub mod config;
pub mod cursor_bridge;
pub mod design_source;
pub mod dev_server;
pub mod execution_profile;
pub mod flavour;
pub mod integration_chat;
pub mod integrations;
pub mod license;
pub mod llm;
pub mod preview_browser;
pub mod preview_capture;
pub mod project_intelligence;
pub mod smart_agent;
pub mod state;
pub mod templates;
pub mod tools;
pub mod workspace;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    ok: bool,
    latency_ms: u128,
    error_code: Option<String>,
    message: String,
}

/// Public-safe hosted catalog returned by the website. It deliberately has no
/// upstream base URL or credential fields, so it can be sent to the desktop
/// picker without exposing administrator-managed provider secrets.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedProviderCatalogModel {
    id: String,
    label: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedProviderCatalogEntry {
    id: String,
    label: String,
    models: Vec<HostedProviderCatalogModel>,
}

#[derive(serde::Deserialize)]
struct HostedProviderCatalogResponse {
    data: Vec<HostedProviderCatalogEntry>,
    #[serde(default)]
    restricted: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedProviderCatalogResult {
    data: Vec<HostedProviderCatalogEntry>,
    restricted: bool,
}

#[tauri::command]
fn get_project_root(state: tauri::State<'_, state::AppState>) -> Option<String> {
    state.project_root.lock().unwrap().clone()
}

#[tauri::command]
fn set_project_root(path: String, state: tauri::State<'_, state::AppState>) -> Result<(), String> {
    let selected = workspace::canonical_project_root(std::path::Path::new(&path))
        .map_err(|error| error.to_string())?;
    let root =
        workspace::resolve_open_project_root(&selected).map_err(|error| error.to_string())?;
    let canonical = workspace::display_project_root(&root);
    *state.project_root.lock().unwrap() = Some(canonical.clone());
    if root != selected {
        state.replace_recent_project(&path, canonical);
    } else {
        state.add_recent_project(canonical);
    }
    Ok(())
}

/// Return Hormachuelos' app-managed workspace for sessions that do not need a
/// user-chosen folder. It deliberately stays out of the recent user-projects
/// list: this is a private, durable scratch area rather than an opened project.
fn quick_session_workspace_in(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let path = base.join("Quick Sessions");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the Quick Sessions workspace: {error}"))?;
    workspace::canonical_project_root(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn ensure_quick_session_workspace(
    state: tauri::State<'_, state::AppState>,
) -> Result<String, String> {
    let directories =
        directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
            .ok_or_else(|| "Could not determine the Hormachuelos data folder.".to_string())?;
    let root = quick_session_workspace_in(directories.data_local_dir())?;
    let canonical = workspace::display_project_root(&root);
    *state.project_root.lock().unwrap() = Some(canonical.clone());
    Ok(canonical)
}

#[tauri::command]
fn list_recent_projects(state: tauri::State<'_, state::AppState>) -> Vec<String> {
    state.recent_projects.lock().unwrap().clone()
}

#[tauri::command]
fn remove_recent_project(
    path: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<bool, String> {
    state.remove_recent_project(&path)
}

#[tauri::command]
async fn get_settings(
    state: tauri::State<'_, state::AppState>,
) -> Result<config::Settings, String> {
    Ok(state.settings.lock().unwrap().clone())
}

#[tauri::command]
async fn get_original_model_selection() -> Result<Option<config::OriginalModelSelection>, String> {
    config::load_original_model_selection().map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_settings(
    mut settings: config::Settings,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    // Normalize permission mode + auto_approve together
    let mode = settings.permission_mode.trim().to_ascii_lowercase();
    settings.permission_mode = match mode.as_str() {
        "ask" | "research" => "ask".into(),
        "plan" | "auto" | "full" | "multi_agent" => mode,
        _ => {
            if settings.auto_approve {
                "auto".into()
            } else {
                "plan".into()
            }
        }
    };
    settings.auto_approve = matches!(
        settings.permission_mode.as_str(),
        "auto" | "full" | "multi_agent"
    );
    settings.validate().map_err(|e| e.to_string())?;
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_computer_use_status() -> computer_use::ComputerUseStatus {
    computer_use::status()
}

#[tauri::command]
fn set_computer_use_paused(
    paused: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> computer_use::ComputerUseStatus {
    computer_use::set_paused(paused);
    if paused {
        state.stop_all_runs();
    }
    let status = computer_use::status();
    let _ = app.emit("computer-use-status", &status);
    status
}

#[tauri::command]
async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    config::store_api_key(&provider, &key).map_err(|e| e.to_string())
}

#[tauri::command]
async fn has_api_key(provider: String) -> Result<bool, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    Ok(config::has_provider_api_key(&provider))
}

#[tauri::command]
async fn clear_api_key(provider: String) -> Result<(), String> {
    config::delete_api_key(&provider).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_website_session(token: String) -> Result<(), String> {
    config::store_website_session(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_website_session() -> Result<Option<String>, String> {
    match config::load_website_session() {
        Ok(t) if !t.trim().is_empty() => Ok(Some(t)),
        _ => Ok(None),
    }
}

#[tauri::command]
fn clear_website_session() -> Result<(), String> {
    config::clear_website_session().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("Only http(s) URLs can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn respond_to_question(
    answer: String,
    session_id: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let run = state
        .get_run(&session_id)
        .ok_or_else(|| "No active run for this session.".to_string())?;
    let tx = run.question_tx.lock().unwrap().take();
    match tx {
        Some(tx) => {
            let _ = tx.send(answer);
            Ok(())
        }
        None => Err("No pending question to respond to.".into()),
    }
}

#[tauri::command]
async fn respond_to_confirm(
    approved: bool,
    session_id: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let run = state
        .get_run(&session_id)
        .ok_or_else(|| "No active run for this session.".to_string())?;
    let tx = run.confirm_tx.lock().unwrap().take();
    match tx {
        Some(tx) => {
            let _ = tx.send(approved);
            Ok(())
        }
        None => Err("No pending tool confirmation.".into()),
    }
}

#[tauri::command]
async fn test_provider_connection(
    provider: String,
    model: String,
    base_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Model must be 1-200 characters without control characters.".into());
    }
    if let Some(url) = base_url.as_deref() {
        llm::validate_provider_base_url(&provider, url).map_err(|e| e.to_string())?;
    }

    let started = std::time::Instant::now();
    if provider.eq_ignore_ascii_case("cursor") {
        let key = match config::load_cursor_sdk_api_key("cursor") {
            Ok(key) => key,
            Err(_) => {
                return Ok(ConnectionTestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis(),
                    error_code: Some("missing_api_key".into()),
                    message: "Save a Cursor API key for OpenAI models first.".into(),
                });
            }
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            cursor_bridge::list_cursor_models(&key),
        )
        .await;
        let latency_ms = started.elapsed().as_millis();
        return match result {
            Ok(Ok(models)) if models.iter().any(|id| id.eq_ignore_ascii_case(model.trim())) => {
                Ok(ConnectionTestResult {
                    ok: true,
                    latency_ms,
                    error_code: None,
                    message: format!(
                        "Connected to {} through the Cursor SDK in {} ms.",
                        model.trim(),
                        latency_ms
                    ),
                })
            }
            Ok(Ok(_)) => Ok(ConnectionTestResult {
                ok: false,
                latency_ms,
                error_code: Some("model_unavailable".into()),
                message: format!(
                    "The Cursor account does not currently provide model '{}'. Refresh models or select another model.",
                    model.trim()
                ),
            }),
            Ok(Err(error)) => Ok(ConnectionTestResult {
                ok: false,
                latency_ms,
                error_code: Some("provider_error".into()),
                message: format!("Cursor SDK connection failed: {error}"),
            }),
            Err(_) => Ok(ConnectionTestResult {
                ok: false,
                latency_ms,
                error_code: Some("provider_timeout".into()),
                message: "The Cursor SDK did not respond within 20 seconds.".into(),
            }),
        };
    }
    let is_hormachuelos_free = provider.eq_ignore_ascii_case("hormachuelos_free");
    let license = license::LicenseStatus::load().unwrap_or_default();
    let is_managed_alias = config::is_custom_hosted_provider_alias(&provider);
    // Connection tests must exercise a saved customer key directly. Otherwise
    // a harmless BYOK test could accidentally use (and bill) hosted credits.
    let byok_key =
        if !is_hormachuelos_free && !is_managed_alias && llm::provider_needs_key(&provider) {
            config::load_provider_api_key(&provider)
                .ok()
                .filter(|key| !key.trim().is_empty())
        } else {
            None
        };
    let use_hosted = !is_hormachuelos_free
        && byok_key.is_none()
        && license::should_use_hosted_for_provider(&license, &provider);
    if is_managed_alias && !use_hosted {
        return Ok(ConnectionTestResult {
            ok: false,
            latency_ms: started.elapsed().as_millis(),
            error_code: Some("hosted_plan_required".into()),
            message: "This provider alias is managed by the Hormachuelos server. Sign in with an active hosted plan to use it.".into(),
        });
    }
    let effective_base_url = if is_hormachuelos_free || use_hosted {
        Some(license::hosted_chat_base_url())
    } else {
        base_url.clone()
    };
    let key = if is_hormachuelos_free {
        match config::load_website_session() {
            Ok(session) => session,
            Err(_) => {
                return Ok(ConnectionTestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis(),
                    error_code: Some("sign_in_required".into()),
                    message: "Sign in to Hormachuelos before using HORMACHUELOS FREE.".into(),
                });
            }
        }
    } else if use_hosted {
        license.license_key.clone()
    } else if let Some(key) = byok_key {
        key
    } else if llm::provider_needs_key(&provider) {
        match config::load_provider_api_key(&provider) {
            Ok(key) => key,
            Err(_) => {
                return Ok(ConnectionTestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis(),
                    error_code: Some("missing_api_key".into()),
                    message: "Save an API key for this provider first.".into(),
                });
            }
        }
    } else {
        String::new()
    };

    let client = llm::build_provider(&provider, &key, effective_base_url.as_deref(), model.trim())
        .map_err(|e| e.to_string())?;
    let messages = [
        llm::ChatMessage::system("This is a connection test. Reply with OK only."),
        llm::ChatMessage::user("OK"),
    ];
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        client.chat(&messages, &[], None, None, None),
    )
    .await;

    let latency_ms = started.elapsed().as_millis();
    match result {
        Ok(Ok(_)) => Ok(ConnectionTestResult {
            ok: true,
            latency_ms,
            error_code: None,
            message: format!("Connected to {} in {} ms.", model.trim(), latency_ms),
        }),
        Ok(Err(error)) => {
            let text = error.to_string();
            let code = text
                .split_once(':')
                .map(|(code, _)| code)
                .filter(|code| code.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'))
                .unwrap_or("provider_error")
                .to_string();
            Ok(ConnectionTestResult {
                ok: false,
                latency_ms,
                error_code: Some(code),
                message: text,
            })
        }
        Err(_) => Ok(ConnectionTestResult {
            ok: false,
            latency_ms,
            error_code: Some("provider_timeout".into()),
            message: "The provider did not respond within 20 seconds.".into(),
        }),
    }
}

#[tauri::command]
async fn list_provider_models(
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    if provider.eq_ignore_ascii_case("hormachuelos_free") {
        let builtin_aliases = [
            "hormachuelos-v1",
            "hormachuelos-v2",
            "hormachuelos-v3",
            "hormachuelos-v4",
        ];
        let session = match config::load_website_session() {
            Ok(session) => session,
            // Keep a usable offline fallback before the browser-link flow
            // completes. Once signed in, the server returns the live admin
            // managed alias catalog.
            Err(_) => return Ok(builtin_aliases.into_iter().map(str::to_string).collect()),
        };
        let mut model_ids = llm::openai::fetch_model_ids(
            "hormachuelos_free",
            &session,
            &license::hosted_chat_base_url(),
        )
        .await
        .map_err(|e| e.to_string())?;
        // A deployed website may lag behind a desktop update. Keep local
        // aliases selectable while retaining all live admin-managed aliases.
        for alias in builtin_aliases {
            if !model_ids
                .iter()
                .any(|model| model.eq_ignore_ascii_case(alias))
            {
                model_ids.push(alias.to_string());
            }
        }
        return Ok(model_ids);
    }
    if provider.eq_ignore_ascii_case("cursor") {
        let key = config::load_cursor_sdk_api_key("cursor")
            .map_err(|_| "Save a Cursor / OpenAI key before refreshing models.".to_string())?;
        return cursor_bridge::list_cursor_models(&key)
            .await
            .map_err(|e| e.to_string());
    }
    if provider.eq_ignore_ascii_case("commandcode") {
        return Ok(llm::commandcode::KNOWN_MODELS
            .iter()
            .map(|model| model.to_string())
            .collect());
    }
    let license = license::LicenseStatus::load().unwrap_or_default();
    let use_hosted = license::should_use_hosted_for_provider(&license, &provider);
    if config::is_custom_hosted_provider_alias(&provider) && !use_hosted {
        return Err(
            "This provider alias is managed by the Hormachuelos server. Sign in with an active hosted plan to load its models."
                .into(),
        );
    }
    let (key, base_url) = if use_hosted {
        (license.license_key.clone(), license::hosted_chat_base_url())
    } else {
        let base_url = base_url
            .as_deref()
            .or_else(|| llm::provider_default_base_url(&provider))
            .ok_or_else(|| "A base URL is required for this provider.".to_string())?;
        let base_url =
            llm::validate_provider_base_url(&provider, base_url).map_err(|e| e.to_string())?;
        let key = if llm::provider_needs_key(&provider) {
            config::load_provider_api_key(&provider).map_err(|_| {
                "Save an API key for this provider before refreshing models.".to_string()
            })?
        } else {
            String::new()
        };
        (key, base_url)
    };
    match provider.to_lowercase().as_str() {
        "anthropic" => llm::anthropic::fetch_model_ids(&key, &base_url).await,
        "gemini" => llm::gemini::fetch_model_ids(&key, &base_url).await,
        _ => llm::openai::fetch_model_ids(&provider, &key, &base_url).await,
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_hosted_provider_catalog() -> Result<HostedProviderCatalogResult, String> {
    let session = config::load_website_session().unwrap_or_default();
    let license = license::LicenseStatus::load().unwrap_or_default();
    let license_key = if license.hosted && license.active && !license.license_key.trim().is_empty()
    {
        license.license_key
    } else {
        String::new()
    };
    if session.trim().is_empty() && license_key.trim().is_empty() {
        return Ok(HostedProviderCatalogResult {
            data: Vec::new(),
            restricted: false,
        });
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not initialize the hosted catalog connection.".to_string())?;
    let mut request = client
        .get(format!("{}/catalog", license::hosted_chat_base_url()))
        .header("Accept", "application/json");
    if !license_key.trim().is_empty() {
        request = request.bearer_auth(&license_key);
    }
    if !session.trim().is_empty() {
        request = request.header("X-Horma-Session", session.trim());
    }
    let response = request.send().await.map_err(|_| {
        "Could not load the hosted provider catalog. Check your connection and sign-in status."
            .to_string()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Hosted provider catalog is unavailable (HTTP {}). Refresh your account connection and try again.",
            response.status().as_u16()
        ));
    }
    let payload = response
        .json::<HostedProviderCatalogResponse>()
        .await
        .map_err(|_| "Hosted provider catalog returned an invalid response.".to_string())?;

    let mut provider_ids = std::collections::HashSet::new();
    let mut catalog = Vec::new();
    for entry in payload.data {
        let id = entry.id.trim().to_ascii_lowercase();
        if config::validate_provider_id(&id).is_err()
            || id.eq_ignore_ascii_case("cursor")
            || id.eq_ignore_ascii_case("ollama")
            || !provider_ids.insert(id.clone())
        {
            continue;
        }
        let label = entry.label.trim();
        if label.is_empty() || label.len() > 120 || label.chars().any(char::is_control) {
            continue;
        }
        let mut model_ids = std::collections::HashSet::new();
        let mut models = Vec::new();
        for model in entry.models {
            let model_id = model.id.trim();
            let model_label = model.label.trim();
            if model_id.is_empty()
                || model_id.len() > 200
                || model_id.chars().any(char::is_control)
                || model_label.is_empty()
                || model_label.len() > 120
                || model_label.chars().any(char::is_control)
                || !model_ids.insert(model_id.to_string())
            {
                continue;
            }
            models.push(HostedProviderCatalogModel {
                id: model_id.to_string(),
                label: model_label.to_string(),
            });
        }
        if !models.is_empty() {
            catalog.push(HostedProviderCatalogEntry {
                id,
                label: label.to_string(),
                models,
            });
        }
    }
    catalog.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(HostedProviderCatalogResult {
        data: catalog,
        restricted: payload.restricted,
    })
}

#[tauri::command]
async fn create_project_dir(
    path: String,
    template_id: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let tid = template_id.unwrap_or_else(|| "blank".into());
    templates::scaffold(&tid, p).map_err(|e| e.to_string())?;
    let root = workspace::canonical_project_root(p).map_err(|error| error.to_string())?;
    let canonical = workspace::display_project_root(&root);
    *state.project_root.lock().unwrap() = Some(canonical.clone());
    state.add_recent_project(canonical);
    Ok(())
}

/// Guard for the **New build** flow: tells the picker whether the chosen
/// parent directory is itself an existing source project (manifest + layout
/// or .git). Creating a fresh blank project inside such a folder creates the
/// exact "empty project nested in the real one" trap users hit when they mean
/// to *open* the parent instead.
#[tauri::command]
fn check_project_parent_is_existing_project(path: String) -> bool {
    let parent = std::path::Path::new(&path);
    match parent.canonicalize() {
        Ok(parent) if parent.is_dir() => workspace::looks_like_project_root(&parent),
        _ => false,
    }
}

#[tauri::command]
fn list_project_templates() -> Vec<serde_json::Value> {
    templates::TEMPLATES
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "label": t.label,
                "blurb": t.blurb,
            })
        })
        .collect()
}

#[tauri::command]
fn export_client_pack(
    dest_path: Option<String>,
    handoff_summary: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::ClientPackResult, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project before exporting a client pack.".to_string())?;
    let root_path = std::path::Path::new(&root);
    let zip_path = if let Some(dest) = dest_path.filter(|s| !s.trim().is_empty()) {
        std::path::PathBuf::from(dest)
    } else {
        let name = root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".into());
        root_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(format!("{name}-client-pack.zip"))
    };
    workspace::export_client_pack(root_path, &zip_path, handoff_summary.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_license_status() -> Result<license::LicenseStatus, String> {
    license::LicenseStatus::load()
        .map(|s| s.for_api())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_license_key(key: String) -> Result<license::LicenseStatus, String> {
    license::apply_license_key(&key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn record_license_usage(tokens: u64) -> Result<license::LicenseStatus, String> {
    license::record_token_usage(tokens).map_err(|e| e.to_string())
}

fn paste_image_extension(mime: &str, fallback_name: &str) -> &'static str {
    let mime_l = mime.to_ascii_lowercase();
    let name_l = fallback_name.to_ascii_lowercase();
    if mime_l.contains("jpeg")
        || mime_l.contains("jpg")
        || name_l.ends_with(".jpg")
        || name_l.ends_with(".jpeg")
    {
        "jpg"
    } else if mime_l.contains("webp") || name_l.ends_with(".webp") {
        "webp"
    } else if mime_l.contains("gif") || name_l.ends_with(".gif") {
        "gif"
    } else if mime_l.contains("bmp") || name_l.ends_with(".bmp") {
        "bmp"
    } else {
        "png"
    }
}

fn write_paste_image_bytes(bytes: &[u8], ext: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Empty image data.".into());
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Image is too large (max 25 MB).".into());
    }
    let dir = std::env::temp_dir().join("hormachuelos-paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("paste-{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Persist a clipboard / drag-drop image so the composer can attach it by path.
#[tauri::command]
fn save_pasted_image(data_base64: String, mime: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let raw = data_base64.trim();
    let b64 = raw
        .strip_prefix("data:")
        .and_then(|s| s.split_once(',').map(|(_, d)| d))
        .unwrap_or(raw);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64))
        .map_err(|e| format!("Invalid image data: {e}"))?;
    let ext = paste_image_extension(mime.as_deref().unwrap_or(""), "");
    write_paste_image_bytes(&bytes, ext)
}

/// Copy an on-disk image (Explorer paste, file picker) into the app paste dir
/// so `view_image` can always read it.
#[tauri::command]
fn import_image_path(path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(path.trim().trim_matches('"'));
    if !src.is_file() {
        return Err(format!("Image file not found: {}", src.display()));
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png");
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    ) {
        return Err(format!(
            "Unsupported image type .{ext}. Use PNG, JPG, WEBP, GIF, or BMP."
        ));
    }
    let bytes = std::fs::read(&src).map_err(|e| format!("Could not read image: {e}"))?;
    let out_ext = paste_image_extension("", name);
    write_paste_image_bytes(&bytes, out_ext)
}

const MAX_PASTE_VIDEO_BYTES: u64 = 750 * 1024 * 1024;
const MAX_RAW_PASTE_VIDEO_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CLIPBOARD_VIDEO_FILES: usize = 20;

fn is_supported_video_extension(ext: &str) -> bool {
    matches!(
        ext,
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi" | "wmv" | "flv" | "mpeg" | "mpg" | "3gp"
    )
}

fn write_paste_video_bytes(bytes: &[u8], ext: &str, max_bytes: u64) -> Result<String, String> {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !is_supported_video_extension(&ext) {
        return Err(format!(
            "Unsupported video type .{ext}. Use MP4, MOV, WEBM, MKV, AVI, WMV, FLV, MPEG, or 3GP."
        ));
    }
    if bytes.is_empty() {
        return Err("Video is empty.".into());
    }
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "Pasted video is too large (max {} MB). Use + → Video for larger files.",
            max_bytes / (1024 * 1024)
        ));
    }

    let dir = std::env::temp_dir().join("hormachuelos-paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("video-{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&dest, bytes).map_err(|e| format!("Could not save pasted video: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Persist an in-memory video exposed by the WebView clipboard. Raw IPC avoids
/// the large base64/JSON expansion that would otherwise duplicate recordings.
#[tauri::command]
fn save_pasted_video(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let ext = request
        .headers()
        .get("x-ai-forge-video-extension")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Pasted video must use a raw byte payload.".into());
    };
    write_paste_video_bytes(bytes, ext, MAX_RAW_PASTE_VIDEO_BYTES)
}

fn import_video_file(src: &std::path::Path) -> Result<String, String> {
    use std::io::{Read, Write};

    if !src.is_file() {
        return Err(format!("Video file not found: {}", src.display()));
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !is_supported_video_extension(&ext) {
        return Err(format!(
            "Unsupported video type .{ext}. Use MP4, MOV, WEBM, MKV, AVI, WMV, FLV, MPEG, or 3GP."
        ));
    }
    let metadata = std::fs::metadata(src).map_err(|e| format!("Could not inspect video: {e}"))?;
    if metadata.len() == 0 {
        return Err("Video is empty.".into());
    }
    if metadata.len() > MAX_PASTE_VIDEO_BYTES {
        return Err("Video is too large (max 750 MB).".into());
    }

    let dir = std::env::temp_dir().join("hormachuelos-paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("video-{}.{}", uuid::Uuid::new_v4(), ext));
    let copied = (|| -> Result<u64, String> {
        let input = std::fs::File::open(src).map_err(|e| format!("Could not read video: {e}"))?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .map_err(|e| format!("Could not create video attachment: {e}"))?;
        let copied = std::io::copy(&mut input.take(MAX_PASTE_VIDEO_BYTES + 1), &mut output)
            .map_err(|e| format!("Could not copy video: {e}"))?;
        output
            .flush()
            .map_err(|e| format!("Could not finalize video: {e}"))?;
        if copied > MAX_PASTE_VIDEO_BYTES {
            return Err("Video is too large (max 750 MB).".into());
        }
        Ok(copied)
    })();
    if copied.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    copied?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Copy a user-selected video into the app's attachment directory. Keeping a
/// private copy makes the attachment survive Explorer moves and lets the
/// WebView sample frames without granting an agent access to arbitrary paths.
#[tauri::command]
fn import_video_path(path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(path.trim().trim_matches('"'));
    import_video_file(&src)
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardVideoImportResult {
    paths: Vec<String>,
    errors: Vec<String>,
}

fn import_clipboard_video_files(paths: Vec<std::path::PathBuf>) -> ClipboardVideoImportResult {
    let mut result = ClipboardVideoImportResult::default();
    let mut seen = std::collections::HashSet::new();
    let mut supported_count = 0usize;

    for src in paths {
        let ext = src
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !is_supported_video_extension(&ext) {
            continue;
        }
        let identity = src.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(identity) {
            continue;
        }
        supported_count += 1;
        if supported_count > MAX_CLIPBOARD_VIDEO_FILES {
            continue;
        }
        match import_video_file(&src) {
            Ok(path) => result.paths.push(path),
            Err(error) => {
                let name = src
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "video".into());
                result.errors.push(format!("{name}: {error}"));
            }
        }
    }

    if supported_count > MAX_CLIPBOARD_VIDEO_FILES {
        result.errors.push(format!(
            "Only the first {MAX_CLIPBOARD_VIDEO_FILES} copied videos can be attached at once."
        ));
    }
    result
}

#[cfg(windows)]
fn clipboard_file_paths() -> Result<Vec<std::path::PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::{
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            },
            Ole::CF_HDROP,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    let mut last_error = None;
    let mut opened = false;
    for attempt in 0..4 {
        match unsafe { OpenClipboard(None) } {
            Ok(()) => {
                opened = true;
                break;
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_millis(12));
                }
            }
        }
    }
    if !opened {
        return Err(format!(
            "Could not open the Windows clipboard: {}",
            last_error.unwrap_or_else(|| "clipboard is busy".into())
        ));
    }
    let _guard = ClipboardGuard;

    if unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32) }.is_err() {
        return Ok(Vec::new());
    }
    let handle = unsafe { GetClipboardData(CF_HDROP.0 as u32) }
        .map_err(|error| format!("Could not read copied files: {error}"))?;
    let hdrop = HDROP(handle.0);
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let mut paths = Vec::with_capacity((count as usize).min(256));
    for index in 0..count.min(256) {
        let len = unsafe { DragQueryFileW(hdrop, index, None) };
        if len == 0 {
            continue;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) };
        if copied == 0 {
            continue;
        }
        let path = std::ffi::OsString::from_wide(&buffer[..copied as usize]);
        paths.push(std::path::PathBuf::from(path));
    }
    Ok(paths)
}

#[cfg(not(windows))]
fn clipboard_file_paths() -> Result<Vec<std::path::PathBuf>, String> {
    Ok(Vec::new())
}

/// Import videos copied in Explorer or Windows Snipping Tool. WebView2 does
/// not consistently expose the native CF_HDROP list to DOM ClipboardEvents.
#[tauri::command]
async fn import_clipboard_videos() -> Result<ClipboardVideoImportResult, String> {
    tokio::task::spawn_blocking(|| -> Result<ClipboardVideoImportResult, String> {
        Ok(import_clipboard_video_files(clipboard_file_paths()?))
    })
    .await
    .map_err(|error| format!("Could not inspect the clipboard: {error}"))?
}

#[tauri::command]
fn list_project_files(
    max_depth: Option<u32>,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::ProjectTree, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to browse its files.".to_string())?;
    workspace::list_project_files(std::path::Path::new(&root), max_depth.unwrap_or(8))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_project_file(
    relative_path: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::FilePreview, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to preview a file.".to_string())?;
    workspace::read_project_file(std::path::Path::new(&root), &relative_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_project_file(
    relative_path: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to delete one of its files.".to_string())?;
    workspace::delete_project_file(std::path::Path::new(&root), &relative_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_project_files(state: tauri::State<'_, state::AppState>) -> Result<u64, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to clear its files.".to_string())?;
    workspace::clear_project_files(std::path::Path::new(&root)).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_run_checkpoints(
    project_root: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Vec<checkpoint::CheckpointSummary> {
    let project_root = project_root.or_else(|| state.project_root.lock().unwrap().clone());
    state.checkpoints.list(project_root.as_deref())
}

#[tauri::command]
fn rollback_run_checkpoint(
    checkpoint_id: String,
    scope: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Result<checkpoint::RollbackResult, String> {
    let checkpoint = state
        .checkpoints
        .get(checkpoint_id.trim())
        .ok_or_else(|| "Rollback checkpoint was not found or has expired.".to_string())?;
    let checkpoint_project = checkpoint.summary().project_root;
    if state.has_active_run_for_project(&checkpoint_project) {
        return Err(
            "Wait for active agents in this project to finish before rolling back its files."
                .into(),
        );
    }
    let last_action_only = scope
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("last_action"));
    checkpoint.rollback(last_action_only)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn agent_run(
    prompt: String,
    user_request: Option<String>,
    session_id: String,
    history: Option<Vec<agent::HistoryTurn>>,
    project_root: Option<String>,
    cursor_agent_id: Option<String>,
    task_profile: Option<String>,
    execution_profile: Option<String>,
    run_settings: Option<config::Settings>,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> Result<Option<String>, String> {
    if session_id.trim().is_empty() {
        return Err("Missing session id.".into());
    }
    if !config::has_website_session() {
        return Err(
            "Sign in with your Hormachuelos website account first (Download → Log in / Sign up)."
                .into(),
        );
    }
    // Soft server-side reminder if a forced update is published (UI gate is primary).
    if let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        let current = env!("CARGO_PKG_VERSION");
        let url = format!("https://hormachuelos.vercel.app/api/update?current={current}");
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(value) = resp.json::<serde_json::Value>().await {
                if value.get("forceUpdate").and_then(|v| v.as_bool()) == Some(true) {
                    let latest = value
                        .pointer("/latest/version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("latest");
                    return Err(format!(
                        "Update required: install Hormachuelos {latest} from hormachuelos.vercel.app/#/update before running agents."
                    ));
                }
            }
        }
    }
    // Carry the workspace captured by the frontend into this specific run.
    // A project switch must never redirect an already-starting agent.
    let project_root = if let Some(path) = project_root.filter(|path| !path.trim().is_empty()) {
        let root = workspace::canonical_project_root(std::path::Path::new(&path))
            .map_err(|error| error.to_string())?;
        workspace::display_project_root(&root)
    } else {
        state
            .project_root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "No project open. Create or open a project first.".to_string())?
    };
    // Prefer the complete settings snapshot captured synchronously at submit.
    // The shared model bar may be restored for another session while this
    // command is starting; falling back to disk preserves older callers.
    let settings = if let Some(captured) = run_settings {
        captured.validate().map_err(|error| error.to_string())?;
        captured
    } else {
        match config::Settings::load() {
            Ok(s) => {
                *state.settings.lock().unwrap() = s.clone();
                s
            }
            Err(_) => state.settings.lock().unwrap().clone(),
        }
    };

    // A hosted plan's wallet is enforced by the hosted API, not this local
    // cache. That avoids rejecting a client who has just topped up or used a
    // different computer. Keep the local development/test-plan guard only.
    if let Ok(mut lic) = license::LicenseStatus::load() {
        let _ = lic.refresh_usage_status();
        let local_test_plan = !lic.hosted && !lic.plan.eq_ignore_ascii_case("free");
        if local_test_plan && !lic.active {
            return Err(if lic.message.trim().is_empty() {
                "This license is inactive. Renew it before starting a new run.".into()
            } else {
                lic.message
            });
        }
        if local_test_plan && !license::usage_limits_disabled() && lic.is_usage_exhausted() {
            return Err(
                "You've used up this plan period. Mag-load via GCash or upgrade to continue."
                    .into(),
            );
        }
    }

    let resolved_execution_profile = execution_profile::ExecutionProfile::resolve(
        execution_profile.as_deref(),
        &prompt,
        task_profile.as_deref(),
    );
    let (run, _run_guard) = state.start_run(&session_id)?;
    let checkpoint = state.checkpoints.begin_run(
        &session_id,
        std::path::Path::new(&project_root),
        resolved_execution_profile.wire_name(),
    )?;
    run.set_project_root(project_root.clone());
    run.set_checkpoint(
        checkpoint.clone(),
        resolved_execution_profile.protects_command_changes(),
    );
    let app_handle = Arc::new(app);
    // Prefer the session-bound Cursor agent id from the frontend so each chat
    // in the same project keeps its own durable memory across app restarts.
    let cursor_resume = cursor_agent_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .or_else(|| state.cursor_agent_id(&session_id));
    let result = agent::run_loop(
        app_handle,
        project_root,
        prompt,
        user_request.unwrap_or_default(),
        settings,
        session_id.clone(),
        run.clone(),
        history.unwrap_or_default(),
        cursor_resume,
        task_profile,
        Some(resolved_execution_profile.wire_name().to_string()),
    )
    .await;
    checkpoint.mark_finished(if run.cancel.load(std::sync::atomic::Ordering::SeqCst) {
        "cancelled"
    } else if result.is_err() {
        "error"
    } else {
        "finished"
    });
    match &result {
        Ok(Some(agent_id)) => state.set_cursor_agent_id(&session_id, Some(agent_id.clone())),
        Ok(None) => {}
        Err(_) => {}
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_stop(session_id: String, state: tauri::State<'_, state::AppState>) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Missing session id.".into());
    }
    if !state.stop_run(&session_id) {
        return Err("No active run for this session.".into());
    }
    Ok(())
}

/// Native run registry is the source of truth for session/project busy state.
#[tauri::command]
fn active_agent_sessions(state: tauri::State<'_, state::AppState>) -> Vec<String> {
    state.active_run_ids()
}

#[tauri::command]
fn open_project_in_explorer(
    relative_path: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project first.".to_string())?;
    let path = workspace::resolve_project_path(
        std::path::Path::new(&root),
        relative_path.as_deref().unwrap_or(""),
    )
    .map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(serde::Serialize)]
struct AgentSkill {
    id: String,
    name: String,
    path: String,
    source: String,
}

/// Discover agent skills from common Cursor / Claude skill directories.
#[tauri::command]
fn list_agent_skills(state: tauri::State<'_, state::AppState>) -> Vec<AgentSkill> {
    let mut out: Vec<AgentSkill> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    let mut roots: Vec<(std::path::PathBuf, &'static str)> = Vec::new();
    if let Some(home) = directories::UserDirs::new().map(|u| u.home_dir().to_path_buf()) {
        roots.push((home.join(".agents").join("skills"), "agents"));
        roots.push((home.join(".cursor").join("skills-cursor"), "cursor"));
        roots.push((home.join(".cursor").join("skills"), "cursor"));
        roots.push((home.join(".claude").join("skills"), "claude"));
    }
    if let Some(project) = state.project_root.lock().unwrap().clone() {
        let p = std::path::PathBuf::from(project);
        roots.push((p.join(".agents").join("skills"), "project"));
        roots.push((p.join(".cursor").join("skills"), "project"));
        roots.push((p.join("skills"), "project"));
    }

    for (root, source) in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                // Also accept bare folders with a skill.md lowercase
                let alt = path.join("skill.md");
                if !alt.is_file() {
                    continue;
                }
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("skill")
                .to_string();
            let full = path.to_string_lossy().to_string();
            if !seen.insert(full.clone()) {
                continue;
            }
            out.push(AgentSkill {
                id: format!("{source}:{name}"),
                name,
                path: full,
                source: source.to_string(),
            });
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    out
}

#[tauri::command]
fn list_integrations() -> Result<Vec<integrations::IntegrationStatus>, String> {
    integrations::list_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_integration_token(id: String, token: String) -> Result<(), String> {
    integrations::store_token(&id, &token).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_integration_token(id: String) -> Result<(), String> {
    integrations::clear_token(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_integration_extras(
    id: String,
    fields: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    integrations::set_extras(&id, fields).map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_integration(id: String) -> Result<integrations::IntegrationTestResult, String> {
    integrations::test_connection(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Open browser / device-flow auth for an integration (GitHub web login, token pages, …).
#[tauri::command]
async fn start_integration_browser_auth(
    id: String,
) -> Result<integrations::IntegrationTestResult, String> {
    // Run blocking CLI/device flow off the async runtime
    let id2 = id.clone();
    tokio::task::spawn_blocking(move || integrations::browser_connect(&id2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Keep this first: Tauri's single-instance guard must initialize before
        // other plugins can start work in a duplicate process.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // A repeat launch should feel like reopening the app, even when
                // the original window is minimized or temporarily hidden.
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::new())
        .manage(design_source::DesignSourceState::default())
        .invoke_handler(tauri::generate_handler![
            get_project_root,
            app_updater::save_update_backup,
            app_updater::load_update_backup,
            app_updater::clear_update_backup,
            app_updater::app_install_kind,
            app_updater::install_app_update,
            set_project_root,
            ensure_quick_session_workspace,
            list_recent_projects,
            remove_recent_project,
            get_settings,
            get_original_model_selection,
            save_settings,
            get_computer_use_status,
            set_computer_use_paused,
            computer_use::respond_preview_computer,
            set_api_key,
            has_api_key,
            clear_api_key,
            set_website_session,
            get_website_session,
            clear_website_session,
            open_external_url,
            respond_to_question,
            respond_to_confirm,
            test_provider_connection,
            list_provider_models,
            list_hosted_provider_catalog,
            create_project_dir,
            check_project_parent_is_existing_project,
            list_project_templates,
            list_project_files,
            read_project_file,
            delete_project_file,
            clear_project_files,
            list_run_checkpoints,
            rollback_run_checkpoint,
            export_client_pack,
            get_license_status,
            apply_license_key,
            record_license_usage,
            save_pasted_image,
            save_pasted_video,
            preview_capture::capture_preview_selection,
            preview_browser::create_preview_browser,
            preview_browser::set_preview_browser_bounds,
            preview_browser::set_preview_browser_inspection,
            preview_browser::set_preview_browser_inspection_chrome,
            preview_browser::capture_preview_browser_selection,
            preview_browser::navigate_preview_browser,
            preview_browser::preview_browser_action,
            preview_browser::preview_browser_computer,
            preview_browser::close_preview_browser,
            design_source::warm_design_source_index,
            design_source::invalidate_design_source_index,
            design_source::resolve_design_target,
            import_image_path,
            import_video_path,
            import_clipboard_videos,
            agent_run,
            agent_stop,
            active_agent_sessions,
            open_project_in_explorer,
            app_version,
            list_agent_skills,
            list_integrations,
            set_integration_token,
            clear_integration_token,
            set_integration_extras,
            test_integration,
            start_integration_browser_auth,
        ])
        .setup(|app| {
            computer_use::install(app.handle().clone());
            computer_use::install_emergency_hotkey(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hormachuelos");
}

#[cfg(test)]
mod desktop_config_tests {
    use super::{
        import_clipboard_video_files, quick_session_workspace_in, write_paste_video_bytes,
    };

    #[test]
    fn quick_sessions_workspace_is_created_under_its_managed_root() {
        let base =
            std::env::temp_dir().join(format!("ai-forge-quick-session-{}", uuid::Uuid::new_v4()));
        let root = quick_session_workspace_in(&base).expect("create quick-session workspace");

        assert!(root.is_dir());
        assert_eq!(
            root.file_name().and_then(|name| name.to_str()),
            Some("Quick Sessions")
        );
        assert!(root.starts_with(base.canonicalize().expect("canonical base directory")));

        std::fs::remove_dir_all(base).expect("remove quick-session test directory");
    }

    #[test]
    fn packaged_csp_allows_the_hosted_account_api() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let csp = config
            .pointer("/app/security/csp")
            .and_then(serde_json::Value::as_str)
            .expect("string CSP");
        let connect_src = csp
            .split(';')
            .find(|directive| directive.trim_start().starts_with("connect-src "))
            .expect("connect-src directive");

        assert!(
            connect_src
                .split_ascii_whitespace()
                .any(|source| source == "https://hormachuelos.vercel.app"),
            "the packaged webview must be allowed to start and poll browser sign-in"
        );
    }

    #[test]
    fn pasted_video_bytes_are_bounded_and_written_to_the_private_directory() {
        let path = write_paste_video_bytes(b"fake-video", "MP4", 1024)
            .expect("write a bounded pasted video");
        let path = std::path::PathBuf::from(path);
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("mp4"));
        assert_eq!(
            std::fs::read(&path).expect("read pasted video"),
            b"fake-video"
        );
        assert!(write_paste_video_bytes(b"", "mp4", 1024).is_err());
        assert!(write_paste_video_bytes(b"video", "exe", 1024).is_err());
        assert!(write_paste_video_bytes(b"1234", "mp4", 3)
            .expect_err("reject oversized raw video")
            .contains("too large"));
        std::fs::remove_file(path).expect("remove pasted-video fixture");
    }

    #[test]
    fn clipboard_video_import_filters_duplicates_and_reports_bad_files() {
        let fixture =
            std::env::temp_dir().join(format!("ai-forge-clipboard-video-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&fixture).expect("create clipboard fixture");
        let video = fixture.join("screen-recording.mp4");
        let image = fixture.join("screenshot.png");
        let missing = fixture.join("missing.webm");
        std::fs::write(&video, b"fake-mp4").expect("write video fixture");
        std::fs::write(&image, b"fake-png").expect("write image fixture");

        let result = import_clipboard_video_files(vec![video.clone(), video, image, missing]);
        assert_eq!(result.paths.len(), 1, "one unique video should import");
        assert_eq!(result.errors.len(), 1, "missing video should be reported");
        assert!(result.errors[0].contains("missing.webm"));
        let imported = std::path::PathBuf::from(&result.paths[0]);
        assert_eq!(
            std::fs::read(&imported).expect("read imported video"),
            b"fake-mp4"
        );
        assert!(imported.starts_with(std::env::temp_dir().join("hormachuelos-paste")));

        std::fs::remove_file(imported).expect("remove imported fixture");
        std::fs::remove_dir_all(fixture).expect("remove clipboard fixture");
    }
}
