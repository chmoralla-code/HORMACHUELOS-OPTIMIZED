//! Native Windows Desktop Computer Use broker.
//!
//! Separate from Preview Computer Use. The agent never receives raw Win32
//! handles without a short-lived observation token. Mutating actions require a
//! fresh token, forcing observe -> one action -> observe. There is no overlay
//! FX path: cursor motion uses Win32 only so the FPS profile stays intact.

use anyhow::{bail, ensure, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const HELPER_FLAG: &str = "--desktop-computer-use-helper";
const SESSION_ENV: &str = "HORMACHUELOS_OPTIMIZED_DESKTOP_CU_SESSION";
const PAUSE_SENTINEL_ENV: &str = "HORMACHUELOS_OPTIMIZED_DESKTOP_CU_PAUSE";
const MAX_ALLOWED_APPS: usize = 32;
const MAX_ALLOWED_APP_CHARS: usize = 128;
const OBSERVATION_TTL_MS: u64 = 45_000;
const MAX_CAPTURE_PIXELS: u64 = 16_000_000;
const MAX_TYPE_UTF16_UNITS: usize = 512;
const MAX_GAME_SEQUENCE_STEPS: usize = 128;
const MAX_GAME_STEP_DELAY_MS: u64 = 5_000;
const MAX_GAME_SEQUENCE_DELAY_MS: u64 = 30_000;

static PAUSED: AtomicBool = AtomicBool::new(false);
static HOTKEY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static LOCAL_SESSION_SECRET: OnceLock<String> = OnceLock::new();
static ALLOWED_APPS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatus {
    pub supported: bool,
    pub paused: bool,
    pub emergency_shortcut: &'static str,
    pub emergency_shortcut_available: bool,
}

#[derive(Debug, Deserialize)]
struct HelperRequest {
    action: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
struct HelperResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ObservationClaims {
    window_id: String,
    process_id: u32,
    process_name: String,
    title: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    issued_ms: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GameControlStep {
    keys: String,
    delay_ms: u64,
}

pub fn status() -> ComputerUseStatus {
    ComputerUseStatus {
        supported: cfg!(windows),
        paused: is_paused(),
        emergency_shortcut: "Ctrl+Alt+Esc",
        emergency_shortcut_available: HOTKEY_AVAILABLE.load(Ordering::SeqCst),
    }
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst) || pause_sentinel_exists() || crate::computer_use::is_paused()
}

pub fn set_paused(paused: bool) {
    if paused {
        PAUSED.store(true, Ordering::SeqCst);
        if let Err(error) = create_pause_sentinel() {
            log::error!("Could not publish the Desktop Computer Use pause state: {error}");
        }
    } else if let Err(error) = clear_pause_sentinel() {
        // Resume fails closed: the UI and helper must agree before input resumes.
        PAUSED.store(true, Ordering::SeqCst);
        log::error!("Could not clear the Desktop Computer Use pause state: {error}");
    } else {
        PAUSED.store(false, Ordering::SeqCst);
    }
}

fn allowed_apps_lock() -> &'static Mutex<Vec<String>> {
    ALLOWED_APPS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Keep only safe executable names. Password managers and other protected
/// processes can never be allowlisted, even if a user pins them.
pub fn sanitize_allowed_apps(apps: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let mut cleaned = Vec::new();
    for app in apps {
        let name = app
            .as_ref()
            .trim()
            .trim_matches(['"', '\'', '\\', '/'])
            .to_ascii_lowercase();
        let name = name.rsplit(['\\', '/']).next().unwrap_or(&name).to_string();
        if name.is_empty()
            || name.len() > MAX_ALLOWED_APP_CHARS
            || !name.ends_with(".exe")
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            continue;
        }
        if classify_blocked("", &name).is_some() {
            continue;
        }
        if !cleaned.iter().any(|existing| existing == &name) {
            cleaned.push(name);
        }
        if cleaned.len() >= MAX_ALLOWED_APPS {
            break;
        }
    }
    cleaned
}

pub fn set_allowed_apps(apps: impl IntoIterator<Item = impl AsRef<str>>) {
    let cleaned = sanitize_allowed_apps(apps);
    if let Ok(mut guard) = allowed_apps_lock().lock() {
        *guard = cleaned;
    }
}

fn process_is_allowed(process: &str) -> bool {
    let Ok(guard) = allowed_apps_lock().lock() else {
        return false;
    };
    if guard.is_empty() {
        return true;
    }
    guard.iter().any(|name| name.eq_ignore_ascii_case(process))
}

fn classify_blocked(title: &str, process: &str) -> Option<&'static str> {
    let process = process.to_ascii_lowercase();
    if matches!(
        process.as_str(),
        "ai-forge.exe"
            | "hormachuelos.exe"
            | "hormachuelos-optimized.exe"
            | "windowsterminal.exe"
            | "wt.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "cmd.exe"
            | "conhost.exe"
            | "codex.exe"
            | "chatgpt.exe"
            | "credentialui.exe"
            | "sechealthui.exe"
            | "securityhealthservice.exe"
            | "securityhealthsystray.exe"
            | "1password.exe"
            | "bitwarden.exe"
            | "keepass.exe"
            | "keepassxc.exe"
            | "dashlane.exe"
            | "lastpass.exe"
    ) {
        return Some(
            if process.contains("hormachuelos") || process == "ai-forge.exe" {
                "Cannot control the Hormachuelos app itself."
            } else {
                "This application is protected from Computer Use."
            },
        );
    }
    let title = title.trim().to_ascii_lowercase();
    if title.is_empty() {
        return None;
    }
    if title == "run"
        || title.contains("windows security")
        || title.contains("privacy & security")
        || title.contains("authentication")
        || title.contains("credential")
        || title.contains("password manager")
        || title.contains("1password")
        || title.contains("bitwarden")
        || title.contains("keepass")
        || title.contains("dashlane")
        || title.contains("lastpass")
        || title == "chatgpt"
        || title.starts_with("chatgpt ")
        || title.ends_with(" - chatgpt")
        || title == "codex"
        || title.starts_with("codex ")
        || title.ends_with(" - codex")
    {
        return Some("This window is protected from Computer Use.");
    }
    None
}

pub fn is_desktop_computer_tool(name: &str) -> bool {
    matches!(
        name,
        "computer_list_windows"
            | "computer_observe_window"
            | "computer_focus_window"
            | "computer_click"
            | "computer_type_text"
            | "computer_press_key"
            | "computer_scroll"
            | "computer_drag"
            | "computer_game_sequence"
    )
}

fn pause_sentinel_path() -> PathBuf {
    if let Some(path) = std::env::var_os(PAUSE_SENTINEL_ENV).filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Hormachuelos Optimized")
        .join("DesktopComputerUse")
        .join("paused")
}

fn initialize_pause_guard() {
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let path = base
        .join("Hormachuelos Optimized")
        .join("DesktopComputerUse")
        .join(format!("paused-{}", std::process::id()));
    std::env::set_var(PAUSE_SENTINEL_ENV, &path);
    set_paused(false);
}

fn pause_sentinel_exists() -> bool {
    // Metadata errors fail closed because the helper cannot prove that resume
    // was successfully published by the GUI process.
    pause_sentinel_path().try_exists().unwrap_or(true)
}

fn create_pause_sentinel() -> Result<()> {
    let path = pause_sentinel_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    writeln!(file, "paused by process {}", std::process::id())?;
    file.sync_all()?;
    Ok(())
}

fn clear_pause_sentinel() -> Result<()> {
    match std::fs::remove_file(pause_sentinel_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_not_paused() -> Result<()> {
    ensure!(
        !is_paused(),
        "Computer Use is paused. Resume it from the Preview sandwich menu before continuing."
    );
    Ok(())
}

fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("System clock is before the Unix epoch")?
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX))
}

fn session_secret() -> Result<String> {
    if let Ok(secret) = std::env::var(SESSION_ENV) {
        let secret = secret.trim();
        ensure!(
            secret.len() >= 16,
            "Computer Use helper session is invalid."
        );
        return Ok(secret.to_string());
    }
    Ok(LOCAL_SESSION_SECRET
        .get_or_init(|| uuid::Uuid::new_v4().to_string())
        .clone())
}

fn sign_observation(claims: &ObservationClaims) -> Result<String> {
    let payload = serde_json::to_vec(claims)?;
    let payload_encoded = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = Hmac::<Sha256>::new_from_slice(session_secret()?.as_bytes())
        .context("Could not initialize observation signer")?;
    mac.update(payload_encoded.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{payload_encoded}.{signature}"))
}

fn verify_observation(token: &str, expected_window_id: &str) -> Result<ObservationClaims> {
    let (payload_encoded, signature_encoded) = token
        .split_once('.')
        .context("Observation token is malformed; observe the window again.")?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_encoded)
        .context("Observation signature is malformed.")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(session_secret()?.as_bytes())
        .context("Could not initialize observation verifier")?;
    mac.update(payload_encoded.as_bytes());
    mac.verify_slice(&signature)
        .context("Observation token is invalid; observe the window again.")?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_encoded)
        .context("Observation payload is malformed.")?;
    let claims: ObservationClaims = serde_json::from_slice(&payload)?;
    ensure!(
        claims.window_id == expected_window_id,
        "Observation belongs to a different window."
    );
    let current_ms = now_ms()?;
    ensure!(
        claims.issued_ms <= current_ms.saturating_add(5_000),
        "Observation timestamp is invalid; observe the window again."
    );
    let age = current_ms.saturating_sub(claims.issued_ms);
    ensure!(
        age <= OBSERVATION_TTL_MS,
        "Observation expired; observe the window again."
    );
    Ok(claims)
}

fn arg_str<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("Missing {name}."))
}

fn arg_i32(args: &Value, name: &str) -> Result<i32> {
    let raw = args
        .get(name)
        .and_then(Value::as_i64)
        .with_context(|| format!("Missing {name}."))?;
    raw.try_into()
        .with_context(|| format!("{name} is outside the supported range."))
}

fn optional_arg_i32(args: &Value, name: &str) -> Result<Option<i32>> {
    args.get(name)
        .map(|value| {
            value
                .as_i64()
                .with_context(|| format!("{name} must be an integer."))?
                .try_into()
                .with_context(|| format!("{name} is outside the supported range."))
        })
        .transpose()
}

fn normalized_game_key(keys: &str) -> Option<&'static str> {
    match keys.trim().to_ascii_uppercase().replace(' ', "").as_str() {
        "UP" | "ARROWUP" => Some("ARROWUP"),
        "DOWN" | "ARROWDOWN" => Some("ARROWDOWN"),
        "LEFT" | "ARROWLEFT" => Some("ARROWLEFT"),
        "RIGHT" | "ARROWRIGHT" => Some("ARROWRIGHT"),
        "W" => Some("W"),
        "A" => Some("A"),
        "S" => Some("S"),
        "D" => Some("D"),
        "SPACE" => Some("SPACE"),
        _ => None,
    }
}

fn parse_game_steps(args: &Value) -> Result<Vec<GameControlStep>> {
    let steps_value = args.get("steps").context("Missing steps.")?.clone();
    let steps: Vec<GameControlStep> =
        serde_json::from_value(steps_value).context("Game control steps are invalid.")?;
    ensure!(
        !steps.is_empty() && steps.len() <= MAX_GAME_SEQUENCE_STEPS,
        "Game control sequence must contain 1 to {MAX_GAME_SEQUENCE_STEPS} steps."
    );
    let mut total_delay_ms = 0u64;
    for step in &steps {
        ensure!(
            normalized_game_key(&step.keys).is_some(),
            "Game sequences only allow Arrow keys, W/A/S/D, and Space."
        );
        ensure!(
            step.delay_ms <= MAX_GAME_STEP_DELAY_MS,
            "Each game step delay must be at most {MAX_GAME_STEP_DELAY_MS} ms."
        );
        total_delay_ms = total_delay_ms
            .checked_add(step.delay_ms)
            .context("Game control delay overflow.")?;
    }
    ensure!(
        total_delay_ms <= MAX_GAME_SEQUENCE_DELAY_MS,
        "Game control sequence may run for at most {MAX_GAME_SEQUENCE_DELAY_MS} ms."
    );
    Ok(steps)
}

fn execute_request(request: HelperRequest) -> Result<Value> {
    ensure_not_paused()?;
    match request.action.as_str() {
        "list_windows" => platform::list_windows_json(),
        "observe" => platform::observe_window(arg_str(&request.args, "window_id")?),
        "focus" => platform::focus_window_json(arg_str(&request.args, "window_id")?),
        "click" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            let x = arg_i32(&request.args, "x")?;
            let y = arg_i32(&request.args, "y")?;
            let button = request
                .args
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left");
            let clicks = request
                .args
                .get("clicks")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 2) as u32;
            platform::click(&claims, x, y, button, clicks)
        }
        "type_text" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            platform::type_text(&claims, arg_str(&request.args, "text")?)
        }
        "press_key" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            platform::press_key(&claims, arg_str(&request.args, "keys")?)
        }
        "scroll" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            platform::scroll(
                &claims,
                arg_i32(&request.args, "x")?,
                arg_i32(&request.args, "y")?,
                arg_i32(&request.args, "delta_y")?,
            )
        }
        "drag" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            platform::drag(
                &claims,
                arg_i32(&request.args, "start_x")?,
                arg_i32(&request.args, "start_y")?,
                arg_i32(&request.args, "end_x")?,
                arg_i32(&request.args, "end_y")?,
            )
        }
        "game_sequence" => {
            let window_id = arg_str(&request.args, "window_id")?;
            let claims =
                verify_observation(arg_str(&request.args, "observation_token")?, window_id)?;
            let focus_x = optional_arg_i32(&request.args, "focus_x")?;
            let focus_y = optional_arg_i32(&request.args, "focus_y")?;
            ensure!(
                focus_x.is_some() == focus_y.is_some(),
                "focus_x and focus_y must be provided together."
            );
            platform::game_sequence(
                &claims,
                focus_x.zip(focus_y),
                &parse_game_steps(&request.args)?,
            )
        }
        _ => bail!("Unknown Computer Use action."),
    }
}

/// Execute a native `computer_*` tool through the in-process broker.
pub fn execute_tool(name: &str, args: &Value) -> Result<Value> {
    let action = match name {
        "computer_list_windows" => "list_windows",
        "computer_observe_window" => "observe",
        "computer_focus_window" => "focus",
        "computer_click" => "click",
        "computer_type_text" => "type_text",
        "computer_press_key" => "press_key",
        "computer_scroll" => "scroll",
        "computer_drag" => "drag",
        "computer_game_sequence" => "game_sequence",
        other => bail!("Unknown computer tool: {other}"),
    };
    execute_request(HelperRequest {
        action: action.to_string(),
        args: args.clone(),
    })
}

/// List ordinary windows for the Settings picker. Hard-blocked apps stay hidden.
pub fn list_targets() -> Result<Value> {
    platform::list_candidate_windows_json()
}

/// Handle the private helper subprocess invocation before Tauri initializes.
pub fn run_helper_if_requested() -> bool {
    if std::env::args().nth(1).as_deref() != Some(HELPER_FLAG) {
        return false;
    }
    let response = (|| -> Result<Value> {
        ensure!(
            std::env::var(SESSION_ENV)
                .map(|value| value.trim().len() >= 16)
                .unwrap_or(false),
            "Computer Use helper may only be called by an active Hormachuelos Optimized session."
        );
        let mut input = String::new();
        std::io::stdin()
            .take(64 * 1024 + 1)
            .read_to_string(&mut input)?;
        ensure!(
            input.len() <= 64 * 1024,
            "Computer Use request is too large."
        );
        let request: HelperRequest = serde_json::from_str(&input)?;
        execute_request(request)
    })();
    let envelope = match response {
        Ok(result) => HelperResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => HelperResponse {
            ok: false,
            result: None,
            error: Some(error.to_string()),
        },
    };
    let serialized = serde_json::to_string(&envelope).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"Could not serialize helper response."}"#.to_string()
    });
    // The parent may close its pipe during cancellation; that is a normal
    // helper shutdown path and must not panic the GUI-subsystem executable.
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let _ = writeln!(output, "{serialized}");
    true
}

/// Preview Computer Use already owns Ctrl+Alt+Esc. Desktop mode shares that
/// pause latch instead of registering a second hotkey.
#[cfg(windows)]
pub fn install(app: tauri::AppHandle) {
    let _ = app;
    initialize_pause_guard();
    HOTKEY_AVAILABLE.store(
        crate::computer_use::status().emergency_shortcut_available,
        Ordering::SeqCst,
    );
}

#[cfg(not(windows))]
pub fn install(_app: tauri::AppHandle) {
    initialize_pause_guard();
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetCursorPos,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WindowInfo {
        id: String,
        title: String,
        process_name: String,
        process_id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        is_foreground: bool,
        is_minimized: bool,
    }

    fn hwnd_from_id(id: &str) -> Result<HWND> {
        let raw: usize = id.parse().context("Window id is invalid.")?;
        ensure!(raw != 0, "Window id is invalid.");
        Ok(HWND(raw as *mut c_void))
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buffer = vec![0u16; 32_768];
            let mut length = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(handle);
            if result.is_err() {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(path)
        }
    }

    unsafe fn window_info(hwnd: HWND) -> Option<WindowInfo> {
        window_info_filtered(hwnd, true)
    }

    unsafe fn window_info_filtered(hwnd: HWND, apply_allowlist: bool) -> Option<WindowInfo> {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return None;
        }
        let mut title_buffer = vec![0u16; title_len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title_buffer);
        if copied <= 0 {
            return None;
        }
        let title = String::from_utf16_lossy(&title_buffer[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width < 80 || height < 60 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return None;
        }
        let process = process_name(pid);
        if classify_blocked(&title, &process).is_some() {
            return None;
        }
        if apply_allowlist && !process_is_allowed(&process) {
            return None;
        }
        Some(WindowInfo {
            id: (hwnd.0 as usize).to_string(),
            title,
            process_name: process,
            process_id: pid,
            x: rect.left,
            y: rect.top,
            width,
            height,
            is_foreground: GetForegroundWindow() == hwnd,
            is_minimized: IsIconic(hwnd).as_bool(),
        })
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        if let Some(info) = window_info(hwnd) {
            windows.push(info);
        }
        true.into()
    }

    unsafe extern "system" fn enum_candidate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        if let Some(info) = window_info_filtered(hwnd, false) {
            windows.push(info);
        }
        true.into()
    }

    fn list_windows() -> Result<Vec<WindowInfo>> {
        enumerate_windows(enum_callback)
    }

    fn list_candidate_windows() -> Result<Vec<WindowInfo>> {
        enumerate_windows(enum_candidate_callback)
    }

    fn enumerate_windows(
        callback: unsafe extern "system" fn(HWND, LPARAM) -> BOOL,
    ) -> Result<Vec<WindowInfo>> {
        let mut windows: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(
                Some(callback),
                LPARAM((&mut windows as *mut Vec<WindowInfo>) as isize),
            )?;
        }
        windows.sort_by(|a, b| {
            b.is_foreground.cmp(&a.is_foreground).then_with(|| {
                a.title
                    .to_ascii_lowercase()
                    .cmp(&b.title.to_ascii_lowercase())
            })
        });
        windows.truncate(80);
        Ok(windows)
    }

    fn safe_window(window_id: &str) -> Result<(HWND, WindowInfo)> {
        let hwnd = hwnd_from_id(window_id)?;
        let info = unsafe { window_info(hwnd) }
            .context("Window is unavailable or protected; list windows again.")?;
        ensure!(
            classify_blocked(&info.title, &info.process_name).is_none(),
            "This window is protected from Computer Use."
        );
        Ok((hwnd, info))
    }

    fn snapshot_matches(claims: &ObservationClaims, info: &WindowInfo) -> bool {
        claims.process_id == info.process_id
            && claims.process_name.eq_ignore_ascii_case(&info.process_name)
            && claims.title == info.title
            && (claims.x - info.x).abs() <= 2
            && (claims.y - info.y).abs() <= 2
            && (claims.width - info.width).abs() <= 2
            && (claims.height - info.height).abs() <= 2
    }

    fn focus_window_fast(claims: &ObservationClaims) -> Result<(HWND, WindowInfo)> {
        ensure_not_paused()?;
        let (hwnd, info) = safe_window(&claims.window_id)?;
        ensure!(
            snapshot_matches(claims, &info),
            "The target window changed since it was observed; observe it again."
        );
        if info.is_minimized {
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
        }
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(4));
        let (_, refreshed) = safe_window(&claims.window_id)?;
        ensure_not_paused()?;
        Ok((hwnd, refreshed))
    }

    fn point_in_window(info: &WindowInfo, x: i32, y: i32) -> Result<(i32, i32)> {
        ensure!(
            x >= 0 && y >= 0 && x < info.width && y < info.height,
            "Coordinates are outside the observed window."
        );
        Ok((info.x + x, info.y + y))
    }

    fn send_inputs(inputs: &[INPUT]) -> Result<()> {
        let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
        ensure!(
            sent == inputs.len() as u32,
            "Windows rejected the input event."
        );
        Ok(())
    }

    fn mouse_input(
        flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
        data: u32,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    mouseData: data,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }
    }

    fn key_input(
        vk: u16,
        scan: u16,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }
    }

    fn capture_window_png(hwnd: HWND, info: &WindowInfo) -> Result<Vec<u8>> {
        let width = info.width;
        let height = info.height;
        ensure!(
            width > 0
                && height > 0
                && (width as u64).saturating_mul(height as u64) <= MAX_CAPTURE_PIXELS,
            "Window is too large to capture safely."
        );
        ensure_not_paused()?;
        ensure!(
            !info.is_minimized,
            "Focus the minimized window before observing it."
        );

        let source_dc = unsafe { GetDC(hwnd) };
        ensure!(
            !source_dc.0.is_null(),
            "Could not access the window surface."
        );
        let memory_dc = unsafe { CreateCompatibleDC(source_dc) };
        if memory_dc.0.is_null() {
            unsafe {
                let _ = ReleaseDC(hwnd, source_dc);
            }
            bail!("Could not create capture surface.");
        }
        let bitmap = unsafe { CreateCompatibleBitmap(source_dc, width, height) };
        if bitmap.0.is_null() {
            unsafe {
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(hwnd, source_dc);
            }
            bail!("Could not create capture bitmap.");
        }
        let old_object = unsafe { SelectObject(memory_dc, HGDIOBJ(bitmap.0)) };
        if old_object.0.is_null() || old_object.0 as isize == -1 {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(hwnd, source_dc);
            }
            bail!("Could not select the capture bitmap.");
        }

        let result = (|| -> Result<Vec<u8>> {
            // Never fall back to copying the desktop. An overlapping protected
            // window could otherwise leak into the requested observation.
            let printed = unsafe {
                PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(2)).as_bool()
                    || PrintWindow(hwnd, memory_dc, PRINT_WINDOW_FLAGS(0)).as_bool()
            };
            ensure!(printed, "Windows could not securely capture this window.");

            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let byte_len = (width as usize)
                .checked_mul(height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .context("Capture size overflow.")?;
            let mut bgra = vec![0u8; byte_len];
            let rows = unsafe {
                GetDIBits(
                    memory_dc,
                    bitmap,
                    0,
                    height as u32,
                    Some(bgra.as_mut_ptr().cast()),
                    &mut bitmap_info,
                    DIB_RGB_COLORS,
                )
            };
            ensure!(rows == height, "Could not read captured pixels.");
            for pixel in bgra.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 255;
            }

            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header()?;
                writer.write_image_data(&bgra)?;
            }
            Ok(png_bytes)
        })();

        unsafe {
            let _ = SelectObject(memory_dc, old_object);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(hwnd, source_dc);
        }
        result
    }

    pub(super) fn list_windows_json() -> Result<Value> {
        Ok(json!({
            "windows": list_windows()?,
            "safety": "Terminal, authentication, password-manager, security, ChatGPT, Codex, and Hormachuelos windows are excluded. Windows Settings is allowed."
        }))
    }

    pub(super) fn list_candidate_windows_json() -> Result<Value> {
        Ok(json!({
            "windows": list_candidate_windows()?,
            "safety": "Protected terminals, authentication, password managers, security, ChatGPT, Codex, and Hormachuelos windows are excluded."
        }))
    }

    pub(super) fn focus_window_json(window_id: &str) -> Result<Value> {
        let (hwnd, _) = safe_window(window_id)?;
        ensure_not_paused()?;
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            ensure!(
                SetForegroundWindow(hwnd).as_bool(),
                "Windows refused to focus the target window."
            );
        }
        thread::sleep(Duration::from_millis(4));
        ensure!(
            unsafe { GetForegroundWindow() } == hwnd,
            "Target window did not stay focused."
        );
        let (_, info) = safe_window(window_id)?;
        Ok(json!({ "focused": true, "window": info }))
    }

    pub(super) fn observe_window(window_id: &str) -> Result<Value> {
        let (hwnd, info) = safe_window(window_id)?;
        let png = capture_window_png(hwnd, &info)?;
        let claims = ObservationClaims {
            window_id: info.id.clone(),
            process_id: info.process_id,
            process_name: info.process_name.clone(),
            title: info.title.clone(),
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
            issued_ms: now_ms()?,
        };
        Ok(json!({
            "window": info,
            "observation_token": sign_observation(&claims)?,
            "expires_in_ms": OBSERVATION_TTL_MS,
            "mime_type": "image/png",
            "image_base64": STANDARD.encode(png),
            "instruction": "Use this token for exactly one action, then observe again."
        }))
    }

    fn cursor_pos() -> Result<(i32, i32)> {
        unsafe {
            let mut point = POINT { x: 0, y: 0 };
            GetCursorPos(&mut point)?;
            Ok((point.x, point.y))
        }
    }

    fn animate_cursor_to(to_x: i32, to_y: i32) {
        let Ok((from_x, from_y)) = cursor_pos() else {
            let _ = unsafe { SetCursorPos(to_x, to_y) };
            return;
        };
        let dx = to_x - from_x;
        let dy = to_y - from_y;
        let distance = ((dx * dx + dy * dy) as f64).sqrt();
        if distance < 6.0 {
            let _ = unsafe { SetCursorPos(to_x, to_y) };
            return;
        }
        let steps = ((distance / 14.0).ceil() as i32).clamp(2, 22);
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            let x = from_x + ((dx as f64) * t).round() as i32;
            let y = from_y + ((dy as f64) * t).round() as i32;
            let _ = unsafe { SetCursorPos(x, y) };
            if step < steps {
                thread::sleep(Duration::from_millis(3));
            }
        }
    }

    fn typing_fx_delay(total_chars: u32) {
        if total_chars <= 64 {
            thread::sleep(Duration::from_millis(14));
        } else if total_chars <= 180 {
            thread::sleep(Duration::from_millis(6));
        } else if total_chars <= 360 {
            thread::sleep(Duration::from_millis(2));
        }
    }

    pub(super) fn click(
        claims: &ObservationClaims,
        x: i32,
        y: i32,
        button: &str,
        clicks: u32,
    ) -> Result<Value> {
        let (_, info) = focus_window_fast(claims)?;
        let (screen_x, screen_y) = point_in_window(&info, x, y)?;
        animate_cursor_to(screen_x, screen_y);
        unsafe { SetCursorPos(screen_x, screen_y)? };
        ensure_not_paused()?;
        let (down, up) = match button.to_ascii_lowercase().as_str() {
            "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => bail!("Mouse button must be left, right, or middle."),
        };
        for index in 0..clicks {
            ensure_not_paused()?;
            send_inputs(&[mouse_input(down, 0), mouse_input(up, 0)])?;
            if index + 1 < clicks {
                thread::sleep(Duration::from_millis(12));
            }
        }
        Ok(json!({
            "acted": true,
            "action": "click",
            "window_id": claims.window_id,
            "x": x,
            "y": y,
            "button": button,
            "clicks": clicks,
            "next": "Continue acting or observe again if the UI changed."
        }))
    }

    pub(super) fn type_text(claims: &ObservationClaims, text: &str) -> Result<Value> {
        ensure!(!text.is_empty(), "Text cannot be empty.");
        ensure!(
            !text.chars().any(char::is_control),
            "Use computer_press_key for Enter, Tab, Escape, and other control keys."
        );
        let units: Vec<u16> = text.encode_utf16().collect();
        ensure!(
            units.len() <= MAX_TYPE_UTF16_UNITS,
            "Text is too long for one Computer Use action."
        );
        focus_window_fast(claims)?;
        let (_, info) = safe_window(&claims.window_id)?;
        let (screen_x, screen_y) = point_in_window(&info, info.width / 2, (info.height * 2) / 3)?;
        animate_cursor_to(screen_x, screen_y);
        let chars: Vec<char> = text.chars().collect();
        let total = chars.len() as u32;
        for ch in chars {
            let mut encoded = [0u16; 2];
            let units = ch.encode_utf16(&mut encoded);
            for unit in units {
                ensure_not_paused()?;
                send_inputs(&[
                    key_input(0, *unit, KEYEVENTF_UNICODE),
                    key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                ])?;
            }
            typing_fx_delay(total);
        }
        Ok(json!({
            "acted": true,
            "action": "type_text",
            "window_id": claims.window_id,
            "characters": text.chars().count(),
            "next": "Continue acting or observe again if the UI changed."
        }))
    }

    fn key_code(name: &str) -> Option<u16> {
        match name {
            "BACKSPACE" => Some(0x08),
            "TAB" => Some(0x09),
            "ENTER" | "RETURN" => Some(0x0D),
            "ESC" | "ESCAPE" => Some(0x1B),
            "SPACE" => Some(0x20),
            "PAGEUP" => Some(0x21),
            "PAGEDOWN" => Some(0x22),
            "END" => Some(0x23),
            "HOME" => Some(0x24),
            "LEFT" | "ARROWLEFT" => Some(0x25),
            "UP" | "ARROWUP" => Some(0x26),
            "RIGHT" | "ARROWRIGHT" => Some(0x27),
            "DOWN" | "ARROWDOWN" => Some(0x28),
            "DELETE" => Some(0x2E),
            value if value.len() == 1 => {
                let byte = value.as_bytes()[0];
                if byte.is_ascii_alphanumeric() {
                    Some(byte.to_ascii_uppercase() as u16)
                } else {
                    None
                }
            }
            value if value.starts_with('F') => value[1..]
                .parse::<u16>()
                .ok()
                .filter(|number| (1..=12).contains(number))
                .map(|number| 0x6F + number),
            _ => None,
        }
    }

    pub(super) fn press_key(claims: &ObservationClaims, keys: &str) -> Result<Value> {
        let normalized = keys.trim().to_ascii_uppercase().replace(' ', "");
        let parts: Vec<&str> = normalized
            .split('+')
            .filter(|part| !part.is_empty())
            .collect();
        ensure!(!parts.is_empty() && parts.len() <= 4, "Invalid key chord.");
        let mut modifiers = Vec::new();
        let mut main_key = None;
        for part in parts {
            let modifier = match part {
                "CTRL" | "CONTROL" => Some(0x11),
                "ALT" => Some(0x12),
                "SHIFT" => Some(0x10),
                _ => None,
            };
            if let Some(vk) = modifier {
                ensure!(!modifiers.contains(&vk), "Duplicate key modifier.");
                modifiers.push(vk);
            } else {
                ensure!(main_key.is_none(), "Only one non-modifier key is allowed.");
                main_key = key_code(part);
                ensure!(main_key.is_some(), "Unsupported key name.");
            }
        }
        let main_key = main_key.context("A non-modifier key is required.")?;
        focus_window_fast(claims)?;
        let (_, info) = safe_window(&claims.window_id)?;
        let (screen_x, screen_y) = point_in_window(&info, info.width / 2, info.height / 2)?;
        animate_cursor_to(screen_x, screen_y);
        let mut inputs = Vec::new();
        for vk in &modifiers {
            inputs.push(key_input(*vk, 0, Default::default()));
        }
        inputs.push(key_input(main_key, 0, Default::default()));
        inputs.push(key_input(main_key, 0, KEYEVENTF_KEYUP));
        for vk in modifiers.iter().rev() {
            inputs.push(key_input(*vk, 0, KEYEVENTF_KEYUP));
        }
        ensure_not_paused()?;
        send_inputs(&inputs)?;
        Ok(json!({
            "acted": true,
            "action": "press_key",
            "window_id": claims.window_id,
            "keys": normalized,
            "next": "Continue acting or observe again if the UI changed."
        }))
    }

    pub(super) fn game_sequence(
        claims: &ObservationClaims,
        focus_point: Option<(i32, i32)>,
        steps: &[GameControlStep],
    ) -> Result<Value> {
        let (_, info) = focus_window_fast(claims)?;
        if let Some((x, y)) = focus_point {
            let (screen_x, screen_y) = point_in_window(&info, x, y)?;
            unsafe { SetCursorPos(screen_x, screen_y)? };
            ensure_not_paused()?;
            send_inputs(&[
                mouse_input(MOUSEEVENTF_LEFTDOWN, 0),
                mouse_input(MOUSEEVENTF_LEFTUP, 0),
            ])?;
        }

        let started = std::time::Instant::now();
        for step in steps {
            ensure_not_paused()?;
            let key = normalized_game_key(&step.keys)
                .context("Unsupported game key in validated sequence.")?;
            let vk = key_code(key).context("Unsupported game key.")?;
            send_inputs(&[
                key_input(vk, 0, Default::default()),
                key_input(vk, 0, KEYEVENTF_KEYUP),
            ])?;

            let mut remaining = step.delay_ms;
            while remaining > 0 {
                ensure_not_paused()?;
                let slice = remaining.min(20);
                thread::sleep(Duration::from_millis(slice));
                remaining -= slice;
            }
        }

        Ok(json!({
            "acted": true,
            "action": "game_sequence",
            "window_id": claims.window_id,
            "steps_executed": steps.len(),
            "elapsed_ms": started.elapsed().as_millis(),
            "next": "Observe the game again before the next control sequence."
        }))
    }

    pub(super) fn scroll(
        claims: &ObservationClaims,
        x: i32,
        y: i32,
        delta_y: i32,
    ) -> Result<Value> {
        ensure!(
            (-2_400..=2_400).contains(&delta_y) && delta_y != 0,
            "Scroll delta must be between -2400 and 2400."
        );
        let (_, info) = focus_window_fast(claims)?;
        let (screen_x, screen_y) = point_in_window(&info, x, y)?;
        animate_cursor_to(screen_x, screen_y);
        unsafe { SetCursorPos(screen_x, screen_y)? };
        ensure_not_paused()?;
        send_inputs(&[mouse_input(MOUSEEVENTF_WHEEL, delta_y as u32)])?;
        Ok(json!({
            "acted": true,
            "action": "scroll",
            "window_id": claims.window_id,
            "delta_y": delta_y,
            "next": "Continue acting or observe again if the UI changed."
        }))
    }

    pub(super) fn drag(
        claims: &ObservationClaims,
        start_x: i32,
        start_y: i32,
        end_x: i32,
        end_y: i32,
    ) -> Result<Value> {
        let (_, info) = focus_window_fast(claims)?;
        let (from_x, from_y) = point_in_window(&info, start_x, start_y)?;
        let (to_x, to_y) = point_in_window(&info, end_x, end_y)?;
        animate_cursor_to(from_x, from_y);
        unsafe { SetCursorPos(from_x, from_y)? };
        ensure_not_paused()?;
        send_inputs(&[mouse_input(MOUSEEVENTF_LEFTDOWN, 0)])?;
        let drag_result = (|| -> Result<()> {
            for step in 1..=6 {
                ensure_not_paused()?;
                let x = from_x + (to_x - from_x) * step / 6;
                let y = from_y + (to_y - from_y) * step / 6;
                unsafe { SetCursorPos(x, y)? };
                thread::sleep(Duration::from_millis(2));
            }
            Ok(())
        })();
        // Always release the mouse, including when the emergency pause arrives
        // during a drag.
        let release_result = send_inputs(&[mouse_input(MOUSEEVENTF_LEFTUP, 0)]);
        drag_result?;
        release_result?;
        Ok(json!({
            "acted": true,
            "action": "drag",
            "window_id": claims.window_id,
            "next": "Continue acting or observe again if the UI changed."
        }))
    }

    #[cfg(test)]
    mod tests {
        use super::super::classify_blocked;

        #[test]
        fn protected_apps_are_blocked() {
            assert!(classify_blocked("Hormachuelos", "ai-forge.exe").is_some());
            assert!(classify_blocked("Hormachuelos", "hormachuelos.exe").is_some());
            assert!(
                classify_blocked("Hormachuelos Optimized", "hormachuelos-optimized.exe").is_some()
            );
            assert!(classify_blocked("Terminal", "WindowsTerminal.exe").is_some());
            assert!(classify_blocked("Run", "explorer.exe").is_some());
            assert!(classify_blocked("ChatGPT", "chrome.exe").is_some());
            assert!(classify_blocked("Windows Security", "ApplicationFrameHost.exe").is_some());
            assert!(classify_blocked("Settings", "SystemSettings.exe").is_none());
            assert!(classify_blocked("Display", "SystemSettings.exe").is_none());
            assert!(classify_blocked("Snipping Tool", "ScreenSketch.exe").is_none());
            assert!(classify_blocked("Document - Notepad", "notepad.exe").is_none());
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    fn unsupported() -> Result<Value> {
        bail!("Computer Use is currently available on Windows only.")
    }

    pub(super) fn list_windows_json() -> Result<Value> {
        unsupported()
    }
    pub(super) fn list_candidate_windows_json() -> Result<Value> {
        unsupported()
    }
    pub(super) fn observe_window(_window_id: &str) -> Result<Value> {
        unsupported()
    }
    pub(super) fn focus_window_json(_window_id: &str) -> Result<Value> {
        unsupported()
    }
    pub(super) fn click(
        _claims: &ObservationClaims,
        _x: i32,
        _y: i32,
        _button: &str,
        _clicks: u32,
    ) -> Result<Value> {
        unsupported()
    }
    pub(super) fn type_text(_claims: &ObservationClaims, _text: &str) -> Result<Value> {
        unsupported()
    }
    pub(super) fn press_key(_claims: &ObservationClaims, _keys: &str) -> Result<Value> {
        unsupported()
    }
    pub(super) fn game_sequence(
        _claims: &ObservationClaims,
        _focus_point: Option<(i32, i32)>,
        _steps: &[GameControlStep],
    ) -> Result<Value> {
        unsupported()
    }
    pub(super) fn scroll(
        _claims: &ObservationClaims,
        _x: i32,
        _y: i32,
        _delta_y: i32,
    ) -> Result<Value> {
        unsupported()
    }
    pub(super) fn drag(
        _claims: &ObservationClaims,
        _start_x: i32,
        _start_y: i32,
        _end_x: i32,
        _end_y: i32,
    ) -> Result<Value> {
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_tokens_are_bound_and_expiring() {
        let claims = ObservationClaims {
            window_id: "123".into(),
            process_id: 42,
            process_name: "notepad.exe".into(),
            title: "Document - Notepad".into(),
            x: 1,
            y: 2,
            width: 800,
            height: 600,
            issued_ms: now_ms().unwrap(),
        };
        let token = sign_observation(&claims).unwrap();
        assert_eq!(verify_observation(&token, "123").unwrap(), claims);
        assert!(verify_observation(&token, "456").is_err());
    }

    #[test]
    fn tampered_observation_tokens_are_rejected() {
        let claims = ObservationClaims {
            window_id: "123".into(),
            process_id: 42,
            process_name: "notepad.exe".into(),
            title: "Document - Notepad".into(),
            x: 1,
            y: 2,
            width: 800,
            height: 600,
            issued_ms: now_ms().unwrap(),
        };
        let mut token = sign_observation(&claims).unwrap();
        token.push('x');
        assert!(verify_observation(&token, "123").is_err());
    }

    #[test]
    fn game_sequences_are_bounded_and_key_limited() {
        let valid = json!({
            "steps": [
                { "keys": "Space", "delay_ms": 100 },
                { "keys": "ArrowRight", "delay_ms": 180 },
                { "keys": "s", "delay_ms": 180 }
            ]
        });
        assert_eq!(parse_game_steps(&valid).unwrap().len(), 3);

        let unsafe_key = json!({ "steps": [{ "keys": "Win+R", "delay_ms": 0 }] });
        assert!(parse_game_steps(&unsafe_key).is_err());

        let too_long = json!({
            "steps": [{ "keys": "ArrowUp", "delay_ms": MAX_GAME_SEQUENCE_DELAY_MS + 1 }]
        });
        assert!(parse_game_steps(&too_long).is_err());
    }

    #[test]
    fn desktop_mode_allows_settings_and_blocks_secrets() {
        assert!(classify_blocked("Settings", "SystemSettings.exe").is_none());
        assert!(classify_blocked("Display", "SystemSettings.exe").is_none());
        assert!(classify_blocked("Windows Security", "ApplicationFrameHost.exe").is_some());
        assert!(classify_blocked("Hormachuelos", "hormachuelos.exe").is_some());
        assert!(classify_blocked("Hormachuelos Optimized", "hormachuelos-optimized.exe").is_some());
        assert!(classify_blocked("1Password", "1Password.exe").is_some());
        let cleaned = sanitize_allowed_apps([
            "notepad.exe",
            "SystemSettings.exe",
            "1Password.exe",
            "powershell.exe",
            "hormachuelos-optimized.exe",
        ]);
        assert_eq!(cleaned, vec!["notepad.exe", "systemsettings.exe"]);
    }
}
