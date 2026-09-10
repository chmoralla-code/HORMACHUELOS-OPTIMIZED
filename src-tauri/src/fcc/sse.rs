//! Anthropic-Messages SSE builder — port of FCC `core/anthropic/sse.py`.
//!
//! Canonical event order per turn:
//! `message_start` → ordered content blocks (thinking/text/tool_use, monotonic
//! indices, thinking↔text mutually exclusive, all closed before the first tool
//! block) → `message_delta` → `message_stop`. An empty stream emits a single
//! `" "` text block (Claude compat). Error tails: text error block when no
//! tool block started, otherwise top-level `event: error`.

use serde_json::{json, Value};
use std::collections::HashMap;

/// Map an OpenAI `finish_reason` to an Anthropic `stop_reason`.
/// Port of `STOP_REASON_MAP` + `map_stop_reason`.
pub fn map_stop_reason(openai_reason: Option<&str>) -> &'static str {
    match openai_reason {
        Some("length") => "max_tokens",
        Some("tool_calls") => "tool_use",
        Some("stop") | Some("content_filter") | None => "end_turn",
        Some(_) => "end_turn",
    }
}

/// Format one Anthropic-style SSE event.
pub fn format_sse_event(event_type: &str, data: &Value) -> String {
    format!("event: {event_type}\ndata: {}\n\n", data)
}

/// Per-tool-call stream state. Port of `ToolCallState`.
#[derive(Debug, Default, Clone)]
pub struct ToolCallState {
    pub block_index: i64,
    pub tool_id: String,
    pub name: String,
    pub extra_content: Option<Value>,
    pub contents: Vec<String>,
    pub started: bool,
    pub task_arg_buffer: String,
    pub task_args_emitted: bool,
    pub pre_start_args: String,
}

/// Monotonic block index manager. Port of `ContentBlockManager`.
#[derive(Debug, Default)]
pub struct ContentBlockManager {
    pub next_index: i64,
    pub thinking_index: i64,
    pub text_index: i64,
    pub thinking_started: bool,
    pub text_started: bool,
    pub tool_states: HashMap<i64, ToolCallState>,
}

impl ContentBlockManager {
    pub fn new() -> Self {
        Self {
            next_index: 0,
            thinking_index: -1,
            text_index: -1,
            ..Default::default()
        }
    }

    pub fn allocate_index(&mut self) -> i64 {
        let idx = self.next_index;
        self.next_index += 1;
        idx
    }

    pub fn ensure_tool_state(&mut self, index: i64) -> &mut ToolCallState {
        self.tool_states.entry(index).or_insert_with(|| ToolCallState {
            block_index: -1,
            ..Default::default()
        })
    }

    /// Record an OpenAI tool-call id that arrives before `content_block_start`.
    pub fn set_stream_tool_id(&mut self, index: i64, tool_id: Option<&str>) {
        let Some(id) = tool_id.filter(|s| !s.is_empty()) else {
            return;
        };
        self.ensure_tool_state(index).tool_id = id.to_string();
    }

    /// Merge possibly-split tool names conservatively. Port of
    /// `register_tool_name`: later chunks may extend (`ab` + `c`) or repeat
    /// prefixes, so only adopt extensions or non-overlapping continuations.
    pub fn register_tool_name(&mut self, index: i64, name: &str) {
        let state = self.ensure_tool_state(index);
        let prev = state.name.clone();
        if prev.is_empty() || name.starts_with(&prev) {
            state.name = name.to_string();
        } else if !prev.starts_with(name) {
            state.name = format!("{prev}{name}");
        }
    }

    /// Buffer `Task` args until they form valid JSON, forcing
    /// `run_in_background = false` (single shared FCC rule).
    pub fn buffer_task_args(&mut self, index: i64, args: &str) -> Option<Value> {
        let state = self.tool_states.get_mut(&index)?;
        if state.task_args_emitted {
            return None;
        }
        state.task_arg_buffer.push_str(args);
        let mut parsed: Value = serde_json::from_str(&state.task_arg_buffer).ok()?;
        normalize_task_run_in_background(&mut parsed);
        state.task_args_emitted = true;
        state.task_arg_buffer.clear();
        Some(parsed)
    }

    pub fn has_emitted_tool_block(&self) -> bool {
        self.tool_states.values().any(|s| s.started)
    }

    /// Flush un-emitted `Task` buffers at stream end (invalid JSON → `{}`).
    pub fn flush_task_arg_buffers(&mut self) -> Vec<(i64, String)> {
        let mut out = Vec::new();
        for (index, state) in self.tool_states.iter_mut() {
            if state.task_arg_buffer.is_empty() || state.task_args_emitted {
                continue;
            }
            let rendered = match serde_json::from_str::<Value>(&state.task_arg_buffer) {
                Ok(mut v) => {
                    normalize_task_run_in_background(&mut v);
                    v.to_string()
                }
                Err(_) => "{}".to_string(),
            };
            state.task_args_emitted = true;
            state.task_arg_buffer.clear();
            out.push((*index, rendered));
        }
        out
    }
}

/// Force Task subagents to run in the foreground. Port of
/// `_normalize_task_run_in_background`.
pub fn normalize_task_run_in_background(args: &mut Value) {
    if let Some(obj) = args.as_object_mut() {
        let needs = !matches!(obj.get("run_in_background"), Some(Value::Bool(false)));
        if needs {
            obj.insert("run_in_background".to_string(), Value::Bool(false));
        }
    }
}

/// Builder for one assistant turn's Anthropic SSE stream. Port of `SSEBuilder`.
pub struct SseBuilder {
    pub message_id: String,
    pub model: String,
    pub input_tokens: u64,
    pub blocks: ContentBlockManager,
    accumulated_text: Vec<String>,
    accumulated_reasoning: Vec<String>,
}

impl SseBuilder {
    pub fn new(message_id: &str, model: &str, input_tokens: u64) -> Self {
        Self {
            message_id: message_id.to_string(),
            model: model.to_string(),
            input_tokens,
            blocks: ContentBlockManager::new(),
            accumulated_text: Vec::new(),
            accumulated_reasoning: Vec::new(),
        }
    }

    pub fn message_start(&self) -> String {
        format_sse_event(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": { "input_tokens": self.input_tokens, "output_tokens": 1 },
                },
            }),
        )
    }

    pub fn message_delta(&self, stop_reason: &str, output_tokens: u64) -> String {
        format_sse_event(
            "message_delta",
            &json!({
                "type": "message_delta",
                "delta": { "stop_reason": stop_reason, "stop_sequence": Value::Null },
                "usage": { "input_tokens": self.input_tokens, "output_tokens": output_tokens },
            }),
        )
    }

    pub fn message_stop() -> String {
        format_sse_event("message_stop", &json!({ "type": "message_stop" }))
    }

    pub fn content_block_start(&self, index: i64, block_type: &str, extra: Value) -> String {
        let mut block = json!({ "type": block_type });
        match block_type {
            "thinking" => {
                block["thinking"] = extra.get("thinking").cloned().unwrap_or(Value::String(String::new()));
            }
            "text" => {
                block["text"] = extra.get("text").cloned().unwrap_or(Value::String(String::new()));
            }
            "tool_use" => {
                block["id"] = extra.get("id").cloned().unwrap_or(Value::String(String::new()));
                block["name"] = extra.get("name").cloned().unwrap_or(Value::String(String::new()));
                block["input"] = extra.get("input").cloned().unwrap_or(json!({}));
                if let Some(ec) = extra.get("extra_content") {
                    if ec.is_object() {
                        block["extra_content"] = ec.clone();
                    }
                }
            }
            _ => {}
        }
        format_sse_event(
            "content_block_start",
            &json!({ "type": "content_block_start", "index": index, "content_block": block }),
        )
    }

    pub fn content_block_delta(&self, index: i64, delta_type: &str, content: &str) -> String {
        let mut delta = json!({ "type": delta_type });
        match delta_type {
            "thinking_delta" => delta["thinking"] = Value::String(content.to_string()),
            "text_delta" => delta["text"] = Value::String(content.to_string()),
            "input_json_delta" => delta["partial_json"] = Value::String(content.to_string()),
            _ => {}
        }
        format_sse_event(
            "content_block_delta",
            &json!({ "type": "content_block_delta", "index": index, "delta": delta }),
        )
    }

    pub fn content_block_stop(&self, index: i64) -> String {
        format_sse_event(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": index }),
        )
    }

    /// Close an open text block, then open thinking (FCC mutual exclusion).
    pub fn ensure_thinking_block(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if self.blocks.text_started {
            self.blocks.text_started = false;
            events.push(self.content_block_stop(self.blocks.text_index));
        }
        if !self.blocks.thinking_started {
            let idx = self.blocks.allocate_index();
            self.blocks.thinking_index = idx;
            self.blocks.thinking_started = true;
            events.push(self.content_block_start(idx, "thinking", json!({})));
        }
        events
    }

    /// Close an open thinking block, then open text (FCC mutual exclusion).
    pub fn ensure_text_block(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if self.blocks.thinking_started {
            self.blocks.thinking_started = false;
            events.push(self.content_block_stop(self.blocks.thinking_index));
        }
        if !self.blocks.text_started {
            let idx = self.blocks.allocate_index();
            self.blocks.text_index = idx;
            self.blocks.text_started = true;
            events.push(self.content_block_start(idx, "text", json!({})));
        }
        events
    }

    pub fn emit_thinking_delta(&mut self, content: &str) -> String {
        self.accumulated_reasoning.push(content.to_string());
        self.content_block_delta(self.blocks.thinking_index, "thinking_delta", content)
    }

    pub fn emit_text_delta(&mut self, content: &str) -> String {
        self.accumulated_text.push(content.to_string());
        self.content_block_delta(self.blocks.text_index, "text_delta", content)
    }

    pub fn close_content_blocks(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if self.blocks.thinking_started {
            self.blocks.thinking_started = false;
            events.push(self.content_block_stop(self.blocks.thinking_index));
        }
        if self.blocks.text_started {
            self.blocks.text_started = false;
            events.push(self.content_block_stop(self.blocks.text_index));
        }
        events
    }

    pub fn close_all_blocks(&mut self) -> Vec<String> {
        let mut events = self.close_content_blocks();
        let started: Vec<i64> = self
            .blocks
            .tool_states
            .iter()
            .filter(|(_, s)| s.started)
            .map(|(i, _)| *i)
            .collect();
        for index in started {
            if let Some(state) = self.blocks.tool_states.get(&index) {
                events.push(self.content_block_stop(state.block_index));
            }
        }
        events
    }

    pub fn start_tool_block(
        &mut self,
        tool_index: i64,
        tool_id: &str,
        name: &str,
        extra_content: Option<Value>,
    ) -> String {
        let block_idx = self.blocks.allocate_index();
        let state = self.blocks.ensure_tool_state(tool_index);
        state.block_index = block_idx;
        state.tool_id = tool_id.to_string();
        if extra_content.is_some() {
            state.extra_content = extra_content.clone();
        }
        state.started = true;
        let mut extra = json!({ "id": tool_id, "name": name });
        if let Some(ec) = extra_content {
            extra["extra_content"] = ec;
        }
        self.content_block_start(block_idx, "tool_use", extra)
    }

    pub fn emit_tool_delta(&mut self, tool_index: i64, partial_json: &str) -> String {
        let block_idx = self.blocks.tool_states.get_mut(&tool_index).map(|state| {
            state.contents.push(partial_json.to_string());
            state.block_index
        }).unwrap_or(-1);
        self.content_block_delta(block_idx, "input_json_delta", partial_json)
    }

    /// Text error block (used when no tool block started yet).
    pub fn emit_error_block(&mut self, message: &str) -> Vec<String> {
        let idx = self.blocks.allocate_index();
        vec![
            self.content_block_start(idx, "text", json!({})),
            self.content_block_delta(idx, "text_delta", message),
            self.content_block_stop(idx),
        ]
    }

    /// Top-level `event: error` (used only after a tool block started).
    pub fn emit_top_level_error(message: &str) -> String {
        format_sse_event(
            "error",
            &json!({ "type": "error", "error": { "type": "api_error", "message": message } }),
        )
    }

    pub fn accumulated_text(&self) -> String {
        self.accumulated_text.concat()
    }

    /// Output-token estimate (FCC `len // 4` fallback: no tiktoken in Rust).
    pub fn estimate_output_tokens(&self) -> u64 {
        let text: usize = self.accumulated_text.iter().map(|s| s.len()).sum();
        let reasoning: usize = self.accumulated_reasoning.iter().map(|s| s.len()).sum();
        let tools = self
            .blocks
            .tool_states
            .values()
            .filter(|s| s.started)
            .count() as u64
            * 50;
        (text / 4 + reasoning / 4) as u64 + tools
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_reason_mapping_matches_fcc() {
        assert_eq!(map_stop_reason(Some("stop")), "end_turn");
        assert_eq!(map_stop_reason(Some("length")), "max_tokens");
        assert_eq!(map_stop_reason(Some("tool_calls")), "tool_use");
        assert_eq!(map_stop_reason(Some("content_filter")), "end_turn");
        assert_eq!(map_stop_reason(None), "end_turn");
    }

    #[test]
    fn thinking_and_text_are_mutually_exclusive() {
        let mut b = SseBuilder::new("msg_1", "m", 10);
        let e1 = b.ensure_text_block();
        assert_eq!(e1.len(), 1);
        let e2 = b.ensure_thinking_block();
        assert_eq!(e2.len(), 2);
        assert!(b.blocks.thinking_started && !b.blocks.text_started);
    }

    #[test]
    fn split_tool_names_merge_conservatively() {
        let mut b = SseBuilder::new("msg_1", "m", 10);
        b.blocks.register_tool_name(0, "read");
        b.blocks.register_tool_name(0, "read_file");
        assert_eq!(b.blocks.tool_states[&0].name, "read_file");
        b.blocks.register_tool_name(0, "read_file");
        assert_eq!(b.blocks.tool_states[&0].name, "read_file");
    }

    #[test]
    fn task_args_force_foreground_on_valid_json() {
        let mut b = SseBuilder::new("msg_1", "m", 10);
        assert!(b.blocks.buffer_task_args(0, r#"{"a":1"#).is_none());
        let v = b.blocks.buffer_task_args(0, r#", "run_in_background": true}"#).unwrap();
        assert_eq!(v["run_in_background"], Value::Bool(false));
    }
}
