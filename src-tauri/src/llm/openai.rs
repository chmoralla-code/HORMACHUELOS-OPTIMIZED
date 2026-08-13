use crate::llm::{
    ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink, ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

fn encode_message(message: &ChatMessage) -> Value {
    let mut encoded = json!({
        "role": message.role,
        "content": message.content,
    });
    if let Some(tool_calls) = &message.tool_calls {
        encoded["tool_calls"] = Value::Array(
            tool_calls
                .iter()
                .map(|tool_call| {
                    json!({
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.name,
                            "arguments": serde_json::to_string(&tool_call.arguments)
                                .unwrap_or_else(|_| "{}".to_string()),
                        },
                    })
                })
                .collect(),
        );
    }
    if let Some(id) = &message.tool_call_id {
        encoded["tool_call_id"] = Value::String(id.clone());
    }
    if let Some(name) = &message.name {
        encoded["name"] = Value::String(name.clone());
    }
    if let Some(reasoning) = &message.reasoning_content {
        encoded["reasoning_content"] = Value::String(reasoning.clone());
    }
    encoded
}

/// Map the UI effort to the `reasoning_effort` value a provider accepts.
///
/// xAI (Grok) accepts low / medium / high.
/// DeepSeek V4 (flash/pro) accepts low / high / max — UI xHigh/Ultra map to
/// max so the strongest tier is actually honored, and light/medium map to
/// low/high respectively.
fn normalized_reasoning_effort(provider_kind: &str, value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("high").trim().to_ascii_lowercase();
    let is_deepseek = provider_kind.eq_ignore_ascii_case("deepseek");
    match normalized.as_str() {
        "light" | "low" => "low",
        "medium" => {
            // DeepSeek V4 accepts low / high / max only.
            if is_deepseek {
                "high"
            } else {
                "medium"
            }
        }
        "high" => "high",
        // xAI caps at high (a 400 otherwise); DeepSeek supports max.
        "xhigh" | "ultra" | "max" => {
            if is_deepseek {
                "max"
            } else {
                "high"
            }
        }
        _ => "high",
    }
}

fn build_request_body(
    model: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    provider_kind: &str,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(encode_message).collect::<Vec<_>>(),
    });
    let normalized_model = model.to_ascii_lowercase();
    let is_xai_grok = provider_kind.eq_ignore_ascii_case("xai") && normalized_model == "grok-4.5";
    // Providers that honor an explicit reasoning-effort value.
    let supports_reasoning_effort = is_xai_grok
        || provider_kind.eq_ignore_ascii_case("deepseek")
        || provider_kind.eq_ignore_ascii_case("glm")
        || provider_kind.eq_ignore_ascii_case("openrouter")
        || provider_kind.eq_ignore_ascii_case("commandcode")
        || provider_kind.eq_ignore_ascii_case("hormachuelos_free")
        || provider_kind.eq_ignore_ascii_case("openai")
        || provider_kind.eq_ignore_ascii_case("cursor");
    let is_reasoning_model = normalized_model.starts_with("gpt-5")
        || normalized_model.starts_with("o1")
        || normalized_model.starts_with("o3")
        || normalized_model.starts_with("o4")
        || is_xai_grok
        || normalized_model.starts_with("deepseek-v4")
        || normalized_model.starts_with("glm-5");
    if !is_reasoning_model {
        body["temperature"] = json!(0.2);
    }
    if supports_reasoning_effort {
        body["reasoning_effort"] =
            json!(normalized_reasoning_effort(provider_kind, reasoning_effort));
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = json!("auto");
    }
    body
}

fn provider_http_error(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    // A 402 can originate either from the Hormachuelos wallet or from an
    // upstream provider. Keep those cases distinct so a client with a healthy
    // plan meter does not receive a misleading generic provider failure.
    let hosted_wallet_empty = body.to_ascii_lowercase().contains("usage_exhausted")
        || body
            .to_ascii_lowercase()
            .contains("hosted credits exhausted");
    let (code, message) = match status.as_u16() {
        400 | 422 => (
            "invalid_request",
            "The provider rejected the request. Check the model name and base URL.",
        ),
        401 | 403 => (
            "authentication_failed",
            "The provider rejected the API key. Save a current key in Settings.",
        ),
        402 if hosted_wallet_empty => (
            "usage_exhausted",
            "Your hosted plan wallet is empty. Refreshing the account balance now.",
        ),
        402 => (
            "provider_payment_required",
            "The upstream provider requires credits or rejected this request.",
        ),
        404 => (
            "model_or_endpoint_not_found",
            "The model or API endpoint was not found.",
        ),
        408 => (
            "provider_timeout",
            "The provider timed out while processing the request.",
        ),
        429 => (
            "rate_limited",
            "The provider rate limit was reached. Wait briefly or choose another model.",
        ),
        500..=599 => (
            "provider_unavailable",
            "The provider is temporarily unavailable.",
        ),
        _ => (
            "provider_error",
            "The provider returned an unexpected response.",
        ),
    };
    anyhow!("{}: {} (HTTP {})", code, message, status.as_u16())
}

/// Shared across every provider client so a stalled connection surfaces as a
/// resumable provider error instead of an endless black hole.
pub fn request_error(error: &reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("provider_timeout: The provider did not respond before the timeout.")
    } else if error.is_connect() {
        anyhow!("connection_failed: Could not connect to the provider. Check the base URL and network connection.")
    } else {
        anyhow!("network_error: The provider request could not be completed.")
    }
}

/// Transient transport / upstream blips that should keep the agent run alive
/// and wait for connectivity instead of ending the turn.
pub fn is_transient_provider_error(error: &anyhow::Error) -> bool {
    reconnect_attempt_limit(error).is_some()
}

/// How many reconnect attempts to allow for this error.
/// - `None` — not retryable (caller should fail immediately)
/// - `Some(0)` — keep retrying until the user stops (true offline)
/// - `Some(n)` where n > 0 — retry up to n times, then surface the error
///
/// Stream cuts / proxy timeouts must NOT loop forever: continuing a long
/// session against a 60s hosted proxy would otherwise show "Reconnecting…"
/// indefinitely after an update.
pub fn reconnect_attempt_limit(error: &anyhow::Error) -> Option<u32> {
    let message = error.to_string();
    let code = message
        .split_once(':')
        .map(|(code, _)| code.trim())
        .unwrap_or(message.trim());
    match code {
        // Machine is offline / DNS / TCP — wait for the network to return.
        "connection_failed" => Some(0),
        "rate_limited" => Some(8),
        // Upstream 502/503 blips are common on long hosted turns — retry more
        // before giving up, then the agent loop can still auto-continue.
        "provider_unavailable" => Some(10),
        "provider_timeout" | "network_error" => Some(6),
        _ => None,
    }
}

/// Standard client for cloud providers: bounded connect/read timeouts so a
/// stalled upstream can never freeze an agent run forever. Read timeout only
/// fires while the socket is fully idle — active streaming keeps the run alive.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Split `<think>…</think>` (or `<thinking>…</thinking>`) out of model content.
fn extract_think_block(raw: &str) -> Option<(String, String)> {
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        if let Some(start) = raw.find(open) {
            let after_open = start + open.len();
            if let Some(rel_end) = raw[after_open..].find(close) {
                let end = after_open + rel_end;
                let thought = raw[after_open..end].trim().to_string();
                let mut rest = String::new();
                rest.push_str(raw[..start].trim());
                let after = raw[end + close.len()..].trim();
                if !rest.is_empty() && !after.is_empty() {
                    rest.push('\n');
                }
                rest.push_str(after);
                if !thought.is_empty() {
                    return Some((thought, rest.trim().to_string()));
                }
            }
        }
    }
    None
}

/// A stream that produced zero SSE events and whose body is not an ordinary
/// completion response is a cut-off/error stream (proxy relay died before any
/// event, or the upstream returned an error object instead of choices). Treat
/// it as a resumable interruption instead of a hard "malformed JSON" error.
fn is_cut_off_stream_body(body: &str) -> bool {
    let body = body.trim();
    if body.is_empty() || !body.starts_with('{') {
        return true;
    }
    // `{"error": ...}` (possibly with `message`/`code`) is an upstream/gateway
    // failure, not a usable completion — return it as a resumable interruption.
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return value.get("error").is_some() && value.get("choices").is_none();
    }
    true
}

/// Read a string from a delta/message field. Accepts a bare string or an
/// object with `content` / `text` (Grok, DeepSeek, and some hosted proxies).
fn value_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
        return Some(text.to_string());
    }
    for key in ["content", "text"] {
        if let Some(text) = value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn delta_string(delta: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| delta.get(*key).and_then(value_text))
}

fn parse_response(text: &str) -> Result<LlmResponse> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: The provider returned malformed JSON."))?;
    let choice = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .ok_or_else(|| anyhow!("invalid_response: The provider returned no choices."))?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut content = message
        .get("content")
        .and_then(|content| content.as_str())
        .map(str::to_string);

    // Providers disagree on the field name for chain-of-thought.
    let mut reasoning_content = [
        "reasoning_content",
        "reasoning",
        "thinking",
        "reasoning_text",
    ]
    .iter()
    .find_map(|key| {
        message
            .get(*key)
            .and_then(value_text)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });

    // Some free/open models embed thoughts as <think>…</think> inside content.
    if reasoning_content.is_none() {
        if let Some(raw) = content.as_deref() {
            if let Some((thought, rest)) = extract_think_block(raw) {
                reasoning_content = Some(thought);
                content = if rest.is_empty() { None } else { Some(rest) };
            }
        }
    }
    let stop_reason = choice
        .get("finish_reason")
        .and_then(|reason| reason.as_str())
        .unwrap_or("stop")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(|calls| calls.as_array()) {
        for call in calls {
            let id = call
                .get("id")
                .and_then(|id| id.as_str())
                .unwrap_or("call")
                .to_string();
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let name = function
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = function
                .get("arguments")
                .map(|arguments| match arguments {
                    Value::String(raw) => parse_tool_call_arguments(raw)
                        .unwrap_or_else(|_| Value::Object(Default::default())),
                    value if value.is_object() || value.is_array() => value.clone(),
                    _ => Value::Object(Default::default()),
                })
                .unwrap_or_else(|| Value::Object(Default::default()));
            if name.is_empty() {
                continue;
            }
            tool_calls.push(ToolCall {
                id,
                name,
                arguments,
            });
        }
    }

    let usage_tokens = value
        .get("usage")
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|tokens| tokens.as_u64())
        .unwrap_or(0);

    Ok(LlmResponse {
        text: content,
        tool_calls,
        reasoning_content,
        stop_reason,
        usage_tokens,
    })
}

#[derive(Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
    preview_arguments: String,
    previewed_arguments: bool,
    previewed_name: String,
}

const FIRST_TOOL_PREVIEW_BYTES: usize = 64;
const TOOL_PREVIEW_BATCH_BYTES: usize = 512;

#[derive(Default)]
struct StreamAccumulator {
    text: String,
    reasoning: String,
    tool_calls: Vec<StreamToolCall>,
    /// Some OpenAI-compatible providers omit the numeric `index` from every
    /// streamed tool-call delta. Keep their stable call IDs so separate calls
    /// never collapse into a made-up concatenated name such as
    /// `list_dirglobgit_status`.
    tool_call_indices_by_id: HashMap<String, usize>,
    /// Last call addressed by a delta. This is only a fallback for the rare
    /// provider that omits both an index and an ID on a continuation chunk.
    last_tool_call_index: Option<usize>,
    stop_reason: String,
    usage_tokens: u64,
    saw_event: bool,
    saw_done: bool,
    saw_terminal_choice: bool,
}

impl StreamAccumulator {
    /// Some OpenAI-compatible relays stream a series of complete function
    /// names without an `index` or `id`.  Treat a second *known* name as a
    /// new call rather than appending it to the prior call.  Name fragments
    /// (for example `read_` + `file`) remain continuations because their
    /// partial spelling is not a registered tool name.
    fn unindexed_name_starts_new_call(&self, current_index: usize, call: &Value) -> bool {
        let Some(incoming) = call
            .get("function")
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            return false;
        };
        let Some(current) = self.tool_calls.get(current_index) else {
            return false;
        };
        let previous = current.name.trim();
        crate::tools::is_supported_tool_name(previous)
            && crate::tools::is_supported_tool_name(incoming)
            && crate::tools::normalize_tool_name(previous)
                != crate::tools::normalize_tool_name(incoming)
    }

    /// Providers vary between sending function-name deltas and repeatedly
    /// sending the full name.  Keep both wire forms valid without duplicating
    /// a completed name in the accumulated call.
    fn append_tool_name(target: &mut StreamToolCall, incoming: &str) {
        if incoming.is_empty() || target.name == incoming {
            return;
        }
        if !target.name.is_empty() && incoming.starts_with(&target.name) {
            target.name = incoming.to_string();
        } else {
            target.name.push_str(incoming);
        }
    }

    fn resolve_tool_call_index(
        &mut self,
        position: usize,
        call_count: usize,
        call: &Value,
    ) -> usize {
        if let Some(index) = call
            .get("index")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
        {
            if let Some(id) = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                self.tool_call_indices_by_id.insert(id.to_string(), index);
            }
            self.last_tool_call_index = Some(index);
            return index;
        }

        if let Some(id) = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if let Some(index) = self.tool_call_indices_by_id.get(id).copied() {
                self.last_tool_call_index = Some(index);
                return index;
            }

            // A new ID without an index denotes a new tool call. Do not use
            // `position` here: across separate SSE events it is repeatedly
            // zero, which was the source of merged tool names.
            let index = self.tool_calls.len();
            self.tool_call_indices_by_id.insert(id.to_string(), index);
            self.last_tool_call_index = Some(index);
            return index;
        }

        // Without either identifier, a single delta is most likely a
        // continuation of the previous call. A multi-call delta can still be
        // addressed by its array position, matching OpenAI's initial shape.
        let index = if call_count == 1 {
            let current_index = self
                .last_tool_call_index
                .unwrap_or_else(|| self.tool_calls.len().saturating_sub(1));
            if self.unindexed_name_starts_new_call(current_index, call) {
                self.tool_calls.len()
            } else {
                current_index
            }
        } else {
            position
        };
        self.last_tool_call_index = Some(index);
        index
    }

    fn apply(
        &mut self,
        value: &Value,
        on_reasoning: Option<&ReasoningSink>,
        on_content: Option<&ContentSink>,
        on_tool_call: Option<&ToolCallSink>,
    ) {
        if let Some(tokens) = value
            .get("usage")
            .and_then(|usage| usage.get("total_tokens"))
            .and_then(Value::as_u64)
        {
            self.usage_tokens = tokens;
        }

        let Some(choice) = value.get("choices").and_then(|choices| choices.get(0)) else {
            return;
        };
        self.saw_event = true;

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !reason.trim().is_empty() {
                self.stop_reason = reason.to_string();
                self.saw_terminal_choice = true;
            }
        }

        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .unwrap_or(&Value::Null);

        if let Some(content) = delta_string(delta, &["content", "text"]) {
            if !content.is_empty() {
                self.text.push_str(&content);
                if let Some(sink) = on_content {
                    sink(&content);
                }
            }
        }

        if let Some(chunk) = delta_string(
            delta,
            &[
                "reasoning_content",
                "reasoning",
                "thinking",
                "reasoning_text",
            ],
        ) {
            if !chunk.is_empty() {
                self.reasoning.push_str(&chunk);
                if let Some(sink) = on_reasoning {
                    sink(&chunk);
                }
            }
        }

        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                let index = self.resolve_tool_call_index(position, calls.len(), call);
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(StreamToolCall::default());
                }
                let target = &mut self.tool_calls[index];
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if !id.is_empty() {
                        if target.id.is_empty() {
                            target.id = id.to_string();
                        } else if target.id != id && !target.id.ends_with(id) {
                            // A few providers stream an ID in fragments. Keep
                            // supporting that form without duplicating IDs
                            // when a provider repeats the full value.
                            target.id.push_str(id);
                        }
                    }
                }
                let function = call.get("function").unwrap_or(&Value::Null);
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    Self::append_tool_name(target, name);
                }
                // Providers disagree on the wire shape: OpenAI uses a JSON
                // *string* of arguments; some DeepSeek / proxy builds emit a
                // raw object/array chunk. Accept both.
                match function.get("arguments") {
                    Some(Value::String(arguments_delta)) if !arguments_delta.is_empty() => {
                        target.arguments.push_str(arguments_delta);
                        target.preview_arguments.push_str(arguments_delta);
                    }
                    Some(value) if value.is_object() || value.is_array() => {
                        let encoded = value.to_string();
                        target.arguments.push_str(&encoded);
                        target.preview_arguments.push_str(&encoded);
                    }
                    _ => {}
                }
                let name_changed = !target.name.is_empty() && target.name != target.previewed_name;
                if name_changed {
                    if let Some(sink) = on_tool_call {
                        sink(index, &target.name, "");
                    }
                    target.previewed_name.clone_from(&target.name);
                }
                let preview_threshold = if target.previewed_arguments {
                    TOOL_PREVIEW_BATCH_BYTES
                } else {
                    FIRST_TOOL_PREVIEW_BYTES
                };
                if target.preview_arguments.len() >= preview_threshold {
                    if let Some(sink) = on_tool_call {
                        sink(index, &target.name, &target.preview_arguments);
                    }
                    target.preview_arguments.clear();
                    target.previewed_arguments = true;
                }
            }
        }
    }

    fn flush_tool_previews(&mut self, on_tool_call: Option<&ToolCallSink>) {
        let Some(sink) = on_tool_call else {
            return;
        };
        for (index, call) in self.tool_calls.iter_mut().enumerate() {
            if call.preview_arguments.is_empty() {
                continue;
            }
            sink(index, &call.name, &call.preview_arguments);
            call.preview_arguments.clear();
            call.previewed_arguments = true;
        }
    }

    fn completed(&self) -> bool {
        self.saw_done || self.saw_terminal_choice
    }

    fn into_response(self) -> Result<LlmResponse> {
        let completed = self.completed();
        if !completed {
            // A proxy or upstream can close a stream after partial text or a
            // partial tool call. Never execute an incomplete tool payload as
            // if it were valid; return a resumable stop so the host continues
            // the same task with the preserved workspace and conversation.
            return Ok(LlmResponse {
                text: (!self.text.is_empty()).then_some(self.text),
                tool_calls: Vec::new(),
                reasoning_content: (!self.reasoning.is_empty()).then_some(self.reasoning),
                stop_reason: "stream_interrupted".to_string(),
                usage_tokens: self.usage_tokens,
            });
        }
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        let mut skipped_malformed = 0usize;
        for (index, call) in self.tool_calls.into_iter().enumerate() {
            if call.name.is_empty() {
                continue;
            }
            let arguments = match parse_tool_call_arguments(&call.arguments) {
                Ok(value) => value,
                Err(_) => {
                    // DeepSeek Flash (and some proxies) occasionally stream
                    // broken JSON for tool args. Skip the bad call instead of
                    // aborting the whole turn — the agent loop can continue.
                    skipped_malformed += 1;
                    continue;
                }
            };
            tool_calls.push(ToolCall {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                arguments,
            });
        }

        let stop_reason = if tool_calls.is_empty()
            && skipped_malformed > 0
            && self.stop_reason.eq_ignore_ascii_case("tool_calls")
        {
            // Ask the agent loop to retry rather than ending on a dead tool turn.
            "stream_interrupted".to_string()
        } else if self.stop_reason.is_empty() {
            "stop".to_string()
        } else {
            self.stop_reason
        };

        Ok(LlmResponse {
            text: (!self.text.is_empty()).then_some(self.text),
            tool_calls,
            reasoning_content: (!self.reasoning.is_empty()).then_some(self.reasoning),
            stop_reason,
            usage_tokens: self.usage_tokens,
        })
    }
}

/// Parse / lightly repair streamed tool-call argument JSON.
///
/// DeepSeek and a few OpenAI-compatible proxies sometimes emit trailing commas,
/// fenced markdown, or double-encoded JSON strings. Prefer a usable object over
/// failing the entire agent turn.
fn parse_tool_call_arguments(raw: &str) -> Result<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Value::Object(Default::default()));
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(unwrap_json_string_object(value));
    }

    let mut candidate = trimmed.to_string();
    if let Some(stripped) = strip_markdown_fence(&candidate) {
        candidate = stripped;
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            return Ok(unwrap_json_string_object(value));
        }
    }

    if let Some(extracted) = extract_balanced_json(&candidate) {
        candidate = extracted;
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            return Ok(unwrap_json_string_object(value));
        }
    }

    let repaired = repair_trailing_commas(&candidate);
    if repaired != candidate {
        if let Ok(value) = serde_json::from_str::<Value>(&repaired) {
            return Ok(unwrap_json_string_object(value));
        }
        if let Some(extracted) = extract_balanced_json(&repaired) {
            if let Ok(value) = serde_json::from_str::<Value>(&extracted) {
                return Ok(unwrap_json_string_object(value));
            }
        }
    }

    // Last resort: escape bare control characters inside the payload. Some
    // models put real newlines inside JSON string values when writing files.
    let escaped = escape_raw_control_chars_in_json_strings(&repaired);
    if let Ok(value) = serde_json::from_str::<Value>(&escaped) {
        return Ok(unwrap_json_string_object(value));
    }

    Err(anyhow!(
        "invalid_response: The provider streamed malformed tool arguments."
    ))
}

fn unwrap_json_string_object(value: Value) -> Value {
    match value {
        Value::String(inner) => {
            let trimmed = inner.trim();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                serde_json::from_str(trimmed).unwrap_or(Value::String(inner))
            } else if trimmed.is_empty() {
                Value::Object(Default::default())
            } else {
                Value::String(inner)
            }
        }
        Value::Null => Value::Object(Default::default()),
        other => other,
    }
}

fn strip_markdown_fence(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("```") {
        return None;
    }
    let mut lines = trimmed.lines();
    let _ = lines.next()?;
    let mut body = Vec::new();
    for line in lines {
        if line.trim().starts_with("```") {
            break;
        }
        body.push(line);
    }
    let out = body.join("\n").trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_balanced_json(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let start = bytes.iter().position(|b| *b == b'{' || *b == b'[')?;
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (idx, ch) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escape {
                escape = false;
            } else if *ch == b'\\' {
                escape = true;
            } else if *ch == b'"' {
                in_string = false;
            }
            continue;
        }
        match *ch {
            b'"' => in_string = true,
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(raw[start..=idx].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn repair_trailing_commas(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;
    while i < chars.len() {
        let ch = chars[i];
        if in_string {
            out.push(ch);
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn escape_raw_control_chars_in_json_strings(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    let mut in_string = false;
    let mut escape = false;
    for ch in raw.chars() {
        if in_string {
            if escape {
                out.push(ch);
                escape = false;
                continue;
            }
            match ch {
                '\\' => {
                    out.push(ch);
                    escape = true;
                }
                '"' => {
                    out.push(ch);
                    in_string = false;
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                _ => out.push(ch),
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
        }
        out.push(ch);
    }
    out
}

fn apply_sse_line(
    line: &str,
    accumulator: &mut StreamAccumulator,
    on_reasoning: Option<&ReasoningSink>,
    on_content: Option<&ContentSink>,
    on_tool_call: Option<&ToolCallSink>,
) -> Result<()> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
        return Ok(());
    }
    let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
    if data.is_empty() {
        return Ok(());
    }
    if data == "[DONE]" {
        accumulator.saw_done = true;
        return Ok(());
    }
    let value: Value = serde_json::from_str(data)
        .map_err(|_| anyhow!("invalid_response: The provider streamed malformed JSON."))?;
    accumulator.apply(&value, on_reasoning, on_content, on_tool_call);
    Ok(())
}

fn parse_model_ids(text: &str, require_tools: bool, free_only: bool) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: The provider returned malformed model data."))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_response: The provider returned no model list."))?;
    let mut models: Vec<String> = data
        .iter()
        .filter(|model| {
            !require_tools
                || model
                    .get("supported_parameters")
                    .and_then(Value::as_array)
                    .is_some_and(|params| {
                        params.iter().any(|param| param.as_str() == Some("tools"))
                    })
        })
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|model| !free_only || model.ends_with(":free") || *model == "openrouter/free")
        .filter(|model| !model.is_empty() && model.len() <= 200)
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    models.truncate(200);
    Ok(models)
}

pub async fn fetch_model_ids(
    provider_kind: &str,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("network_error: Could not initialize the provider client."))?;
    let is_openrouter = provider_kind == "openrouter" || base_url.contains("openrouter.ai");
    let mut request = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if provider_kind != "ollama" {
        request = request.bearer_auth(api_key);
    }
    if api_key.to_ascii_uppercase().starts_with("HORMA-")
        || base_url.contains("hormachuelos")
        || base_url.contains("/api/v1")
    {
        request = request.header("X-Horma-Provider", provider_kind);
    }
    if is_openrouter {
        request = request
            .query(&[("supported_parameters", "tools")])
            .header("HTTP-Referer", "https://hormachuelos.vercel.app")
            .header("X-Title", "Hormachuelos");
    }
    let response = request
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|_| anyhow!("invalid_response: The provider model list could not be read."))?;
    if !status.is_success() {
        return Err(provider_http_error(status, &text));
    }
    let models = parse_model_ids(&text, is_openrouter, is_openrouter)?;
    if models.is_empty() {
        return Err(anyhow!(
            "no_compatible_models: The provider returned no compatible models."
        ));
    }
    Ok(models)
}

pub struct OpenAi {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
    provider_kind: String,
    reasoning_effort: Option<String>,
}

impl OpenAi {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str, provider_kind: &str) -> Self {
        let default_base = match provider_kind {
            "ollama" => "http://localhost:11434/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            "pollinations" => "https://gen.pollinations.ai/v1",
            "deepseek" => "https://api.deepseek.com",
            "glm" => "https://opencode.ai/zen/v1",
            "cursor" => "https://api.cursor.com/v1",
            "xai" => crate::config::XAI_API_BASE_URL,
            "hormachuelos_free" => "https://hormachuelos.vercel.app/api/v1",
            _ => "https://api.openai.com/v1",
        };
        Self {
            client: build_client(),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or(default_base)
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
            provider_kind: provider_kind.to_string(),
            reasoning_effort: None,
        }
    }

    pub fn with_reasoning_effort(mut self, effort: Option<&str>) -> Self {
        // Store the mapped value so every supported provider actually receives
        // a reasoning_effort the upstream understands.
        self.reasoning_effort =
            Some(normalized_reasoning_effort(&self.provider_kind, effort).into());
        self
    }

    fn skip_auth(&self) -> bool {
        self.provider_kind == "ollama"
    }

    fn is_openrouter(&self) -> bool {
        self.provider_kind == "openrouter" || self.base_url.contains("openrouter.ai")
    }

    fn is_hosted_proxy(&self) -> bool {
        self.api_key.to_ascii_uppercase().starts_with("HORMA-")
            || self.provider_kind.eq_ignore_ascii_case("hormachuelos_free")
            || self.base_url.contains("hormachuelos.vercel.app")
    }
}

#[async_trait::async_trait]
impl LlmProvider for OpenAi {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        on_reasoning: Option<ReasoningSink>,
        on_content: Option<ContentSink>,
        on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let mut body = build_request_body(
            &self.model,
            messages,
            tools,
            &self.provider_kind,
            self.reasoning_effort.as_deref(),
        );
        body["stream"] = Value::Bool(true);

        for attempt in 0..5 {
            let mut request = self
                .client
                .post(format!("{}/chat/completions", self.base_url));
            if !self.skip_auth() {
                request = request.bearer_auth(&self.api_key);
            }
            if self.is_hosted_proxy() {
                request = request.header("X-Horma-Provider", &self.provider_kind);
            }
            if self.is_openrouter() {
                request = request
                    .header("HTTP-Referer", "https://hormachuelos.vercel.app")
                    .header("X-Title", "Hormachuelos");
            }
            let response = match request.json(&body).send().await {
                Ok(response) => response,
                Err(error) => {
                    let err = request_error(&error);
                    if attempt < 4 && is_transient_provider_error(&err) {
                        tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
                        continue;
                    }
                    return Err(err);
                }
            };
            let status = response.status();
            if !status.is_success() {
                let text = response.text().await.map_err(|_| {
                    anyhow!("invalid_response: The provider response could not be read.")
                })?;
                let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
                if retryable && attempt < 4 {
                    tokio::time::sleep(Duration::from_millis(600 * (1 << attempt))).await;
                    continue;
                }
                return Err(provider_http_error(status, &text));
            }

            let mut response = response;
            let mut pending = String::new();
            let mut full_body = String::new();
            let mut accumulator = StreamAccumulator::default();

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| request_error(&error))?
            {
                let text = String::from_utf8_lossy(&chunk);
                full_body.push_str(&text);
                pending.push_str(&text);

                while let Some(newline) = pending.find('\n') {
                    let line = pending[..newline].trim_end_matches('\r').to_string();
                    pending.drain(..=newline);
                    apply_sse_line(
                        &line,
                        &mut accumulator,
                        on_reasoning.as_ref(),
                        on_content.as_ref(),
                        on_tool_call.as_ref(),
                    )?;
                }
            }
            if !pending.trim().is_empty() {
                apply_sse_line(
                    &pending,
                    &mut accumulator,
                    on_reasoning.as_ref(),
                    on_content.as_ref(),
                    on_tool_call.as_ref(),
                )?;
            }

            // Some compatible endpoints ignore `stream: true` and return one
            // ordinary JSON response. Preserve support for those providers.
            if !accumulator.saw_event {
                let body = full_body.trim();
                if is_cut_off_stream_body(body) {
                    return Ok(LlmResponse {
                        text: None,
                        tool_calls: Vec::new(),
                        reasoning_content: None,
                        stop_reason: "stream_interrupted".to_string(),
                        usage_tokens: 0,
                    });
                }
                let parsed = parse_response(body)?;
                if let (Some(reasoning), Some(sink)) =
                    (parsed.reasoning_content.as_deref(), on_reasoning.as_ref())
                {
                    sink(reasoning);
                }
                if let (Some(text), Some(sink)) = (parsed.text.as_deref(), on_content.as_ref()) {
                    sink(text);
                }
                return Ok(parsed);
            }

            if accumulator.completed() {
                accumulator.flush_tool_previews(on_tool_call.as_ref());
            }
            return accumulator.into_response();
        }
        Err(anyhow!(
            "provider_unavailable: The provider did not return a response."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_tool_calls_for_a_second_openai_compatible_turn() {
        let messages = vec![ChatMessage {
            role: "assistant".into(),
            content: Value::Null,
            tool_calls: Some(vec![ToolCall {
                id: "call_123".into(),
                name: "read_file".into(),
                arguments: json!({ "path": "src/main.ts" }),
            }]),
            tool_call_id: None,
            name: None,
            reasoning_content: Some("I should inspect the file first.".into()),
        }];

        let body = build_request_body("deepseek-v4-pro", &messages, &[], "deepseek", None);
        let assistant = &body["messages"][0];

        assert_eq!(assistant["content"], Value::Null);
        assert_eq!(
            assistant["reasoning_content"],
            "I should inspect the file first."
        );
        assert_eq!(assistant["tool_calls"][0]["id"], "call_123");
        assert_eq!(assistant["tool_calls"][0]["type"], "function");
        assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(
            assistant["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"src/main.ts"}"#
        );
        // DeepSeek V4 is a reasoning model: no temperature, effort defaults high.
        assert_eq!(body["temperature"], Value::Null);
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn deepseek_effort_maps_ui_tiers_to_low_high_max() {
        let cases = [
            ("light", "low"),
            ("low", "low"),
            ("medium", "high"),
            ("high", "high"),
            ("xhigh", "max"),
            ("ultra", "max"),
            ("max", "max"),
        ];
        for (ui, upstream) in cases {
            assert_eq!(
                normalized_reasoning_effort("deepseek", Some(ui)),
                upstream,
                "deepseek {ui} should map to {upstream}"
            );
        }
        // xAI caps at high; its medium stays medium.
        assert_eq!(normalized_reasoning_effort("xai", Some("ultra")), "high");
        assert_eq!(normalized_reasoning_effort("xai", Some("medium")), "medium");
    }

    #[test]
    fn omits_temperature_for_reasoning_models() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: json!("Help me improve this project."),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            reasoning_content: None,
        }];

        let body = build_request_body("gpt-5.6-sol", &messages, &[], "openai", None);

        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn xai_grok_uses_supported_reasoning_fields_and_never_marks_the_direct_url_hosted() {
        let messages = vec![ChatMessage::user("Test the integration.")];
        let body = build_request_body("grok-4.5", &messages, &[], "xai", Some("ultra"));

        assert!(body.get("temperature").is_none());
        assert_eq!(body["reasoning_effort"], "high");

        let direct = OpenAi::new(
            "xai-example",
            Some("https://api.x.ai/v1"),
            "grok-4.5",
            "xai",
        );
        assert!(!direct.is_hosted_proxy());
    }

    #[test]
    fn classifies_provider_errors_without_echoing_response_bodies() {
        let secret_body = r#"{"error":{"message":"bad key sk-live-secret"}}"#;
        let error = provider_http_error(reqwest::StatusCode::UNAUTHORIZED, secret_body);

        assert!(error.to_string().contains("authentication_failed"));
        assert!(!error.to_string().contains("sk-live-secret"));
    }

    #[test]
    fn transient_network_errors_are_retryable() {
        assert_eq!(
            reconnect_attempt_limit(&anyhow!(
                "network_error: The provider request could not be completed."
            )),
            Some(6)
        );
        assert_eq!(
            reconnect_attempt_limit(&anyhow!(
                "connection_failed: Could not connect to the provider."
            )),
            Some(0)
        );
        assert_eq!(
            reconnect_attempt_limit(&anyhow!(
                "provider_timeout: The provider did not respond before the timeout."
            )),
            Some(6)
        );
        assert_eq!(
            reconnect_attempt_limit(&anyhow!(
                "provider_unavailable: The provider is temporarily unavailable. (HTTP 502)"
            )),
            Some(10)
        );
        assert!(
            reconnect_attempt_limit(&anyhow!("authentication_failed: Invalid API key.")).is_none()
        );
        assert!(is_transient_provider_error(&anyhow!(
            "network_error: The provider request could not be completed."
        )));
        assert!(!is_transient_provider_error(&anyhow!(
            "authentication_failed: Invalid API key."
        )));
    }

    #[test]
    fn distinguishes_hosted_wallet_402_from_an_upstream_payment_error() {
        let wallet = provider_http_error(
            reqwest::StatusCode::PAYMENT_REQUIRED,
            r#"{"code":"usage_exhausted","error":"Hosted credits exhausted"}"#,
        );
        let upstream = provider_http_error(
            reqwest::StatusCode::PAYMENT_REQUIRED,
            r#"{"error":"upstream account needs credits"}"#,
        );

        assert!(wallet.to_string().contains("usage_exhausted"));
        assert!(upstream.to_string().contains("provider_payment_required"));
    }

    #[test]
    fn parses_reasoning_and_tool_calls_for_replay() {
        let response = parse_response(
            r#"{
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": null,
                    "reasoning_content": "Inspect the project first.",
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": {"name": "list_dir", "arguments": "{\"path\":\".\"}"}
                    }]
                }
            }],
            "usage": {"total_tokens": 42}
        }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("Inspect the project first.")
        );
        assert_eq!(response.tool_calls[0].id, "call_9");
        assert_eq!(response.tool_calls[0].name, "list_dir");
        assert_eq!(response.tool_calls[0].arguments, json!({ "path": "." }));
        assert_eq!(response.usage_tokens, 42);
    }

    #[test]
    fn interrupted_stream_never_executes_a_partial_tool_call() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply(
            &json!({
                "choices": [{
                    "delta": {
                        "content": "I am applying the change...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_partial",
                            "function": {
                                "name": "write_file",
                                "arguments": "{\"path\":\"src/main"
                            }
                        }]
                    }
                }]
            }),
            None,
            None,
            None,
        );

        let response = accumulator.into_response().expect("resumable response");
        assert_eq!(response.stop_reason, "stream_interrupted");
        assert!(response.tool_calls.is_empty());
        assert_eq!(
            response.text.as_deref(),
            Some("I am applying the change...")
        );
    }

    #[test]
    fn reads_object_shaped_reasoning_deltas() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply(
            &json!({
                "choices": [{
                    "delta": {
                        "reasoning": { "content": "The page lists three incident reports." },
                        "content": "Three reports are visible."
                    },
                    "finish_reason": "stop"
                }]
            }),
            None,
            None,
            None,
        );
        let response = accumulator.into_response().expect("parsed");
        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("The page lists three incident reports.")
        );
        assert_eq!(response.text.as_deref(), Some("Three reports are visible."));
    }

    #[test]
    fn accumulates_live_reasoning_and_fragmented_tool_calls() {
        let received = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let received_for_sink = received.clone();
        let sink: ReasoningSink = std::sync::Arc::new(move |chunk| {
            received_for_sink.lock().unwrap().push_str(chunk);
        });
        let previews = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let previews_for_sink = previews.clone();
        let tool_sink: ToolCallSink = std::sync::Arc::new(move |index, name, arguments_delta| {
            previews_for_sink.lock().unwrap().push((
                index,
                name.to_string(),
                arguments_delta.to_string(),
            ));
        });
        let mut stream = StreamAccumulator::default();

        for line in [
            r#"data: {"choices":[{"delta":{"reasoning_content":"Inspect "}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_content":"files.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\"path\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\"src/"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"main.ts\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":17}}"#,
            "data: [DONE]",
        ] {
            apply_sse_line(line, &mut stream, Some(&sink), None, Some(&tool_sink))
                .expect("valid SSE fixture");
        }

        stream.flush_tool_previews(Some(&tool_sink));
        let response = stream.into_response().expect("stream should assemble");
        assert_eq!(*received.lock().unwrap(), "Inspect files.");
        assert_eq!(
            *previews.lock().unwrap(),
            vec![
                (0, "read_".to_string(), String::new()),
                (0, "read_file".to_string(), String::new()),
                (
                    0,
                    "read_file".to_string(),
                    r#"{"path":"src/main.ts"}"#.to_string(),
                ),
            ]
        );
        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("Inspect files.")
        );
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(
            response.tool_calls[0].arguments,
            json!({ "path": "src/main.ts" })
        );
        assert_eq!(response.usage_tokens, 17);
    }

    #[test]
    fn keeps_distinct_tool_calls_separate_when_a_provider_omits_indexes() {
        let mut stream = StreamAccumulator::default();
        for event in [
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "id": "call_list",
                            "function": { "name": "list_dir", "arguments": "{\"path\":\".\"}" }
                        }]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "id": "call_glob",
                            "function": { "name": "glob", "arguments": "{\"pattern\":\"**/*\"}" }
                        }]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "id": "call_git",
                            "function": { "name": "git_status", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
        ] {
            stream.apply(&event, None, None, None);
        }

        let response = stream.into_response().expect("stream should assemble");
        assert_eq!(response.tool_calls.len(), 3);
        assert_eq!(
            response
                .tool_calls
                .iter()
                .map(|call| call.name.as_str())
                .collect::<Vec<_>>(),
            vec!["list_dir", "glob", "git_status"]
        );
        assert_eq!(response.tool_calls[0].arguments, json!({ "path": "." }));
        assert_eq!(
            response.tool_calls[1].arguments,
            json!({ "pattern": "**/*" })
        );
        assert_eq!(response.tool_calls[2].arguments, json!({}));
    }

    #[test]
    fn keeps_name_only_tool_calls_separate_without_indexes_or_ids() {
        let mut stream = StreamAccumulator::default();
        for event in [
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "name": "list_dir", "arguments": "{\"path\":\".\"}" }
                        }]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "name": "glob", "arguments": "{\"pattern\":\"**/*\"}" }
                        }]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "name": "git_status", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
        ] {
            stream.apply(&event, None, None, None);
        }

        let response = stream.into_response().expect("stream should assemble");
        assert_eq!(response.tool_calls.len(), 3);
        assert_eq!(
            response
                .tool_calls
                .iter()
                .map(|call| call.name.as_str())
                .collect::<Vec<_>>(),
            vec!["list_dir", "glob", "git_status"]
        );
        assert_eq!(response.tool_calls[0].arguments, json!({ "path": "." }));
        assert_eq!(
            response.tool_calls[1].arguments,
            json!({ "pattern": "**/*" })
        );
        assert_eq!(response.tool_calls[2].arguments, json!({}));
    }

    #[test]
    fn accepts_repeated_full_name_deltas_without_duplication() {
        let mut stream = StreamAccumulator::default();
        for event in [
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "name": "read_file", "arguments": "{\"path\":" }
                        }]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "name": "read_file", "arguments": "\"src/main.ts\"}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
        ] {
            stream.apply(&event, None, None, None);
        }

        let response = stream.into_response().expect("stream should assemble");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(
            response.tool_calls[0].arguments,
            json!({ "path": "src/main.ts" })
        );
    }

    #[test]
    fn batches_large_tool_argument_previews_before_completion() {
        let previews = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let previews_for_sink = previews.clone();
        let tool_sink: ToolCallSink = std::sync::Arc::new(move |index, name, delta| {
            previews_for_sink
                .lock()
                .unwrap()
                .push((index, name.to_string(), delta.to_string()));
        });
        let argument_delta = format!(r#"{{"path":"game.js","content":"{}"#, "x".repeat(80));
        let event = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": {
                            "name": "write_file",
                            "arguments": argument_delta,
                        }
                    }]
                }
            }]
        });
        let mut stream = StreamAccumulator::default();

        stream.apply(&event, None, None, Some(&tool_sink));

        let received = previews.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0], (0, "write_file".to_string(), String::new()));
        assert_eq!(received[1].0, 0);
        assert_eq!(received[1].1, "write_file");
        assert!(received[1].2.contains(r#""content":"#));
        assert!(stream.tool_calls[0].preview_arguments.is_empty());
    }

    #[test]
    fn discovers_only_tool_capable_openrouter_models() {
        let fixture = r#"{"data":[
            {"id":"tool/model:free","supported_parameters":["tools","temperature"]},
            {"id":"text/model:free","supported_parameters":["temperature"]},
            {"id":"tool/paid","supported_parameters":["tools"]}
        ]}"#;

        let models = parse_model_ids(fixture, true, true).expect("fixture should parse");
        assert_eq!(models, vec!["tool/model:free"]);
    }

    #[test]
    fn repairs_deepseek_style_malformed_tool_arguments() {
        let trailing =
            parse_tool_call_arguments(r#"{"path":"index.html","content":"<h1>Hi</h1>",}"#)
                .expect("trailing comma should repair");
        assert_eq!(trailing["path"], "index.html");

        let fenced = parse_tool_call_arguments("```json\n{\"path\":\".\"}\n```")
            .expect("fenced json should parse");
        assert_eq!(fenced["path"], ".");

        let with_newline =
            parse_tool_call_arguments("{\"path\":\"a.js\",\"content\":\"line1\nline2\"}")
                .expect("raw newline in string should escape");
        assert_eq!(with_newline["content"], "line1\nline2");

        let wrapped = parse_tool_call_arguments("Sure. {\"path\":\"src/app.js\"} thanks")
            .expect("balanced extract should work");
        assert_eq!(wrapped["path"], "src/app.js");
    }

    #[test]
    fn malformed_streamed_tool_args_do_not_abort_the_turn() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply(
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_bad",
                            "function": {
                                "name": "write_file",
                                "arguments": "{\"path\":\"x.html\",\"content\":\"oops\","
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            None,
            None,
            None,
        );
        let response = accumulator.into_response().expect("should not hard-fail");
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.stop_reason, "stream_interrupted");
    }

    #[test]
    fn accepts_object_shaped_streamed_tool_arguments() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply(
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_obj",
                            "function": {
                                "name": "list_dir",
                                "arguments": { "path": "." }
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            None,
            None,
            None,
        );
        let response = accumulator.into_response().expect("object args ok");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].arguments, json!({ "path": "." }));
    }

    #[test]
    fn cut_off_stream_bodies_are_interruptions_not_malformed_json() {
        // Empty body — proxy relay died before any event.
        assert!(is_cut_off_stream_body(""));
        assert!(is_cut_off_stream_body("   \n  "));
        // Non-JSON body (proxy error page / plain text) is also a cut-off.
        assert!(is_cut_off_stream_body("upstream error"));
        assert!(is_cut_off_stream_body("<html>gateway</html>"));
        // A JSON error object (upstream/gateway failure) is not a usable
        // completion — treat it as a resumable interruption.
        assert!(is_cut_off_stream_body(r#"{"error":{"message":"boom"}}"#));
        assert!(is_cut_off_stream_body(r#"{"error":"bad gateway"}"#));
        // Ordinary JSON responses are still parsed, not treated as cut-offs.
        assert!(!is_cut_off_stream_body(r#"{"choices":[]}"#));
        assert!(!is_cut_off_stream_body(
            r#"{"choices":[{"message":{"content":"hi"}}],"error":null}"#
        ));
    }
}
