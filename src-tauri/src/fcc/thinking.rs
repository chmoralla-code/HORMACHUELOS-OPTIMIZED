//! Thinking enable/disable policy — port of FCC `core/anthropic/thinking.py`,
//! `native_messages_request.py` thinking sanitize, and
//! `native_sse_block_policy.py` thinking drop.

/// Effective thinking flag: FCC `BaseProvider._is_thinking_enabled` =
/// `config.enable_thinking && request.thinking.enabled != False &&
/// type != disabled`, plus gateway `force_thinking_enabled`.
pub fn is_thinking_enabled(
    config_enable_thinking: bool,
    force_thinking_enabled: Option<bool>,
    request_thinking_disabled: bool,
) -> bool {
    if let Some(forced) = force_thinking_enabled {
        return forced;
    }
    config_enable_thinking && !request_thinking_disabled
}

/// Native-history sanitize: when disabled, strip `thinking` blocks but keep
/// `redacted_thinking` (signed, opaque). Port of
/// `sanitize_native_messages_thinking_policy` (disabled branch).
pub fn sanitize_native_history_disabled(content: &mut Vec<serde_json::Value>) {
    content.retain(|block| block.get("type").and_then(|t| t.as_str()) != Some("thinking"));
}

/// Native-history sanitize (enabled): strip unsigned `thinking`, keep
/// `redacted_thinking` and signed blocks.
pub fn sanitize_native_history_enabled(content: &mut Vec<serde_json::Value>) {
    content.retain(|block| {
        let t = block.get("type").and_then(|t| t.as_str());
        if t != Some("thinking") {
            return true;
        }
        block.get("signature").and_then(|s| s.as_str()).is_some_and(|s| !s.is_empty())
    });
}

/// Whether a native SSE delta type must be dropped when thinking is off.
pub fn drop_native_delta_when_disabled(delta_type: &str) -> bool {
    matches!(delta_type, "thinking_delta" | "signature_delta")
}

/// Whether an OpenAI-chat upstream should receive `reasoning_content`/`<think>`
/// content. When disabled, reasoning text is dropped from the request body.
pub fn openai_chat_sends_reasoning(thinking_enabled: bool) -> bool {
    thinking_enabled
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gateway_force_off_wins_over_config() {
        assert!(!is_thinking_enabled(true, Some(false), false));
        assert!(is_thinking_enabled(true, None, false));
        assert!(!is_thinking_enabled(false, None, false));
        assert!(!is_thinking_enabled(true, None, true));
    }

    #[test]
    fn disabled_history_drops_thinking_keeps_redacted() {
        let mut content = vec![
            json!({ "type": "thinking", "thinking": "hmm" }),
            json!({ "type": "redacted_thinking", "data": "opaque" }),
            json!({ "type": "text", "text": "hi" }),
        ];
        sanitize_native_history_disabled(&mut content);
        assert_eq!(content.len(), 2);
    }
}
