use crate::llm::{
    build_client, request_error, ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink,
    ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// Command Code's hosted chat endpoint. It speaks NDJSON (one JSON object per
/// line) instead of OpenAI's SSE `data:` framing, and wraps the OpenAI-style
/// parameters in an envelope: `{ config, memory, params: { model, messages,
/// tools, system, max_tokens, stream, temperature } }`.
const GENERATE_ENDPOINT: &str = "/alpha/generate";
const MAX_OUTPUT_TOKENS: u64 = 64_000;

/// Version the desktop advertises to the Command Code gateway. The server
/// rejects clients below its `minVersion` (0.18.x), so keep this current.
const COMMAND_CODE_CLIENT_VERSION: &str = "1.14.1";

fn event_delta_text(value: &Value) -> Option<&str> {
    ["text", "delta", "content"]
        .iter()
        .find_map(|key| {
            value.get(*key).and_then(|field| {
                field.as_str().or_else(|| {
                    field
                        .get("text")
                        .or_else(|| field.get("content"))
                        .and_then(Value::as_str)
                })
            })
        })
        .filter(|text| !text.is_empty())
}

/// Build the `config` block the gateway validates. It describes the working
/// directory to the model; values are informational context, not credentials.
fn build_config(project_root: &str) -> Value {
    let mut structure: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(project_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            structure.push(name);
        }
    }
    structure.sort();
    structure.truncate(64);

    let is_git = std::path::Path::new(project_root).join(".git").exists();
    let (current_branch, main_branch, git_status, recent_commits) = if is_git {
        (
            String::new(),
            String::new(),
            String::from("Working tree clean"),
            Vec::<String>::new(),
        )
    } else {
        (
            String::new(),
            String::new(),
            String::new(),
            Vec::<String>::new(),
        )
    };

    json!({
        "workingDir": project_root,
        "date": chrono::Utc::now().format("%Y-%m-%d").to_string(),
        "environment": std::env::consts::OS,
        "structure": structure,
        "isGitRepo": is_git,
        "currentBranch": current_branch,
        "mainBranch": main_branch,
        "gitStatus": git_status,
        "recentCommits": recent_commits,
    })
}

/// Static catalog of model ids accepted by the Command Code gateway. Kept
/// small and aligned with the CLI's `--list-models` output.
pub const KNOWN_MODELS: &[&str] = &[
    "gpt-5.6-luna",
    "moonshotai/Kimi-K3",
    "thinkingmachines/inkling",
    "thinkingmachines/inkling-small",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "moonshotai/Kimi-K2.7-Code",
    "moonshotai/Kimi-K2.7-Code-Highspeed",
    "moonshotai/Kimi-K2.6",
    "moonshotai/Kimi-K2.5",
    "zai-org/GLM-5.2",
    "zai-org/GLM-5.2-Fast",
    "zai-org/GLM-5.1",
    "zai-org/GLM-5",
    "MiniMaxAI/MiniMax-M3",
    "MiniMaxAI/MiniMax-M2.7",
    "MiniMaxAI/MiniMax-M2.5",
    "xiaomi/mimo-v2.5-pro",
    "xiaomi/mimo-v2.5",
    "Qwen/Qwen3.6-Max-Preview",
    "Qwen/Qwen3.6-Plus",
    "Qwen/Qwen3.7-Max",
    "Qwen/Qwen3.7-Plus",
    "Qwen/Qwen3.8-Max",
    "Qwen/Qwen3.7-Flash",
    "stepfun/Step-3.7-Flash",
    "stepfun/Step-3.5-Flash",
    "tencent/hy3-paid",
    "xai/grok-4.5",
    "meta/muse-spark-1.2",
    "meta/muse-spark-1.2-contributor",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "poolside/laguna-s-2.1-free",
];

/// Encode a single assistant/user/tool message into Command Code's wire
/// content-block format.
fn encode_message(message: &ChatMessage) -> Option<Value> {
    match message.role.as_str() {
        "user" => {
            let text = message.content.as_str().unwrap_or("").to_string();
            if text.trim().is_empty() {
                return None;
            }
            Some(json!({ "role": "user", "content": [{ "type": "text", "text": text }] }))
        }
        "assistant" => {
            let mut blocks = Vec::new();
            if let Some(text) = message.content.as_str() {
                if !text.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
            }
            if let Some(reasoning) = &message.reasoning_content {
                if !reasoning.trim().is_empty() {
                    blocks.push(json!({ "type": "reasoning", "text": reasoning }));
                }
            }
            if let Some(calls) = &message.tool_calls {
                for call in calls {
                    blocks.push(json!({
                        "type": "tool-call",
                        "toolCallId": call.id,
                        "toolName": call.name,
                        "input": call.arguments,
                    }));
                }
            }
            if blocks.is_empty() {
                return None;
            }
            Some(json!({ "role": "assistant", "content": blocks }))
        }
        "tool" => {
            let content = message.content.as_str().unwrap_or("");
            let id = message
                .tool_call_id
                .as_deref()
                .unwrap_or("tool")
                .to_string();
            let name = message.name.as_deref().unwrap_or("").to_string();
            Some(json!({
                "role": "tool",
                "content": [{
                    "type": "tool-result",
                    "toolCallId": id,
                    "toolName": name,
                    "output": { "type": "text", "value": content },
                }],
            }))
        }
        _ => None,
    }
}

/// Convert AI-Forge's OpenAI-style tool schemas (`{type:"function",
/// function:{name,description,parameters}}`) into Command Code's wire shape
/// (`{name, description, input_schema}`).
fn encode_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            let name = function.get("name")?.as_str()?.to_string();
            if name.is_empty() {
                return None;
            }
            let description = function
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input_schema = function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({
                "name": name,
                "description": description,
                "input_schema": input_schema,
            }))
        })
        .collect()
}

pub struct CommandCode {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
}

impl CommandCode {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str) -> Self {
        Self {
            client: build_client(),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or(crate::config::COMMANDCODE_API_BASE_URL)
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl LlmProvider for CommandCode {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        on_reasoning: Option<ReasoningSink>,
        on_content: Option<ContentSink>,
        on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let system = messages
            .iter()
            .find_map(|m| {
                if m.role == "system" {
                    m.content.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let conv: Vec<Value> = messages.iter().filter_map(encode_message).collect();

        // The gateway requires a populated `config` describing the working
        // directory and an empty `memory` string. Values are informational
        // context only — never credentials.
        let project_root = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|_| String::from("."));
        let body = json!({
            "config": build_config(&project_root),
            // Command Code currently requires this field. Hormachuelos keeps
            // its provider-neutral Flavour memory locally and injects only a
            // bounded relevant digest through the primary system message.
            "memory": "",
            "params": {
                "model": self.model,
                "messages": conv,
                "tools": encode_tools(tools),
                "system": system,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "stream": true,
                "temperature": 0.2,
            },
        });

        let url = format!("{}{GENERATE_ENDPOINT}", self.base_url);

        // Retry transient upstream failures (429/5xx) with short backoff so a
        // blip does not abort an active run.
        let mut response = None;
        for attempt in 0..3 {
            let result = self
                .client
                .post(&url)
                .bearer_auth(&self.api_key)
                .header("Content-Type", "application/json")
                .header("User-Agent", "cli")
                .header("x-command-code-version", COMMAND_CODE_CLIENT_VERSION)
                .header("x-cli-environment", "production")
                // Avoid provider-side Taste learning and duplicate retention:
                // Flavour stays local, inspectable, and consistent across all providers.
                .header("x-taste-learning", "false")
                .header("x-co-flag", "false")
                .header("x-session-id", uuid::Uuid::new_v4().to_string())
                .json(&body)
                .send()
                .await
                .map_err(|error| request_error(&error));
            match result {
                Ok(res) => {
                    let status = res.status();
                    let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
                    if !status.is_success() {
                        let text = res.text().await.unwrap_or_default();
                        if retryable && attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                            continue;
                        }
                        return Err(anyhow!(
                            "commandcode_error: Command Code returned HTTP {}: {}",
                            status.as_u16(),
                            text
                        ));
                    }
                    response = Some(res);
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
        let mut response =
            response.ok_or_else(|| anyhow!("Command Code did not return a response."))?;

        let mut text_out = String::new();
        let mut reasoning_out = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut usage_tokens: u64 = 0;
        let mut stop_reason = String::new();
        let mut saw_finish = false;
        let mut saw_event = false;

        let mut pending = String::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| request_error(&error))?
        {
            let text = String::from_utf8_lossy(&chunk);
            pending.push_str(&text);

            while let Some(newline) = pending.find('\n') {
                let line = pending[..newline].trim().to_string();
                pending.drain(..=newline);
                if line.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(_) => continue, // heartbeat / non-JSON keepalive
                };
                saw_event = true;
                match value.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text-delta" | "text" | "content-delta" | "output-text-delta" => {
                        if let Some(delta) = event_delta_text(&value) {
                            text_out.push_str(delta);
                            if let Some(sink) = &on_content {
                                sink(delta);
                            }
                        }
                    }
                    "reasoning-start" => {
                        if let Some(sink) = &on_reasoning {
                            let _ = sink;
                        }
                    }
                    "reasoning-delta" | "reasoning" => {
                        if let Some(delta) = event_delta_text(&value) {
                            reasoning_out.push_str(delta);
                            if let Some(sink) = &on_reasoning {
                                sink(delta);
                            }
                        }
                    }
                    "tool-call" => {
                        let id = value
                            .get("toolCallId")
                            .and_then(Value::as_str)
                            .unwrap_or("call")
                            .to_string();
                        let name = value
                            .get("toolName")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let input = value
                            .get("input")
                            .or_else(|| value.get("args"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        if !name.is_empty() {
                            if let Some(sink) = &on_tool_call {
                                sink(tool_calls.len(), &name, "");
                            }
                            tool_calls.push(ToolCall {
                                id,
                                name,
                                arguments: input,
                            });
                        }
                    }
                    "tool-result" => {
                        // Server-executed tools arrive back as results; we only
                        // send our own tool results as request messages, so this
                        // event is informational here.
                    }
                    "finish" => {
                        saw_finish = true;
                        if let Some(reason) = value
                            .get("rawFinishReason")
                            .or_else(|| value.get("finishReason"))
                            .and_then(Value::as_str)
                        {
                            stop_reason = reason.to_string();
                        }
                        if let Some(usage) = value.get("totalUsage") {
                            let input = usage
                                .get("inputTokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            let output = usage
                                .get("outputTokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            usage_tokens = input.saturating_add(output);
                        }
                    }
                    "error" => {
                        let message = value
                            .get("error")
                            .and_then(Value::as_str)
                            .or_else(|| {
                                value
                                    .get("error")
                                    .and_then(|e| e.get("message"))
                                    .and_then(Value::as_str)
                            })
                            .unwrap_or("Unknown Command Code stream error")
                            .to_string();
                        return Err(anyhow!("commandcode_error: {message}"));
                    }
                    _ => {}
                }
            }
        }
        if !pending.trim().is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(pending.trim()) {
                // handle a trailing line without newline
                if value.get("type").and_then(Value::as_str) == Some("finish") {
                    saw_finish = true;
                    if let Some(reason) = value
                        .get("rawFinishReason")
                        .or_else(|| value.get("finishReason"))
                        .and_then(Value::as_str)
                    {
                        stop_reason = reason.to_string();
                    }
                    if let Some(usage) = value.get("totalUsage") {
                        let input = usage
                            .get("inputTokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let output = usage
                            .get("outputTokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        usage_tokens = input.saturating_add(output);
                    }
                }
            }
        }

        if !saw_event {
            return Err(anyhow!(
                "commandcode_error: Command Code returned an empty response."
            ));
        }

        // A stream that ended without a finish event (proxy cut, provider
        // timeout) must never execute a partial tool payload. Report it as a
        // resumable interruption so the host can continue the same task.
        if !saw_finish && !tool_calls.is_empty() {
            tool_calls.clear();
        }

        Ok(LlmResponse {
            text: (!text_out.is_empty()).then_some(text_out),
            tool_calls,
            reasoning_content: (!reasoning_out.is_empty()).then_some(reasoning_out),
            stop_reason: if stop_reason.is_empty() {
                if saw_finish {
                    "stop".to_string()
                } else {
                    "stream_interrupted".to_string()
                }
            } else {
                stop_reason
            },
            usage_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCall;
    use serde_json::json;

    #[test]
    fn encodes_openai_style_tool_calls_and_results() {
        let messages = vec![
            ChatMessage::user("Build a landing page."),
            ChatMessage::assistant(
                "Let me create it.",
                Some(vec![ToolCall {
                    id: "call_1".into(),
                    name: "write_file".into(),
                    arguments: json!({ "path": "index.html" }),
                }]),
                Some("I should create the file.".into()),
            ),
            ChatMessage::tool("call_1", "write_file", "wrote index.html"),
        ];

        let conv: Vec<Value> = messages.iter().filter_map(encode_message).collect();
        assert_eq!(conv.len(), 3);

        assert_eq!(conv[0]["role"], "user");
        assert_eq!(conv[0]["content"][0]["type"], "text");
        assert_eq!(conv[0]["content"][0]["text"], "Build a landing page.");

        assert_eq!(conv[1]["role"], "assistant");
        let blocks = conv[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "reasoning");
        assert_eq!(blocks[2]["type"], "tool-call");
        assert_eq!(blocks[2]["toolCallId"], "call_1");
        assert_eq!(blocks[2]["toolName"], "write_file");
        assert_eq!(blocks[2]["input"], json!({ "path": "index.html" }));

        assert_eq!(conv[2]["role"], "tool");
        assert_eq!(conv[2]["content"][0]["type"], "tool-result");
        assert_eq!(conv[2]["content"][0]["toolCallId"], "call_1");
        assert_eq!(conv[2]["content"][0]["toolName"], "write_file");
        assert_eq!(
            conv[2]["content"][0]["output"],
            json!({ "type": "text", "value": "wrote index.html" })
        );
    }

    #[test]
    fn known_models_are_static_and_non_empty() {
        assert!(KNOWN_MODELS.contains(&"gpt-5.6-luna"));
        assert!(KNOWN_MODELS.contains(&"deepseek/deepseek-v4-pro"));
        assert!(KNOWN_MODELS.contains(&"xai/grok-4.5"));
    }

    #[test]
    fn event_delta_text_reads_text_delta_or_nested_content() {
        assert_eq!(event_delta_text(&json!({ "text": "Hi" })), Some("Hi"));
        assert_eq!(
            event_delta_text(&json!({ "delta": "There" })),
            Some("There")
        );
        assert_eq!(
            event_delta_text(&json!({ "delta": { "text": "Nested" } })),
            Some("Nested")
        );
        assert_eq!(
            event_delta_text(&json!({ "content": "Answer" })),
            Some("Answer")
        );
    }
}
