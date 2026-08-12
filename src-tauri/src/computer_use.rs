//! Preview-only Computer Use broker.
//!
//! The model can observe and interact with the active Preview tab, but this
//! module never captures the desktop or sends native operating-system input.
//! The frontend owns the visible in-preview cursor and DOM/browser actions.

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const EMERGENCY_HOTKEY_ID: i32 = 0x41F0;
const MAX_ACTIONS: usize = 48;
const MAX_ARGUMENT_BYTES: usize = 128 * 1024;
const MAX_TEXT_CHARS: usize = 16_384;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(75);

static PAUSED: AtomicBool = AtomicBool::new(false);
static HOTKEY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<PreviewReply>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatus {
    pub supported: bool,
    pub paused: bool,
    pub emergency_shortcut: &'static str,
    pub emergency_shortcut_available: bool,
    pub scope: &'static str,
    pub auto_approved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewComputerRequest {
    request_id: String,
    protocol_version: u8,
    operation: &'static str,
    args: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct PreviewReply {
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<PreviewReply>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
    PAUSED.store(false, Ordering::SeqCst);
}

pub fn status() -> ComputerUseStatus {
    ComputerUseStatus {
        // Preview Computer Use is DOM/WebView based and is therefore available
        // anywhere the desktop preview runs, not just on Windows.
        supported: true,
        paused: is_paused(),
        emergency_shortcut: "Ctrl+Alt+Esc",
        emergency_shortcut_available: HOTKEY_AVAILABLE.load(Ordering::SeqCst),
        scope: "active-preview-tab-only",
        auto_approved: true,
    }
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::SeqCst);
    if paused {
        if let Some(app) = APP.get() {
            let _ = app.emit("preview-computer-stop", json!({ "reason": "paused" }));
        }
    }
}

fn validate_action(action: &Value, index: usize, text_chars: &mut usize) -> Result<()> {
    let object = action
        .as_object()
        .with_context(|| format!("Preview action {} must be an object.", index + 1))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .with_context(|| format!("Preview action {} is missing type.", index + 1))?;
    ensure!(
        matches!(
            kind,
            "move"
                | "hover"
                | "click"
                | "type"
                | "key"
                | "scroll"
                | "drag"
                | "set_value"
                | "check"
                | "wait"
                | "open_tab"
                | "navigate"
                | "activate_tab"
        ),
        "Unsupported preview action type: {kind}."
    );

    for key in ["ref", "selector"] {
        if let Some(value) = object.get(key) {
            let value = value
                .as_str()
                .with_context(|| format!("{key} must be a string."))?;
            ensure!(value.len() <= 512, "{key} is too long.");
        }
    }

    if kind == "type" {
        let text = object
            .get("text")
            .and_then(Value::as_str)
            .context("A type action requires text.")?;
        *text_chars = text_chars.saturating_add(text.chars().count());
        ensure!(
            *text_chars <= MAX_TEXT_CHARS,
            "Action batch text is too large."
        );
    }
    if kind == "set_value" {
        let value = object
            .get("value")
            .and_then(Value::as_str)
            .context("A set_value action requires value.")?;
        *text_chars = text_chars.saturating_add(value.chars().count());
        ensure!(
            *text_chars <= MAX_TEXT_CHARS,
            "Action batch text is too large."
        );
    }
    if kind == "check" {
        let expected = object
            .get("expect")
            .and_then(Value::as_object)
            .context("A check action requires a non-empty expect object.")?;
        ensure!(
            !expected.is_empty(),
            "A check action requires at least one expected state."
        );
        for (key, value) in expected {
            ensure!(
                matches!(
                    key.as_str(),
                    "visible" | "enabled" | "checked" | "text" | "value" | "url" | "title"
                ),
                "Unsupported Preview check field: {key}."
            );
            if matches!(key.as_str(), "visible" | "enabled" | "checked") {
                ensure!(value.is_boolean(), "Preview check {key} must be boolean.");
            } else {
                let text = value
                    .as_str()
                    .with_context(|| format!("Preview check {key} must be text."))?;
                ensure!(
                    text.chars().count() <= 2_048,
                    "Preview check {key} is too long."
                );
            }
        }
        if let Some(mode) = object.get("match").and_then(Value::as_str) {
            ensure!(
                matches!(mode, "contains" | "equals"),
                "Invalid Preview check match mode."
            );
        }
    }
    if kind == "key" {
        let keys = object
            .get("keys")
            .and_then(Value::as_str)
            .context("A key action requires keys.")?;
        ensure!(
            !keys.trim().is_empty() && keys.len() <= 96,
            "Invalid key chord."
        );
        ensure!(
            !keys.to_ascii_lowercase().contains("meta")
                && !keys.to_ascii_lowercase().contains("win"),
            "Win/Meta keys are outside Preview Computer Use."
        );
    }
    if let Some(duration) = object.get("duration_ms") {
        let duration = duration
            .as_u64()
            .context("Preview duration_ms must be a non-negative integer.")?;
        ensure!(
            duration <= 10_000,
            "One Preview action may not exceed 10 seconds."
        );
    }
    if matches!(kind, "open_tab" | "navigate") {
        let raw = object
            .get("url")
            .and_then(Value::as_str)
            .context("A Preview navigation action requires url.")?
            .trim();
        ensure!(
            !raw.is_empty() && raw.len() <= 4_096 && !raw.contains('\0'),
            "Invalid Preview navigation URL."
        );
        let url = tauri::Url::parse(raw).context("Invalid Preview navigation URL.")?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none(),
            "Preview navigation allows only credential-free http(s) URLs."
        );
    }
    if kind == "activate_tab" {
        let tab_id = object
            .get("tab_id")
            .and_then(Value::as_str)
            .context("activate_tab requires tab_id from computer_observe.")?;
        ensure!(
            tab_id.len() <= 128
                && (tab_id.starts_with("preview-tab-") || tab_id.starts_with("preview-browser-"))
                && tab_id
                    .bytes()
                    .all(|value| value.is_ascii_alphanumeric() || value == b'-'),
            "Invalid Preview tab id."
        );
    }
    Ok(())
}

fn validate_tool_request(name: &str, args: &Value) -> Result<&'static str> {
    let encoded = serde_json::to_vec(args)?;
    ensure!(
        encoded.len() <= MAX_ARGUMENT_BYTES,
        "Preview Computer Use request is too large."
    );
    match name {
        "computer_observe" => Ok("observe"),
        "computer_actions" => {
            let actions = args
                .get("actions")
                .and_then(Value::as_array)
                .context("computer_actions requires an actions array.")?;
            ensure!(
                !actions.is_empty(),
                "At least one preview action is required."
            );
            ensure!(
                actions.len() <= MAX_ACTIONS,
                "A preview action batch may contain at most {MAX_ACTIONS} actions."
            );
            let mut text_chars = 0usize;
            let mut tab_action_count = 0usize;
            for (index, action) in actions.iter().enumerate() {
                validate_action(action, index, &mut text_chars)?;
                if matches!(
                    action.get("type").and_then(Value::as_str),
                    Some("open_tab") | Some("navigate") | Some("activate_tab")
                ) {
                    tab_action_count += 1;
                }
            }
            ensure!(
                tab_action_count == 0 || (tab_action_count == 1 && actions.len() == 1),
                "Preview open_tab, navigate, and activate_tab must be the only action in their batch; observe the newly active tab next."
            );
            Ok("actions")
        }
        other => bail!("Unknown preview computer tool: {other}"),
    }
}

/// Execute a preview-only model tool by asking the visible frontend to operate
/// its currently active Preview tab. This blocking wait runs on the existing
/// tool worker thread; the WebView/UI thread remains responsive.
pub fn execute_tool(
    name: &str,
    args: &Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value> {
    ensure!(
        !is_paused(),
        "Preview Computer Use is paused. Resume it in Settings before continuing."
    );
    let operation = validate_tool_request(name, args)?;
    let app = APP
        .get()
        .context("Preview Computer Use is not initialized yet.")?;
    let request_id = format!(
        "preview-computer-{}-{}",
        std::process::id(),
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, rx) = mpsc::channel();
    pending()
        .lock()
        .map_err(|_| anyhow::anyhow!("Preview Computer Use response registry is unavailable."))?
        .insert(request_id.clone(), tx);

    let request = PreviewComputerRequest {
        request_id: request_id.clone(),
        protocol_version: 2,
        operation,
        args: args.clone(),
    };
    if let Err(error) = app.emit("preview-computer-request", &request) {
        let _ = pending().lock().map(|mut map| map.remove(&request_id));
        return Err(error).context("Could not send the action to the active Preview tab.");
    }

    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = pending().lock().map(|mut map| map.remove(&request_id));
            let _ = app.emit(
                "preview-computer-stop",
                json!({ "requestId": request_id, "reason": "cancelled" }),
            );
            bail!("Preview Computer Use was cancelled.");
        }
        if is_paused() {
            let _ = pending().lock().map(|mut map| map.remove(&request_id));
            bail!("Preview Computer Use was stopped by the emergency pause.");
        }
        if started.elapsed() >= RESPONSE_TIMEOUT {
            let _ = pending().lock().map(|mut map| map.remove(&request_id));
            let _ = app.emit(
                "preview-computer-stop",
                json!({ "requestId": request_id, "reason": "timeout" }),
            );
            bail!("The active Preview tab did not finish the action within 75 seconds.");
        }
        match rx.recv_timeout(Duration::from_millis(40)) {
            Ok(reply) if reply.ok => {
                return Ok(reply.result.unwrap_or_else(|| {
                    json!({
                        "ok": true,
                        "scope": "active-preview-tab-only"
                    })
                }));
            }
            Ok(reply) => {
                bail!(
                    "{}",
                    reply
                        .error
                        .unwrap_or_else(|| "The active Preview tab rejected the action.".into())
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("The Preview Computer Use response channel closed unexpectedly.");
            }
        }
    }
}

#[tauri::command]
pub fn respond_preview_computer(
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = pending()
        .lock()
        .map_err(|_| "Preview Computer Use response registry is unavailable.".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "Preview Computer Use request is no longer active.".to_string())?;
    sender
        .send(PreviewReply {
            ok,
            result,
            error: error.map(|value| value.chars().take(1_000).collect()),
        })
        .map_err(|_| "Preview Computer Use request already ended.".to_string())
}

#[cfg(windows)]
pub fn install_emergency_hotkey(app: AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_ESCAPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    std::thread::spawn(move || unsafe {
        let null_window = HWND(std::ptr::null_mut());
        let modifiers = MOD_ALT | MOD_CONTROL | MOD_NOREPEAT;
        if RegisterHotKey(
            null_window,
            EMERGENCY_HOTKEY_ID,
            modifiers,
            VK_ESCAPE.0 as u32,
        )
        .is_err()
        {
            log::warn!("Preview Computer Use emergency shortcut could not be registered.");
            return;
        }
        HOTKEY_AVAILABLE.store(true, Ordering::SeqCst);
        let _ = app.emit("computer-use-status", status());
        let mut message = MSG::default();
        while GetMessageW(&mut message, null_window, 0, 0).0 > 0 {
            if message.message == WM_HOTKEY && message.wParam.0 as i32 == EMERGENCY_HOTKEY_ID {
                set_paused(true);
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    state.stop_all_runs();
                }
                let _ = app.emit("computer-use-status", status());
            }
        }
        HOTKEY_AVAILABLE.store(false, Ordering::SeqCst);
    });
}

#[cfg(not(windows))]
pub fn install_emergency_hotkey(_app: AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{status, validate_tool_request, MAX_ACTIONS};
    use serde_json::json;

    #[test]
    fn exposes_only_preview_scope() {
        let value = status();
        assert!(value.supported);
        assert_eq!(value.scope, "active-preview-tab-only");
        assert!(value.auto_approved);
    }

    #[test]
    fn accepts_observe_and_bounded_batches() {
        assert_eq!(
            validate_tool_request("computer_observe", &json!({})).unwrap(),
            "observe"
        );
        assert_eq!(
            validate_tool_request(
                "computer_actions",
                &json!({ "actions": [
                    { "type": "hover", "ref": "p1" },
                    { "type": "click", "ref": "p1" },
                    { "type": "type", "text": "hello" }
                ] })
            )
            .unwrap(),
            "actions"
        );
    }

    #[test]
    fn accepts_preview_native_tab_navigation_only_as_a_single_action() {
        for action in [
            json!({ "type": "open_tab", "url": "http://localhost:3100/supervisor" }),
            json!({ "type": "navigate", "url": "https://example.com/path" }),
            json!({ "type": "activate_tab", "tab_id": "preview-browser-42" }),
        ] {
            assert_eq!(
                validate_tool_request("computer_actions", &json!({ "actions": [action] })).unwrap(),
                "actions"
            );
        }
        assert!(validate_tool_request(
            "computer_actions",
            &json!({ "actions": [
                { "type": "navigate", "url": "https://example.com" },
                { "type": "click", "ref": "p1" }
            ] })
        )
        .is_err());
        for unsafe_url in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "https://user:secret@example.com",
        ] {
            assert!(validate_tool_request(
                "computer_actions",
                &json!({ "actions": [{ "type": "open_tab", "url": unsafe_url }] })
            )
            .is_err());
        }
    }

    #[test]
    fn accepts_native_form_values_and_evidence_checks() {
        assert!(validate_tool_request(
            "computer_actions",
            &json!({ "actions": [
                { "type": "set_value", "ref": "p1", "value": "2026-08-12" },
                { "type": "check", "ref": "p1", "match": "equals", "expect": {
                    "visible": true,
                    "enabled": true,
                    "value": "2026-08-12"
                }}
            ] })
        )
        .is_ok());
        assert!(validate_tool_request(
            "computer_actions",
            &json!({ "actions": [{ "type": "set_value", "ref": "p1" }] })
        )
        .is_err());
        assert!(validate_tool_request(
            "computer_actions",
            &json!({ "actions": [{ "type": "check", "ref": "p1", "expect": {} }] })
        )
        .is_err());
    }

    #[test]
    fn rejects_desktop_and_unbounded_requests() {
        assert!(validate_tool_request("computer_desktop_legacy", &json!({})).is_err());
        let actions = (0..=MAX_ACTIONS)
            .map(|_| json!({ "type": "wait", "duration_ms": 0 }))
            .collect::<Vec<_>>();
        assert!(validate_tool_request("computer_actions", &json!({ "actions": actions })).is_err());
        assert!(validate_tool_request(
            "computer_actions",
            &json!({ "actions": [{ "type": "key", "keys": "Win+R" }] })
        )
        .is_err());
    }
}
