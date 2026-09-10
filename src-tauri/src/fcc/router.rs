//! Model routing — port of FCC `api/model_router.py` + `gateway_model_ids.py`
//! + `Settings.resolve_model/resolve_thinking` subset.
//!
//! Resolution order for an incoming model name:
//! 1. `anthropic/<provider>/<model>` gateway id (thinking untouched).
//! 2. `claude-3-freecc-no-thinking/<provider>/<model>` (forces thinking off —
//!    exploits the Claude `claude-3-` no-thinking client heuristic).
//! 3. `<provider>/<model>` when the provider is known.
//! 4. Tier substring fallback: `opus` → opus override, `haiku` → haiku
//!    override, `sonnet` → sonnet override, else the `MODEL` fallback.
//!
//! OpenAI-chat transports cannot represent Anthropic server-tool blocks, so
//! server-tool-shaped requests are rejected pre-provider (FCC
//! `_reject_unsupported_server_tools`).

/// Providers whose transport is OpenAI-chat (`/chat/completions`).
/// Server-tool blocks are rejected for these pre-provider.
pub const OPENAI_CHAT_PROVIDERS: &[&str] = &[
    "openai", "cursor", "xai", "mistral", "opencode", "cerebras", "groq",
    "nvidia_nim", "glm", "commandcode",
];

pub const GATEWAY_PREFIX: &str = "anthropic";
pub const NO_THINKING_GATEWAY_PREFIX: &str = "claude-3-freecc-no-thinking";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    pub original_model: String,
    pub provider_id: String,
    pub provider_model: String,
    pub provider_model_ref: String,
    pub thinking_enabled: bool,
}

/// Routing config. Port of FCC `MODEL` / `MODEL_OPUS|SONNET|HAIKU` /
/// `ENABLE_MODEL_THINKING` + per-tier overrides.
#[derive(Debug, Clone)]
pub struct RoutingConfig {
    pub model_fallback: String,
    pub model_opus: Option<String>,
    pub model_sonnet: Option<String>,
    pub model_haiku: Option<String>,
    pub enable_thinking: bool,
    pub enable_opus_thinking: Option<bool>,
    pub enable_sonnet_thinking: Option<bool>,
    pub enable_haiku_thinking: Option<bool>,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            model_fallback: "deepseek/deepseek-v4-flash".to_string(),
            model_opus: None,
            model_sonnet: None,
            model_haiku: None,
            enable_thinking: true,
            enable_opus_thinking: None,
            enable_sonnet_thinking: None,
            enable_haiku_thinking: None,
        }
    }
}

/// Decode a gateway model id. Port of `decode_gateway_model_id`.
/// Returns `(provider_id, provider_model, force_thinking_enabled)`.
pub fn decode_gateway_model_id(model_name: &str) -> Option<(String, String, Option<bool>)> {
    let (prefix, rest) = model_name.split_once('/')?;
    let force = if prefix == GATEWAY_PREFIX {
        None
    } else if prefix == NO_THINKING_GATEWAY_PREFIX {
        Some(false)
    } else {
        return None;
    };
    let (provider_id, provider_model) = rest.split_once('/')?;
    if provider_id.is_empty() || provider_model.is_empty() {
        return None;
    }
    Some((provider_id.to_string(), provider_model.to_string(), force))
}

pub fn parse_provider_type(model_ref: &str) -> String {
    model_ref.split_once('/').map(|(p, _)| p.to_string()).unwrap_or_default()
}

pub fn parse_model_name(model_ref: &str) -> String {
    model_ref.split_once('/').map(|(_, m)| m.to_string()).unwrap_or_else(|| model_ref.to_string())
}

/// Tier fallback. Port of FCC `Settings.resolve_model` (substring match
/// `opus > haiku > sonnet`, else fallback).
pub fn resolve_model_ref(config: &RoutingConfig, claude_name: &str) -> String {
    let lower = claude_name.to_ascii_lowercase();
    if lower.contains("opus") {
        if let Some(r) = config.model_opus.clone() {
            return r;
        }
    } else if lower.contains("haiku") {
        if let Some(r) = config.model_haiku.clone() {
            return r;
        }
    } else if lower.contains("sonnet") {
        if let Some(r) = config.model_sonnet.clone() {
            return r;
        }
    }
    config.model_fallback.clone()
}

/// Thinking fallback. Port of FCC `Settings.resolve_thinking`.
pub fn resolve_thinking(config: &RoutingConfig, claude_name: &str) -> bool {
    let lower = claude_name.to_ascii_lowercase();
    if lower.contains("opus") {
        if let Some(t) = config.enable_opus_thinking {
            return t;
        }
    } else if lower.contains("haiku") {
        if let Some(t) = config.enable_haiku_thinking {
            return t;
        }
    } else if lower.contains("sonnet") {
        if let Some(t) = config.enable_sonnet_thinking {
            return t;
        }
    }
    config.enable_thinking
}

/// Full resolution. Port of `ModelRouter.resolve`.
pub fn resolve(
    config: &RoutingConfig,
    claude_model_name: &str,
    known_providers: &[&str],
) -> ResolvedModel {
    if let Some((provider_id, provider_model, force_thinking)) =
        decode_gateway_model_id(claude_model_name)
    {
        if known_providers.contains(&provider_id.as_str()) {
            let thinking = force_thinking.unwrap_or_else(|| resolve_thinking(config, &provider_model));
            return ResolvedModel {
                original_model: claude_model_name.to_string(),
                provider_model_ref: claude_model_name.to_string(),
                provider_id,
                provider_model,
                thinking_enabled: thinking,
            };
        }
    }
    if let Some((provider_id, provider_model)) = claude_model_name.split_once('/') {
        if !provider_model.is_empty() && known_providers.contains(&provider_id) {
            return ResolvedModel {
                original_model: claude_model_name.to_string(),
                provider_model_ref: claude_model_name.to_string(),
                provider_id: provider_id.to_string(),
                provider_model: provider_model.to_string(),
                thinking_enabled: resolve_thinking(config, provider_model),
            };
        }
    }
    let model_ref = resolve_model_ref(config, claude_model_name);
    ResolvedModel {
        original_model: claude_model_name.to_string(),
        provider_id: parse_provider_type(&model_ref),
        provider_model: parse_model_name(&model_ref),
        provider_model_ref: model_ref,
        thinking_enabled: resolve_thinking(config, claude_model_name),
    }
}

/// Pre-provider server-tool guard for OpenAI-chat transports.
pub fn reject_unsupported_server_tools(
    provider_id: &str,
    has_server_tool_block: bool,
) -> Result<(), String> {
    if has_server_tool_block && OPENAI_CHAT_PROVIDERS.contains(&provider_id) {
        return Err("This provider cannot represent server-tool blocks; the request was rejected before execution.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &[&str] = &["deepseek", "openrouter", "anthropic"];

    #[test]
    fn gateway_ids_decode_with_thinking_rules() {
        let cfg = RoutingConfig::default();
        let r = resolve(&cfg, "anthropic/deepseek/deepseek-chat", KNOWN);
        assert_eq!((r.provider_id.as_str(), r.provider_model.as_str()), ("deepseek", "deepseek-chat"));
        assert!(r.thinking_enabled);
        let r = resolve(&cfg, "claude-3-freecc-no-thinking/deepseek/deepseek-chat", KNOWN);
        assert!(!r.thinking_enabled);
    }

    #[test]
    fn tier_fallback_prefers_opus_over_haiku_over_sonnet() {
        let cfg = RoutingConfig {
            model_fallback: "deepseek/deepseek-chat".into(),
            model_opus: Some("anthropic/claude-opus".into()),
            model_sonnet: None,
            model_haiku: Some("anthropic/claude-haiku".into()),
            ..RoutingConfig::default()
        };
        assert_eq!(resolve_model_ref(&cfg, "claude-opus-4"), "anthropic/claude-opus");
        assert_eq!(resolve_model_ref(&cfg, "claude-haiku-4"), "anthropic/claude-haiku");
        assert_eq!(resolve_model_ref(&cfg, "something-else"), "deepseek/deepseek-chat");
    }
}
