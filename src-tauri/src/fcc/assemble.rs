//! OpenAI-delta → Anthropic tool-block assembly.
//! Port of FCC `providers/transports/openai_chat/tool_calls.py`
//! (`OpenAIToolCallAssembler`) + `core/anthropic/stream_recovery.py`
//! JSON-repair helpers (append-only suffix).

use serde_json::Value;

use super::sse::SseBuilder;

/// One OpenAI `delta.tool_calls[]` entry (already JSON-decoded).
#[derive(Debug, Default, Clone)]
pub struct ToolCallDelta {
    pub index: i64,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: String,
    pub extra_content: Option<Value>,
}

/// Try to complete truncated tool-call JSON with an append-only suffix.
/// Port of FCC `accept_tool_json_repair`: only closers are appended, never
/// rewritten content.
pub fn repair_tool_json_append_only(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut candidate = trimmed.to_string();
    for closer in ["", "}", "}}", "]", "]}", "\"}", "\"}}"] {
        let attempt = format!("{candidate}{closer}");
        if serde_json::from_str::<Value>(&attempt).is_ok() {
            if closer.is_empty() {
                return Some(attempt);
            }
            candidate = attempt;
            return Some(candidate);
        }
    }
    None
}

/// Validate one assembled tool input against its schema (unknown tools pass).
/// Port of FCC `validate_tool_input` / `parse_complete_tool_input` (shape
/// check only: schema `{type: object, required: [...]}`).
pub fn tool_input_valid(raw: &str, schema: Option<&Value>) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Some(schema) = schema else {
        return true;
    };
    if schema.get("type").and_then(|t| t.as_str()) == Some("object") && !value.is_object() {
        return false;
    }
    if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
        let obj = value.as_object().map(|o| o as &serde_json::Map<String, Value>);
        for key in required.iter().filter_map(|k| k.as_str()) {
            let present = obj.map(|o| o.contains_key(key)).unwrap_or(false);
            if !present {
                return false;
            }
        }
    }
    true
}

/// Assemble one tool-call delta into Anthropic SSE events.
/// Mirrors `OpenAIToolCallAssembler.process_tool_call`:
/// split-name merge, pre-name id record, pre-start arg buffering,
/// `Task` JSON buffering with foreground forcing, alias restore.
pub fn process_tool_call(
    sse: &mut SseBuilder,
    tc: &ToolCallDelta,
    tool_argument_aliases: &std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    alias_buffers: &mut std::collections::HashMap<i64, String>,
) -> Vec<String> {
    let mut events = Vec::new();
    let index = if tc.index < 0 {
        sse.blocks.tool_states.len() as i64
    } else {
        tc.index
    };

    sse.blocks.set_stream_tool_id(index, tc.id.as_deref());
    if let Some(ec) = tc.extra_content.clone() {
        if ec.is_object() {
            sse.blocks.ensure_tool_state(index).extra_content = Some(ec);
        }
    }
    if let Some(name) = tc.name.as_deref() {
        sse.blocks.register_tool_name(index, name);
    }

    let state = sse.blocks.tool_states.get(&index).cloned().unwrap_or_default();
    let resolved_name = if state.name.is_empty() {
        tc.name.clone().unwrap_or_default()
    } else {
        state.name.clone()
    };
    let resolved_id = if state.tool_id.is_empty() {
        tc.id.clone().unwrap_or_default()
    } else {
        state.tool_id.clone()
    };

    if !state.started {
        if resolved_name.trim().is_empty() {
            if !tc.arguments.is_empty() {
                sse.blocks.ensure_tool_state(index).pre_start_args.push_str(&tc.arguments);
            }
            return events;
        }
        let tool_id = if resolved_id.is_empty() {
            format!("tool_{}", uuid_simple())
        } else {
            resolved_id
        };
        let extra = state.extra_content.clone().or(tc.extra_content.clone());
        events.push(sse.start_tool_block(index, &tool_id, resolved_name.trim(), extra));
        let pre = sse.blocks.tool_states.get_mut(&index).map(|s| std::mem::take(&mut s.pre_start_args)).unwrap_or_default();
        if !pre.is_empty() {
            events.extend(emit_arg_delta(sse, index, &pre, tool_argument_aliases, alias_buffers));
        }
    }

    if tc.arguments.is_empty() {
        return events;
    }
    events.extend(emit_arg_delta(sse, index, &tc.arguments, tool_argument_aliases, alias_buffers));
    events
}

fn emit_arg_delta(
    sse: &mut SseBuilder,
    index: i64,
    args: &str,
    aliases: &std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    alias_buffers: &mut std::collections::HashMap<i64, String>,
) -> Vec<String> {
    let name = sse.blocks.tool_states.get(&index).map(|s| s.name.clone()).unwrap_or_default();
    if name == "Task" {
        if let Some(parsed) = sse.blocks.buffer_task_args(index, args) {
            return vec![sse.emit_tool_delta(index, &parsed.to_string())];
        }
        return vec![];
    }
    let empty = std::collections::HashMap::new();
    let alias_map = aliases.get(&name).unwrap_or(&empty);
    if alias_map.is_empty() {
        return vec![sse.emit_tool_delta(index, args)];
    }
    let buffered = format!("{}{}", alias_buffers.get(&index).cloned().unwrap_or_default(), args);
    match restore_aliased_arguments(&buffered, alias_map) {
        Some(restored) => {
            alias_buffers.remove(&index);
            vec![sse.emit_tool_delta(index, &restored)]
        }
        None => {
            alias_buffers.insert(index, buffered);
            vec![]
        }
    }
}

fn restore_aliased_arguments(raw: &str, aliases: &std::collections::HashMap<String, String>) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    Some(restore_value(parsed, aliases).to_string())
}

fn restore_value(value: Value, aliases: &std::collections::HashMap<String, String>) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (aliases.get(&k).cloned().unwrap_or(k), restore_value(v, aliases)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| restore_value(v, aliases)).collect()),
        other => other,
    }
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}

/// True when every started tool block has schema-valid input.
/// Port of FCC `all_started_tools_complete` (salvage gate).
pub fn all_started_tools_complete(sse: &SseBuilder, schemas: &std::collections::HashMap<String, Value>) -> bool {
    let mut any = false;
    for state in sse.blocks.tool_states.values().filter(|s| s.started) {
        any = true;
        let raw: String = state.contents.concat();
        let complete = match repair_tool_json_append_only(&raw).as_deref().unwrap_or(&raw) {
            full if serde_json::from_str::<Value>(full).is_ok() => {
                tool_input_valid(full, schemas.get(&state.name))
            }
            _ => false,
        };
        if !complete {
            return false;
        }
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_only_appends_closers() {
        assert_eq!(
            repair_tool_json_append_only(r#"{"path": "a"#),
            Some(r#"{"path": "a"}"#.to_string())
        );
        assert!(repair_tool_json_append_only("not json at all {{{").is_none());
    }

    #[test]
    fn required_schema_fields_are_enforced() {
        let schema = serde_json::json!({ "type": "object", "required": ["path"] });
        assert!(tool_input_valid(r#"{"path": "x"}"#, Some(&schema)));
        assert!(!tool_input_valid(r#"{"other": 1}"#, Some(&schema)));
        assert!(tool_input_valid(r#"{"anything": 1}"#, None));
    }

    #[test]
    fn pre_start_args_flush_after_name_arrives() {
        let mut sse = SseBuilder::new("m", "model", 0);
        let aliases = Default::default();
        let mut buffers = Default::default();
        let e0 = process_tool_call(&mut sse, &ToolCallDelta { index: 0, id: Some("t1".into()), name: None, arguments: r#"{"path":"#.into(), extra_content: None }, &aliases, &mut buffers);
        assert!(e0.is_empty());
        let e1 = process_tool_call(&mut sse, &ToolCallDelta { index: 0, id: Some("t1".into()), name: Some("read_file".into()), arguments: r#""a"}"#.into(), extra_content: None }, &aliases, &mut buffers);
        assert!(e1.iter().any(|e| e.contains("content_block_start")));
        assert!(e1.iter().any(|e| e.contains("input_json_delta")));
    }
}
