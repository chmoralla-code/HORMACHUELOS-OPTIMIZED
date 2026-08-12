//! Cursor provider uses the official `@cursor/sdk` local agent (Node bridge).
//! `api.cursor.com` has no OpenAI-compatible `/chat/completions` endpoint.

use crate::agent::HistoryTurn;
use crate::flavour::FlavourRun;
use crate::smart_agent::SmartAgentRun;
use crate::state::SessionRun;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
struct BridgeEvent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    message: Option<String>,
    id: Option<String>,
    name: Option<String>,
    arguments: Option<Value>,
    content: Option<String>,
    ok: Option<bool>,
    #[allow(dead_code)]
    status: Option<String>,
    #[allow(dead_code)]
    result: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    /// The bridge sets this only when an implementation task explicitly
    /// declared the hidden completion marker in its final answer.
    completed: Option<bool>,
    /// True when the bridge emitted a substantive user-visible assistant reply.
    answered: Option<bool>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    summary: Option<String>,
    turn_tokens: Option<u64>,
    total_tokens: Option<u64>,
    iteration: Option<u32>,
}

// This is not a task or tool-loop limit. It only stops repeated Cursor passes
// that produce no tool activity at all; every concrete tool action resets it.
const MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES: u8 = 4;
const CURSOR_FIRST_EVENT_TIMEOUT: Duration = Duration::from_secs(45);
const CURSOR_IDLE_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const CURSOR_HOST_TOOL_RESULT_MAX_BYTES: usize = 48_000;

const CURSOR_AUTOMATIC_CONTINUATION_PROMPT: &str = "[System - Automatic continuation]\n\
The previous agent pass ended without the required completion marker. Continue the SAME implementation task from the current workspace and durable agent state.\n\
Do not repeat completed work and do not ask the client to type \"continue\". Inspect what remains, implement and verify the next steps.\n\
For project-root list/search calls use path \".\", never an empty path or \"..\". If a tool failed, correct its name or arguments and retry with a narrower query or a different tool instead of repeating the identical call.\n\
Finish with [[HORMACHUELOS_TASK_COMPLETE]] only when the full requested task is genuinely complete.";

const CURSOR_INTERRUPTED_REPLY_PROMPT: &str = "[System - Automatic recovery]\n\
The previous Cursor pass became unresponsive and the desktop restarted it from the SAME durable agent checkpoint. Continue the original request from the current workspace and do not repeat completed work.\n\
For project-root list/search calls use path \".\", never an empty path or \"..\". If a tool failed, correct its arguments or use a narrower/different tool instead of repeating the identical call. Complete the requested analysis or answer normally; do not mention this recovery unless it materially affects the result.";

const CURSOR_EMPTY_REPLY_PROMPT: &str = "[System - Empty-answer recovery]\n\
The previous Cursor model turn ended without any substantive user-visible answer. Answer the ORIGINAL user request now from the current conversation and saved agent checkpoint.\n\
If tools were used, synthesize their results into a complete answer. Never finish with blank text, status-only text, or an internal note. Give the user a direct, organized, self-contained response; do not mention this automatic retry.";

#[derive(Debug)]
struct CursorTurnOutcome {
    agent_id: Option<String>,
    completion_marker_seen: bool,
    answer_text_seen: bool,
    terminal: bool,
    made_concrete_progress: bool,
    recoverable_interruption: Option<String>,
}

impl CursorTurnOutcome {
    fn terminal(agent_id: Option<String>) -> Self {
        Self {
            agent_id,
            completion_marker_seen: false,
            answer_text_seen: false,
            terminal: true,
            made_concrete_progress: false,
            recoverable_interruption: None,
        }
    }
}

fn is_verified_cursor_completion(
    requires_project_completion: bool,
    completion_marker_seen: bool,
) -> bool {
    requires_project_completion && completion_marker_seen
}

#[derive(Default)]
struct CursorPassActivity {
    made_concrete_progress: bool,
    open_tools: HashMap<String, String>,
}

impl CursorPassActivity {
    fn record_tool_call(&mut self, id: &str, name: &str) {
        self.open_tools.insert(id.to_string(), name.to_string());
    }

    fn record_tool_result(&mut self, id: &str, result_name: &str, ok: bool) {
        let name = self
            .open_tools
            .remove(id)
            .unwrap_or_else(|| result_name.to_string());
        // A started tool or a failed result is not durable progress. Counting
        // either one allowed an identical broken call to reset the recovery
        // watchdog forever while the UI remained stuck on a working card.
        // Updating the cosmetic todo ledger is useful UI feedback, but it is
        // not evidence that an implementation or investigation advanced.
        if ok && crate::tools::normalize_tool_name(&name) != "todo_write" {
            self.made_concrete_progress = true;
        }
    }
}

fn cursor_host_tool_is_available(name: &str, permission_mode: &str) -> bool {
    let name = crate::tools::normalize_tool_name(name);
    if matches!(name.as_str(), "done" | "todo_write") {
        return false;
    }
    if crate::tools::is_computer_tool(&name) {
        return true;
    }
    if !crate::tools::is_supported_tool_name(&name) {
        return false;
    }
    let mode = permission_mode.trim().to_ascii_lowercase();
    !matches!(mode.as_str(), "ask" | "research") || crate::tools::is_readonly_tool(&name)
}

/// Convert the desktop's canonical OpenAI function schemas to Cursor custom
/// tool schemas. Cursor's built-in tool set changes between SDK releases; the
/// host bridge keeps every advertised AI-Forge tool backed by the same native
/// dispatcher and permission checks used by non-Cursor providers.
fn cursor_host_tool_schemas(permission_mode: &str, computer_use_enabled: bool) -> Vec<Value> {
    crate::tools::schemas(computer_use_enabled)
        .into_iter()
        .filter_map(|schema| {
            let function = schema.get("function")?;
            let name = function.get("name")?.as_str()?;
            if !cursor_host_tool_is_available(name, permission_mode) {
                return None;
            }
            Some(json!({
                "name": name,
                "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
                "inputSchema": function.get("parameters").cloned().unwrap_or_else(|| json!({
                    "type": "object",
                    "properties": {},
                })),
            }))
        })
        .collect()
}

fn truncate_cursor_host_tool_content(content: &str) -> String {
    if content.len() <= CURSOR_HOST_TOOL_RESULT_MAX_BYTES {
        return content.to_string();
    }

    fn prefix(value: &str, max_bytes: usize) -> &str {
        let mut end = max_bytes.min(value.len());
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        &value[..end]
    }

    fn suffix(value: &str, max_bytes: usize) -> &str {
        let mut start = value.len().saturating_sub(max_bytes);
        while start < value.len() && !value.is_char_boundary(start) {
            start += 1;
        }
        &value[start..]
    }

    let tail_budget = CURSOR_HOST_TOOL_RESULT_MAX_BYTES / 4;
    let marker = "\n\n...[native tool result truncated for model context]...\n\n";
    let head_budget = CURSOR_HOST_TOOL_RESULT_MAX_BYTES
        .saturating_sub(tail_budget)
        .saturating_sub(marker.len());
    format!(
        "{}{}{}",
        prefix(content, head_budget),
        marker,
        suffix(content, tail_budget)
    )
}

fn next_cursor_stalled_recovery_count(previous: u8, made_concrete_progress: bool) -> u8 {
    if made_concrete_progress {
        0
    } else {
        previous.saturating_add(1)
    }
}

#[derive(Clone, serde::Serialize)]
struct RunEvent {
    kind: String,
    session_id: String,
    payload: Value,
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    let _ = app.emit(
        "agent",
        RunEvent {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            payload,
        },
    );
}

async fn await_bridge_approval(
    _app: &AppHandle,
    _session_id: &str,
    _run: &SessionRun,
    _id: &str,
    _name: &str,
    _arguments: &Value,
    _summary: &str,
) -> bool {
    true
}

async fn wait_until_cursor_cancelled(cancel: Arc<std::sync::atomic::AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn await_cursor_question(
    app: &AppHandle,
    session_id: &str,
    run: &SessionRun,
    request_id: &str,
    arguments: &Value,
) -> (bool, String) {
    let question = arguments
        .get("question")
        .and_then(Value::as_str)
        .or_else(|| arguments.get("prompt").and_then(Value::as_str))
        .unwrap_or("Please choose an option:")
        .to_string();
    let mut options = crate::agent::parse_ask_user_options(arguments);
    let mut allow_other = arguments
        .get("allow_other")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if options.is_empty() {
        options = vec![
            "Continue with your recommended plan".into(),
            "Simpler / minimal version".into(),
            "More complete / polished version".into(),
        ];
        allow_other = true;
    } else if options.len() == 1 {
        allow_other = true;
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    *run.question_tx.lock().unwrap() = Some(tx);
    emit(
        app,
        session_id,
        "question",
        json!({
            "id": request_id,
            "question": question,
            "options": options,
            "allow_other": allow_other,
        }),
    );

    let response = tokio::select! {
        biased;
        _ = wait_until_cursor_cancelled(run.cancel.clone()) => {
            (false, "User cancelled the question.".to_string())
        }
        result = tokio::time::timeout(Duration::from_secs(600), rx) => {
            match result {
                Ok(Ok(answer)) => (true, answer),
                Ok(Err(_)) => (false, "The question was closed without an answer.".to_string()),
                Err(_) => (false, "Question timed out after 10 minutes.".to_string()),
            }
        }
    };
    *run.question_tx.lock().unwrap() = None;
    response
}

#[allow(clippy::too_many_arguments)]
async fn execute_cursor_host_tool(
    app: &AppHandle,
    session_id: &str,
    project_root: &Path,
    original_prompt: &str,
    permission_mode: &str,
    command_timeout_secs: u64,
    run: &SessionRun,
    request_id: &str,
    raw_name: &str,
    raw_arguments: Value,
    known_secrets: &[String],
) -> (bool, String) {
    let mut name = crate::tools::normalize_tool_name(raw_name);
    if !cursor_host_tool_is_available(&name, permission_mode) {
        return (
            false,
            format!(
                "Native tool {raw_name:?} is unavailable in {permission_mode} mode or is not registered."
            ),
        );
    }

    let mut arguments = if raw_arguments.is_object() {
        raw_arguments
    } else {
        json!({})
    };
    crate::tools::normalize_tool_arguments(&name, &mut arguments);

    // A model can confuse an account-status question with an authentication
    // request. Preserve the native agent's safety behavior and never pop open
    // a Connect flow just to answer "am I connected?".
    if name == "connect_account"
        && crate::integration_chat::prompt_is_status_inquiry(original_prompt)
    {
        let service = arguments
            .get("service")
            .and_then(Value::as_str)
            .map(str::to_string);
        name = "integration_status".into();
        arguments = json!({ "verify": false });
        if let Some(service) = service {
            arguments["service"] = Value::String(service);
        }
    }

    if name == "ask_user" {
        return await_cursor_question(app, session_id, run, request_id, &arguments).await;
    }

    if name == "connect_account" {
        if let Some(service) = arguments.get("service").and_then(Value::as_str) {
            if crate::integrations::INTEGRATIONS
                .iter()
                .any(|integration| integration.id == service)
            {
                emit(
                    app,
                    session_id,
                    "integration_auth",
                    json!({
                        "service": service,
                        "secure_entry": service != "github",
                    }),
                );
            }
        }
    }

    if crate::tools::needs_tool_confirm(&name, &arguments, project_root, permission_mode) {
        let approved =
            crate::agent::await_tool_confirm(app, session_id, run, request_id, &name, &arguments)
                .await;
        if !approved {
            return (
                false,
                if run.cancel.load(Ordering::SeqCst) {
                    "Tool execution was cancelled.".into()
                } else {
                    "User denied tool execution.".into()
                },
            );
        }
    }

    if run.cancel.load(Ordering::SeqCst) {
        return (false, "Tool execution was cancelled.".into());
    }

    let app_for_console = app.clone();
    let session_for_console = session_id.to_string();
    let secrets_for_console = Arc::new(known_secrets.to_vec());
    let on_console_line: Arc<crate::tools::ConsoleLineCallback> = Arc::new(move |stream, line| {
        let line =
            crate::integration_chat::redact_sensitive_text(line, secrets_for_console.as_ref());
        emit(
            &app_for_console,
            &session_for_console,
            "console_chunk",
            json!({ "stream": stream, "text": line }),
        );
    });
    let run_nonce = run.run_nonce().to_string();
    let context = crate::tools::ToolRunContext::owned(
        session_id,
        project_root.to_string_lossy().into_owned(),
        run_nonce,
        run.cancel.clone(),
        run.active_pid.clone(),
        Some(on_console_line),
        run.checkpoint(),
        run.protect_command_changes(),
    );
    let tool_name = name.clone();
    let tool_arguments = arguments.clone();
    let tool_root = project_root.to_path_buf();
    let cancel = run.cancel.clone();
    let active_pid = run.active_pid.clone();
    let execution = tokio::select! {
        biased;
        _ = wait_until_cursor_cancelled(cancel) => {
            if let Some(pid) = active_pid.lock().unwrap().take() {
                crate::tools::kill_process_tree(pid);
            }
            Err(anyhow!("Tool execution was cancelled."))
        }
        joined = tokio::task::spawn_blocking(move || {
            crate::tools::execute(
                &tool_name,
                &tool_arguments,
                &tool_root,
                command_timeout_secs,
                &context,
            )
        }) => match joined {
            Ok(result) => result,
            Err(error) => Err(anyhow!("Native tool task failed: {error}")),
        }
    };

    match execution {
        Ok(content) => {
            let content = crate::integration_chat::redact_sensitive_text(&content, known_secrets);
            (true, truncate_cursor_host_tool_content(&content))
        }
        Err(error) => {
            let content = crate::integration_chat::redact_sensitive_text(
                &format!("Error: {error}"),
                known_secrets,
            );
            (false, truncate_cursor_host_tool_content(&content))
        }
    }
}

fn strip_windows_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    // Windows canonicalize() yields \\?\C:\... which Node realpath mishandles as "C:".
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn bridge_script_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join("scripts/cursor-bridge.mjs"),
            exe_dir.join("runtime/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/runtime/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/cursor-bridge.mjs"),
            exe_dir.join("_up_/scripts/cursor-bridge.mjs"),
            exe_dir.join("_up_/runtime/scripts/cursor-bridge.mjs"),
        ]);
    }
    // Source-tree paths are development fallbacks. Packaged releases must not
    // prefer a mutable checkout that happens to exist on the same machine.
    candidates.extend([
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/cursor-bridge.mjs"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/cursor-bridge.mjs"),
    ]);
    candidates
}

fn bridge_script_path() -> Result<PathBuf> {
    let candidates = bridge_script_candidates();
    for path in candidates {
        if let Ok(resolved) = path.canonicalize() {
            let resolved = strip_windows_verbatim(resolved);
            if resolved.is_file() {
                return Ok(resolved);
            }
        }
        if path.is_file() {
            return Ok(strip_windows_verbatim(path));
        }
    }
    Err(anyhow!(
        "Cursor bridge script not found. Bundle scripts/cursor-bridge.mjs under the app resources directory."
    ))
}

fn node_runtime_candidates(bridge: &Path) -> Vec<PathBuf> {
    let binary = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join(binary),
            exe_dir.join("runtime").join(binary),
            exe_dir.join("resources").join(binary),
            exe_dir.join("resources/runtime").join(binary),
        ]);
    }
    if let Some(scripts_dir) = bridge.parent() {
        candidates.extend([
            scripts_dir.join(binary),
            scripts_dir.join("runtime").join(binary),
            scripts_dir
                .parent()
                .unwrap_or(scripts_dir)
                .join("runtime")
                .join(binary),
        ]);
    }
    candidates
}

fn node_runtime_path(bridge: &Path) -> PathBuf {
    for path in node_runtime_candidates(bridge) {
        if let Ok(resolved) = path.canonicalize() {
            let resolved = strip_windows_verbatim(resolved);
            if resolved.is_file() {
                return resolved;
            }
        }
        if path.is_file() {
            return strip_windows_verbatim(path);
        }
    }
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn project_node_modules(bridge: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(scripts) = bridge.parent() {
        candidates.push(scripts.join("node_modules"));
        if let Some(root) = scripts.parent() {
            candidates.push(root.join("node_modules"));
        }
    }
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join("node_modules"),
            exe_dir.join("resources/node_modules"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_dir())
}

/// Ask the Cursor SDK for every model available to this API key (installer built-in catalog).
pub async fn list_cursor_models(api_key: &str) -> Result<Vec<String>> {
    let bridge = bridge_script_path()?;
    let node_runtime = node_runtime_path(&bridge);
    let forge_root = bridge
        .parent()
        .and_then(|scripts| scripts.parent())
        .map(|p| strip_windows_verbatim(p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let request = json!({
        "action": "list_models",
        "apiKey": api_key,
    });

    let mut cmd = Command::new(&node_runtime);
    cmd.arg(bridge.to_string_lossy().as_ref())
        .current_dir(&forge_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(node_modules) = project_node_modules(&bridge) {
        let node_modules = strip_windows_verbatim(node_modules);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let node_path = if existing.is_empty() {
            node_modules.display().to_string()
        } else {
            format!("{}{}{}", node_modules.display(), sep, existing)
        };
        cmd.env("NODE_PATH", node_path);
    }
    cmd.env("NODE_NO_WARNINGS", "1");

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Failed to start Cursor runtime for model list at '{}'.",
            node_runtime.display()
        )
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdin missing"))?;
    stdin.write_all(format!("{request}\n").as_bytes()).await?;
    stdin.flush().await?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdout missing"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut models = Vec::new();
    let mut error: Option<String> = None;
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "models" {
            if let Some(arr) = event.get("models").and_then(|v| v.as_array()) {
                models = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        } else if kind == "error" {
            error = event
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }
    let _ = child.wait().await;
    if models.is_empty() {
        if let Some(msg) = error {
            return Err(anyhow!(msg));
        }
        return Err(anyhow!("Cursor returned no models for this API key."));
    }
    Ok(models)
}

const CURSOR_HISTORY_MAX_TURNS: usize = 24;
const CURSOR_HISTORY_MAX_CHARS: usize = 24_000;
const CURSOR_HISTORY_MAX_TURN_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct BridgeHistoryTurn {
    role: String,
    content: String,
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn history_turn_content(turn: &HistoryTurn) -> String {
    let mut content = turn.content.trim().to_string();
    if turn.role.eq_ignore_ascii_case("tool") {
        let tool_name = turn.name.as_deref().unwrap_or("tool");
        content = format!("Tool result ({tool_name}): {content}");
    }
    if let Some(tool_calls) = turn.tool_calls.as_ref().filter(|calls| !calls.is_empty()) {
        let summaries = tool_calls
            .iter()
            .take(6)
            .map(|call| {
                let args = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into());
                format!("{}({})", call.name, truncate_chars(&args, 500))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&format!("Tool calls: {summaries}"));
    }
    truncate_chars(&content, CURSOR_HISTORY_MAX_TURN_CHARS)
}

fn bounded_cursor_history(history: &[HistoryTurn]) -> Vec<BridgeHistoryTurn> {
    let mut remaining = CURSOR_HISTORY_MAX_CHARS;
    let mut newest_first = Vec::new();

    for turn in history.iter().rev() {
        if newest_first.len() >= CURSOR_HISTORY_MAX_TURNS || remaining == 0 {
            break;
        }
        let role = match turn.role.trim().to_ascii_lowercase().as_str() {
            "user" => "user",
            "assistant" => "assistant",
            "system" => "system",
            "tool" => "tool",
            _ => continue,
        };
        let content = history_turn_content(turn);
        if content.is_empty() {
            continue;
        }
        let content = truncate_chars(&content, remaining);
        remaining = remaining.saturating_sub(content.chars().count());
        newest_first.push(BridgeHistoryTurn {
            role: role.into(),
            content,
        });
    }

    newest_first.reverse();
    newest_first
}

fn cursor_permission_enforcement(mode: &str) -> &'static str {
    match mode {
        "full" | "multi_agent" | "plan" => "cursor_sdk_agent",
        "auto" => "cursor_sdk_auto_review",
        "ask" | "research" => "cursor_sdk_plan_read_only",
        _ => "cursor_sdk_plan_read_only",
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_event(
    app: &AppHandle,
    session_id: &str,
    event: BridgeEvent,
    agent_id_out: &mut Option<String>,
    completion_marker_seen: &mut bool,
    answer_text_seen: &mut bool,
    saw_error: &mut Option<String>,
    smart_agent: &mut SmartAgentRun,
    activity: &mut CursorPassActivity,
    flavour: &mut FlavourRun,
    model: &str,
) -> bool {
    match event.kind.as_str() {
        "thinking" => {
            emit(app, session_id, "thinking", json!({ "iteration": 0 }));
        }
        "reasoning" => {
            if let Some(text) = event.text.filter(|t| !t.is_empty()) {
                emit(
                    app,
                    session_id,
                    "reasoning",
                    json!({ "text": text, "iteration": 0 }),
                );
            }
        }
        "text" => {
            if let Some(text) = event.text.filter(|t| !t.trim().is_empty()) {
                *answer_text_seen = true;
                emit(app, session_id, "text", json!({ "text": text }));
            }
        }
        "tool_call" => {
            let name = event.name.unwrap_or_else(|| "tool".into());
            let id = event.id.unwrap_or_else(|| name.clone());
            let arguments = event.arguments.unwrap_or_else(|| json!({}));
            if flavour.record_tool_call(&id, &name, &arguments) {
                emit(
                    app,
                    session_id,
                    "status",
                    json!({ "message": "Flavour · updating working memory…" }),
                );
            }
            smart_agent.on_tool_call(app, session_id, &id, &name, &arguments);
            activity.record_tool_call(&id, &name);
            emit(
                app,
                session_id,
                "tool_call",
                json!({
                    "id": id,
                    "name": name,
                    "arguments": arguments,
                }),
            );
        }
        "tool_result" => {
            let name = event.name.unwrap_or_else(|| "tool".into());
            let id = event.id.unwrap_or_else(|| name.clone());
            let ok = event.ok.unwrap_or(true);
            let content = event.content.unwrap_or_default();
            smart_agent.on_tool_result(app, session_id, &id, &name, ok);
            activity.record_tool_result(&id, &name, ok);
            flavour.record_tool_result(&id, &name, &json!({}), ok, &content);
            emit(
                app,
                session_id,
                "tool_result",
                json!({
                    "id": id,
                    "name": name,
                    "ok": ok,
                    "content": content,
                    "streamed": false,
                }),
            );
        }
        "checkpoint" | "done" => {
            if let Some(id) = event.agent_id.filter(|s| !s.is_empty()) {
                *agent_id_out = Some(id);
            }
            if event.kind == "done" {
                if event.completed.unwrap_or(false) {
                    *completion_marker_seen = true;
                }
                if event.answered.unwrap_or(false) {
                    *answer_text_seen = true;
                }
            }
        }
        "usage" => {
            let raw = event.turn_tokens.unwrap_or(0);
            let billable = crate::license::to_billable_tokens("cursor", model, raw);
            // Cursor uses the customer's Cursor subscription/API key. It is
            // useful to show per-session tokens, but it must never burn or
            // hard-stop the separate Hormachuelos hosted-plan wallet.
            emit(
                app,
                session_id,
                "usage",
                json!({
                    "iteration": event.iteration.unwrap_or(0),
                    "turn_tokens": billable,
                    "raw_tokens": raw,
                    "total_tokens": event.total_tokens.unwrap_or(raw),
                    "license": null,
                }),
            );
        }
        "error" => {
            let msg = event
                .message
                .or(event.text)
                .unwrap_or_else(|| "Cursor SDK error".into());
            emit(
                app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            *saw_error = Some(msg);
        }
        "status" => {
            let message = event
                .message
                .or(event.text)
                .unwrap_or_else(|| "Working…".into());
            emit(app, session_id, "status", json!({ "message": message }));
        }
        _ => {}
    }
    false
}

/// Run one user turn through Cursor's local SDK agent.
/// Returns the durable local agent id for follow-up turns in this session.
#[allow(clippy::too_many_arguments)]
pub async fn run_cursor_turn(
    app: Arc<AppHandle>,
    project_root: &str,
    prompt: &str,
    user_request: &str,
    api_key: &str,
    model: &str,
    effort: &str,
    permission_mode: &str,
    computer_use_enabled: bool,
    command_timeout_secs: u64,
    session_id: &str,
    run: Arc<SessionRun>,
    history: &[HistoryTurn],
    resume_agent_id: Option<String>,
    requires_project_completion: bool,
    smart_agent_enabled: bool,
    task_profile: &str,
    execution_profile: &str,
    flavour: &mut FlavourRun,
) -> Result<Option<String>> {
    let mut continuation_pass: u32 = 0;
    let mut consecutive_stalled_recoveries: u8 = 0;
    let mut current_prompt = prompt.to_string();
    let mut current_agent_id = resume_agent_id;
    let smart_agent_active = smart_agent_enabled && requires_project_completion;
    let fast_execution = task_profile.eq_ignore_ascii_case("design_edit_fast")
        || execution_profile.eq_ignore_ascii_case("fast");
    let mut smart_agent = SmartAgentRun::new(smart_agent_active, fast_execution);
    let computer_use_active = computer_use_enabled && !crate::computer_use::is_paused();
    emit(
        &app,
        session_id,
        "start",
        json!({
            "prompt": prompt,
            "provider": "OpenAI",
            "model": model,
            "permission_mode": permission_mode,
            "permission_enforcement": cursor_permission_enforcement(permission_mode),
            "host_approval_callbacks": false,
            "computer_use": computer_use_active,
            "smart_agent_enabled": smart_agent_active,
            "flavour_enabled": flavour.is_enabled(),
            "task_profile": task_profile,
            "execution_profile": execution_profile,
            \
        }),
    );
    if flavour.is_enabled() {
        emit(
            &app,
            session_id,
            "status",
            json!({ "message": "Flavour · recalling project and session memory…" }),
        );
    }
    smart_agent.emit_plan(&app, session_id);

    loop {
        let outcome = run_cursor_attempt(
            app.clone(),
            project_root,
            &current_prompt,
            user_request,
            api_key,
            model,
            effort,
            permission_mode,
            computer_use_enabled,
            command_timeout_secs,
            session_id,
            run.clone(),
            history,
            current_agent_id.clone(),
            requires_project_completion,
            &mut smart_agent,
            flavour,
        )
        .await?;

        if let Some(id) = outcome.agent_id.filter(|id| !id.is_empty()) {
            current_agent_id = Some(id);
        }
        let mut recoverable_interruption = outcome.recoverable_interruption.clone();

        if outcome.terminal {
            return Ok(current_agent_id);
        }

        if is_verified_cursor_completion(
            requires_project_completion,
            outcome.completion_marker_seen,
        ) {
            if smart_agent.request_final_review(&app, session_id) {
                continuation_pass = continuation_pass.saturating_add(1);
                emit(
                    &app,
                    session_id,
                    "reasoning",
                    json!({
                        "text": "Verifying the workspace before delivery...",
                        "iteration": continuation_pass,
                    }),
                );
                current_prompt = SmartAgentRun::final_review_instruction().to_string();
                continue;
            }
            smart_agent.complete(&app, session_id);
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "completed", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        if !requires_project_completion
            && recoverable_interruption.is_none()
            && outcome.answer_text_seen
        {
            // A regular Cursor reply is not an explicit task-completion
            // handshake. Keep its terminal reason distinct so the frontend
            // never announces it as "done working".
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "no_tool_calls", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        let empty_reply_recovery = !requires_project_completion
            && recoverable_interruption.is_none()
            && !outcome.answer_text_seen;
        if empty_reply_recovery {
            let message =
                "Cursor returned no visible answer; retrying once from its saved checkpoint.";
            emit(&app, session_id, "status", json!({ "message": message }));
            recoverable_interruption = Some(message.into());
        }

        consecutive_stalled_recoveries = next_cursor_stalled_recovery_count(
            consecutive_stalled_recoveries,
            outcome.made_concrete_progress && !empty_reply_recovery,
        );

        if current_agent_id.is_none() {
            smart_agent.pause(
                &app,
                session_id,
                "The Cursor agent ended without a resumable checkpoint.",
            );
            emit(
                &app,
                session_id,
                "text",
                json!({
                    "text": "\n\n— The Cursor agent finished without a resumable checkpoint, so automatic continuation could not safely preserve its state."
                }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "continuation_checkpoint_missing", "iteration": continuation_pass }),
            );
            return Ok(None);
        }

        if consecutive_stalled_recoveries >= MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES {
            smart_agent.pause(
                &app,
                session_id,
                if empty_reply_recovery {
                    "Automatic recovery paused after repeated Cursor passes without a visible answer."
                } else {
                    "Automatic recovery paused after repeated Cursor passes without a successful tool result."
                },
            );
            emit(
                &app,
                session_id,
                "text",
                json!({
                    "text": if empty_reply_recovery {
                        "\n\n— Cursor could not produce a visible answer after several automatic retries. Your conversation and checkpoint are preserved; retrying with another model may help."
                    } else {
                        "\n\n— Automatic recovery paused after repeated Cursor passes without a successful tool result. Your workspace and agent checkpoint are preserved."
                    }
                }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "continuation_safety_guard", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        continuation_pass = continuation_pass.saturating_add(1);
        emit(
            &app,
            session_id,
            "reasoning",
            json!({
                "text": if empty_reply_recovery {
                    "The model returned no answer; retrying automatically from its saved checkpoint..."
                } else if recoverable_interruption.is_some() {
                    "The Cursor pass stopped responding; resuming automatically from its saved checkpoint..."
                } else {
                    "Continuing automatically from the unfinished Cursor task..."
                },
                "iteration": continuation_pass,
            }),
        );
        let continuation = if requires_project_completion {
            CURSOR_AUTOMATIC_CONTINUATION_PROMPT
        } else if empty_reply_recovery {
            CURSOR_EMPTY_REPLY_PROMPT
        } else {
            CURSOR_INTERRUPTED_REPLY_PROMPT
        };
        current_prompt = format!(
            "{}\n\n{continuation}",
            flavour.context_block(if fast_execution { 3_000 } else { 8_000 })
        );
    }
}

/// Run one Cursor SDK pass. The outer runner owns automatic continuation so
/// the desktop keeps one user-initiated session active across resumed passes.
#[allow(clippy::too_many_arguments)]
async fn run_cursor_attempt(
    app: Arc<AppHandle>,
    project_root: &str,
    prompt: &str,
    user_request: &str,
    api_key: &str,
    model: &str,
    effort: &str,
    permission_mode: &str,
    computer_use_enabled: bool,
    command_timeout_secs: u64,
    session_id: &str,
    run: Arc<SessionRun>,
    history: &[HistoryTurn],
    resume_agent_id: Option<String>,
    requires_project_completion: bool,
    smart_agent: &mut SmartAgentRun,
    flavour: &mut FlavourRun,
) -> Result<CursorTurnOutcome> {
    let bridge = bridge_script_path()?;
    let node_runtime = node_runtime_path(&bridge);
    let forge_root = bridge
        .parent()
        .and_then(|scripts| scripts.parent())
        .map(|p| strip_windows_verbatim(p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let bridge_arg = bridge.to_string_lossy().to_string();
    let cancel = run.cancel.clone();
    let computer_use_active = computer_use_enabled && !crate::computer_use::is_paused();
    let host_tool_schemas = cursor_host_tool_schemas(permission_mode, computer_use_active);

    emit(&app, session_id, "thinking", json!({ "iteration": 0 }));

    let bounded_history = bounded_cursor_history(history);
    let request = json!({
        "apiKey": api_key,
        "model": model,
        "effort": effort,
        "permissionMode": permission_mode,
        "cwd": strip_windows_verbatim(PathBuf::from(project_root)).to_string_lossy(),
        "prompt": prompt,
        "history": bounded_history,
        "agentId": resume_agent_id,
        "sessionId": session_id,
        "completionMarker": requires_project_completion.then_some("[[HORMACHUELOS_TASK_COMPLETE]]"),
        // The legacy Cursor-side Win32 helper is permanently disabled. Preview
        // tools are ordinary host tools backed by the scoped Rust/UI broker.
        "computerUseEnabled": false,
        "hostToolSchemas": host_tool_schemas,
    });

    // Prefer a bundled runtime. PATH is a development fallback only.
    let mut cmd = Command::new(&node_runtime);
    cmd.arg(&bridge_arg)
        .current_dir(&forge_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Hide the Node console window that otherwise pops over the desktop app.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(node_modules) = project_node_modules(&bridge) {
        let node_modules = strip_windows_verbatim(node_modules);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let node_path = if existing.is_empty() {
            node_modules.display().to_string()
        } else {
            format!("{}{}{}", node_modules.display(), sep, existing)
        };
        cmd.env("NODE_PATH", node_path);
    }
    cmd.env("NODE_NO_WARNINGS", "1");

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Failed to start the Cursor SDK Node runtime at '{}'. Bundle runtime/node.exe for releases or install Node.js 22+ for development.",
            node_runtime.display()
        )
    })?;

    let bridge_pid = child.id();
    if let Some(pid) = bridge_pid {
        *run.active_pid.lock().unwrap() = Some(pid);
    }

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdin missing"))?;
    let request_line = format!("{request}\n");
    child_stdin.write_all(request_line.as_bytes()).await?;
    child_stdin.flush().await?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdout missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stderr missing"))?;

    let mut stdout_lines = BufReader::new(stdout).lines();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if tail.len() < 4000 {
                tail.push_str(&line);
                tail.push('\n');
            }
        }
        tail
    });

    let mut agent_id_out: Option<String> = None;
    // A regular chat turn has no completion marker. Initializing this to true
    // made the outer runner report ordinary prose as a verified completed task,
    // leaving its distinct no_tool_calls branch unreachable.
    let mut completion_marker_seen = false;
    let mut answer_text_seen = false;
    let mut saw_error: Option<String> = None;
    let mut recoverable_interruption: Option<String> = None;
    let mut activity = CursorPassActivity::default();
    let known_integration_secrets = crate::integrations::loaded_tokens();
    let mut saw_bridge_event = false;
    let started = std::time::Instant::now();
    let mut last_bridge_event = started;

    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            emit(&app, session_id, "cancelled", json!({ "iteration": 0 }));
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Ok(CursorTurnOutcome::terminal(agent_id_out));
        }

        if !saw_bridge_event && started.elapsed() > CURSOR_FIRST_EVENT_TIMEOUT {
            let _ = child.start_kill();
            let msg = "Cursor SDK took too long to start. Check your Cursor API key and network, then try again.";
            emit(
                &app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "timeout", "iteration": 0 }),
            );
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Err(anyhow!(msg));
        }

        if last_bridge_event.elapsed() > CURSOR_IDLE_TIMEOUT {
            let _ = child.start_kill();
            let msg = "Cursor SDK stopped reporting progress for 12 minutes; resuming from its saved checkpoint.";
            emit(&app, session_id, "status", json!({ "message": msg }));
            recoverable_interruption = Some(msg.into());
            break;
        }

        match tokio::time::timeout(Duration::from_secs(2), stdout_lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                saw_bridge_event = true;
                last_bridge_event = std::time::Instant::now();
                if let Ok(event) = serde_json::from_str::<BridgeEvent>(line) {
                    if event.kind == "recoverable_interruption" {
                        let message = event
                            .message
                            .or(event.text)
                            .unwrap_or_else(|| {
                                "A Cursor inspection tool stopped reporting progress; resuming from its saved checkpoint."
                                    .into()
                            });
                        recoverable_interruption =
                            Some(crate::integration_chat::redact_sensitive_text(
                                &message,
                                &known_integration_secrets,
                            ));
                        continue;
                    }
                    if event.kind == "host_tool_request" {
                        let Some(request_id) =
                            event.request_id.filter(|value| !value.trim().is_empty())
                        else {
                            saw_error = Some(
                                "Cursor bridge sent a native tool request without an id.".into(),
                            );
                            break;
                        };
                        let raw_name = event.name.unwrap_or_default();
                        let raw_arguments = event.arguments.unwrap_or_else(|| json!({}));
                        if flavour.record_tool_call(&request_id, &raw_name, &raw_arguments) {
                            emit(
                                &app,
                                session_id,
                                "status",
                                json!({ "message": "Flavour · updating working memory…" }),
                            );
                        }
                        let (ok, content) = execute_cursor_host_tool(
                            &app,
                            session_id,
                            Path::new(project_root),
                            user_request,
                            permission_mode,
                            command_timeout_secs,
                            &run,
                            &request_id,
                            &raw_name,
                            raw_arguments.clone(),
                            &known_integration_secrets,
                        )
                        .await;
                        flavour.record_tool_result(
                            &request_id,
                            &raw_name,
                            &raw_arguments,
                            ok,
                            &content,
                        );
                        let response = json!({
                            "type": "host_tool_response",
                            "requestId": request_id,
                            "ok": ok,
                            "content": content,
                        });
                        let response_line = format!("{response}\n");
                        if let Err(error) = child_stdin.write_all(response_line.as_bytes()).await {
                            saw_error =
                                Some(format!("Failed writing native Cursor tool result: {error}"));
                            break;
                        }
                        if let Err(error) = child_stdin.flush().await {
                            saw_error = Some(format!(
                                "Failed flushing native Cursor tool result: {error}"
                            ));
                            break;
                        }
                        if !run.cancel.load(Ordering::SeqCst) {
                            if let Some(pid) = bridge_pid {
                                *run.active_pid.lock().unwrap() = Some(pid);
                            }
                        }
                        continue;
                    }
                    if event.kind == "approval_request" {
                        let Some(request_id) = event.request_id.filter(|value| !value.is_empty())
                        else {
                            saw_error =
                                Some("Cursor bridge sent an invalid approval request.".into());
                            break;
                        };
                        let name = event.name.unwrap_or_else(|| "computer_action".into());
                        let arguments = event.arguments.unwrap_or_else(|| json!({}));
                        let summary = event
                            .summary
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| format!("Allow {name}?"));
                        let approved = await_bridge_approval(
                            &app,
                            session_id,
                            &run,
                            &request_id,
                            &name,
                            &arguments,
                            &summary,
                        )
                        .await;
                        let response = json!({
                            "type": "approval_response",
                            "requestId": request_id,
                            "approved": approved,
                        });
                        let response_line = format!("{response}\n");
                        if let Err(error) = child_stdin.write_all(response_line.as_bytes()).await {
                            saw_error =
                                Some(format!("Failed writing Cursor bridge approval: {error}"));
                            break;
                        }
                        if let Err(error) = child_stdin.flush().await {
                            saw_error =
                                Some(format!("Failed flushing Cursor bridge approval: {error}"));
                            break;
                        }
                        continue;
                    }
                    let event_kind = event.kind.clone();
                    let usage_blocked = handle_event(
                        &app,
                        session_id,
                        event,
                        &mut agent_id_out,
                        &mut completion_marker_seen,
                        &mut answer_text_seen,
                        &mut saw_error,
                        smart_agent,
                        &mut activity,
                        flavour,
                        model,
                    );
                    if event_kind == "done" && recoverable_interruption.is_some() {
                        // The bridge has sealed every visible tool card and
                        // persisted the durable agent id. Stop any wedged SDK
                        // handles now; the outer loop will resume in a fresh
                        // bridge process with the recovery instruction.
                        let _ = child.start_kill();
                        break;
                    }
                    if usage_blocked {
                        cancel.store(true, Ordering::SeqCst);
                        let _ = child.start_kill();
                        *run.active_pid.lock().unwrap() = None;
                        let _ = stderr_task.await;
                        emit(
                            &app,
                            session_id,
                            "end",
                            json!({ "reason": "usage_limit", "iteration": 0 }),
                        );
                        return Ok(CursorTurnOutcome::terminal(agent_id_out));
                    }
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                saw_error = Some(format!("Failed reading Cursor bridge output: {err}"));
                break;
            }
            Err(_) => {
                // Periodic wake to re-check cancel + timeouts.
                continue;
            }
        }
    }

    if saw_error.is_some() {
        let _ = child.start_kill();
    }
    drop(child_stdin);
    let status = child
        .wait()
        .await
        .context("Cursor bridge process wait failed")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    *run.active_pid.lock().unwrap() = None;

    if !status.success() && saw_error.is_none() && recoverable_interruption.is_none() {
        saw_error = Some(if stderr_tail.trim().is_empty() {
            format!("Cursor SDK exited with status {status}")
        } else {
            stderr_tail.trim().to_string()
        });
    }

    if let Some(err) = saw_error {
        emit(&app, session_id, "error", json!({ "message": err.clone() }));
        emit(
            &app,
            session_id,
            "end",
            json!({ "reason": "error", "iteration": 0 }),
        );
        return Err(anyhow!(err));
    }

    Ok(CursorTurnOutcome {
        agent_id: agent_id_out,
        completion_marker_seen,
        answer_text_seen,
        terminal: false,
        made_concrete_progress: activity.made_concrete_progress,
        recoverable_interruption,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn turn(role: &str, content: impl Into<String>) -> HistoryTurn {
        HistoryTurn {
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    #[test]
    fn cursor_history_keeps_the_newest_bounded_turns() {
        let history = (0..40)
            .map(|index| turn("user", format!("turn-{index}")))
            .collect::<Vec<_>>();

        let bounded = bounded_cursor_history(&history);

        assert_eq!(bounded.len(), CURSOR_HISTORY_MAX_TURNS);
        assert_eq!(bounded.first().unwrap().content, "turn-16");
        assert_eq!(bounded.last().unwrap().content, "turn-39");
    }

    #[test]
    fn regular_cursor_reply_is_not_a_verified_project_completion() {
        assert!(!is_verified_cursor_completion(false, false));
        assert!(!is_verified_cursor_completion(false, true));
        assert!(!is_verified_cursor_completion(true, false));
        assert!(is_verified_cursor_completion(true, true));
    }

    #[test]
    fn cursor_history_is_unicode_safe_and_respects_character_budget() {
        let history = vec![turn(
            "assistant",
            "😀".repeat(CURSOR_HISTORY_MAX_CHARS + 100),
        )];

        let bounded = bounded_cursor_history(&history);

        assert_eq!(bounded.len(), 1);
        assert_eq!(
            bounded[0].content.chars().count(),
            CURSOR_HISTORY_MAX_TURN_CHARS
        );
    }

    #[test]
    fn packaged_bridge_and_runtime_locations_are_considered() {
        let bridge_candidates = bridge_script_candidates()
            .into_iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect::<Vec<_>>();
        assert!(bridge_candidates
            .iter()
            .any(|path| path.ends_with("resources/scripts/cursor-bridge.mjs")));
        assert!(bridge_candidates
            .iter()
            .any(|path| path.ends_with("runtime/scripts/cursor-bridge.mjs")));

        let runtime_candidates =
            node_runtime_candidates(Path::new("resources/scripts/cursor-bridge.mjs"))
                .into_iter()
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .collect::<Vec<_>>();
        assert!(runtime_candidates
            .iter()
            .any(|path| path.contains("resources/runtime/node")));
    }

    #[test]
    fn restricted_modes_report_read_only_sdk_enforcement() {
        assert_eq!(cursor_permission_enforcement("plan"), "cursor_sdk_agent");
        assert_eq!(
            cursor_permission_enforcement("ask"),
            "cursor_sdk_plan_read_only"
        );
        assert_eq!(
            cursor_permission_enforcement("research"),
            "cursor_sdk_plan_read_only"
        );
        assert_eq!(
            cursor_permission_enforcement("auto"),
            "cursor_sdk_auto_review"
        );
    }

    #[test]
    fn cursor_done_event_can_report_a_visible_answer() {
        let event: BridgeEvent = serde_json::from_value(json!({
            "type": "done",
            "answered": true
        }))
        .expect("done event should deserialize");
        assert_eq!(event.answered, Some(true));
    }

    #[test]
    fn cursor_recovery_watchdog_resets_after_successful_tool_result() {
        let mut stalls = 0;
        for _ in 0..(MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES - 1) {
            stalls = next_cursor_stalled_recovery_count(stalls, false);
        }
        assert!(stalls < MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES);

        stalls = next_cursor_stalled_recovery_count(stalls, true);
        assert_eq!(stalls, 0);
    }

    #[test]
    fn failed_or_unresolved_cursor_tools_do_not_count_as_progress() {
        let mut activity = CursorPassActivity::default();
        activity.record_tool_call("call-1", "grep");
        assert!(!activity.made_concrete_progress);
        assert_eq!(
            activity.open_tools.get("call-1").map(String::as_str),
            Some("grep")
        );

        activity.record_tool_result("call-1", "grep", false);
        assert!(!activity.made_concrete_progress);
        assert!(activity.open_tools.is_empty());

        activity.record_tool_call("todo-1", "TodoWrite");
        activity.record_tool_result("todo-1", "TodoWrite", true);
        assert!(!activity.made_concrete_progress);

        activity.record_tool_call("call-2", "read_file");
        activity.record_tool_result("call-2", "read_file", true);
        assert!(activity.made_concrete_progress);
    }

    #[test]
    fn cursor_registers_every_eligible_native_tool_with_permission_filtering() {
        let full = cursor_host_tool_schemas("full", true);
        let actual = full
            .iter()
            .map(|schema| schema["name"].as_str().expect("host tool name").to_string())
            .collect::<BTreeSet<_>>();
        let expected = crate::tools::schemas(true)
            .into_iter()
            .filter_map(|schema| {
                let name = schema["function"]["name"].as_str()?.to_string();
                (!matches!(name.as_str(), "done" | "todo_write")).then_some(name)
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
        assert!(actual.contains("read_file"));
        assert!(actual.contains("write_file"));
        assert!(actual.contains("ask_user"));
        assert!(actual.contains("open_path"));
        assert!(!actual.contains("done"));
        assert!(!actual.contains("todo_write"));
        assert!(full.iter().all(|schema| {
            schema["description"].is_string() && schema["inputSchema"]["type"] == "object"
        }));

        let ask = cursor_host_tool_schemas("ask", true);
        assert!(ask.iter().all(|schema| {
            let name = schema["name"].as_str().expect("ask tool name");
            crate::tools::is_readonly_tool(name) || crate::tools::is_computer_tool(name)
        }));
        assert!(ask.iter().any(|schema| schema["name"] == "grep"));
        assert!(ask
            .iter()
            .any(|schema| schema["name"] == "computer_actions"));
        assert!(!ask.iter().any(|schema| schema["name"] == "write_file"));
    }

    #[test]
    fn cursor_native_tool_results_preserve_error_tail_within_context_budget() {
        let content = format!("HEAD\n{}\nTAIL_ERROR", "😀".repeat(30_000));
        let compact = truncate_cursor_host_tool_content(&content);
        assert!(compact.len() <= CURSOR_HOST_TOOL_RESULT_MAX_BYTES);
        assert!(compact.starts_with("HEAD"));
        assert!(compact.ends_with("TAIL_ERROR"));
        assert!(compact.contains("native tool result truncated"));
    }
}
