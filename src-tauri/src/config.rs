use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// xAI's OpenAI-compatible inference endpoint. Keep this as a single source of
/// truth so an xAI key is never accidentally sent to the Cursor or OpenAI API.
pub const XAI_API_BASE_URL: &str = "https://api.x.ai/v1";

/// Command Code's hosted API. The chat endpoint is `/alpha/generate`.
pub const COMMANDCODE_API_BASE_URL: &str = "https://api.commandcode.ai";
/// OpenAI-compatible Command Code Provider API (Gemini, GPT, and other models).
pub const COMMANDCODE_PROVIDER_API_BASE_URL: &str = "https://api.commandcode.ai/provider/v1";

const BUILTIN_PROVIDER_IDS: &[&str] = &[
    "deepseek",
    "openrouter",
    "glm",
    "openai",
    "cursor",
    "xai",
    "hormachuelos_free",
    "anthropic",
    "gemini",
    "gemini_cli",
    "ollama",
    "pollinations",
    "commandcode",
];

fn settings_path() -> Result<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .context("could not determine config dir")?;
    let dir = proj.config_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// Read-only compatibility path for the standard edition. This function never
/// creates, modifies, or deletes anything in the original application's folder.
fn original_settings_path() -> Result<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .context("could not determine original Hormachuelos config dir")?;
    Ok(proj.config_dir().join("settings.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    /// Legacy persisted value kept so settings from older desktop releases
    /// still load. Agent runs are intentionally unbounded; Stop, command
    /// timeouts, and hosted usage safeguards remain active.
    #[serde(default)]
    pub max_iterations: u32,
    pub command_timeout_secs: u64,
    pub auto_approve: bool,
    /// Permission mode: adaptive | agentic | ask | research | plan | build | multi_agent.
    /// Legacy auto/full values are migrated to adaptive/build.
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Capability chip: thinking | guided | agent | balanced | investigate | brief | autonomous | max | orchestrated | thorough
    #[serde(default = "default_capability_mode")]
    pub capability_mode: String,
    /// Mix English + Filipino (Taglish) in agent replies — PH freelancer default off.
    #[serde(default)]
    pub taglish: bool,
    /// Cursor SDK model effort: light | medium | high | xhigh | ultra
    /// (legacy: low | max also accepted)
    #[serde(default = "default_model_effort")]
    pub model_effort: String,
    /// Keep Preview Computer Use available for every request.
    #[serde(default)]
    pub computer_use_enabled: bool,
    /// Allow explicit user prompts to enable Preview Computer Use for that request.
    /// Missing on older settings defaults to Auto so the new menu is immediately useful.
    #[serde(default = "default_computer_use_prompt_activation")]
    pub computer_use_prompt_activation: bool,
    /// Opt-in native Windows Desktop Computer Use. Off by default.
    #[serde(default)]
    pub desktop_computer_use_enabled: bool,
    /// Optional process-name allowlist. Empty means all ordinary apps except the hard blocklist.
    #[serde(default)]
    pub desktop_computer_use_allowed_apps: Vec<String>,
    /// Host-owned Director jobs (Answer / Change / Ship / Operate) plus verification.
    /// Defaults on so existing installations benefit after upgrading, while the
    /// user can turn it off from Settings for a lighter direct-response flow.
    #[serde(default = "default_smart_agent_enabled")]
    pub smart_agent_enabled: bool,
    /// Provider-neutral, local-first project and session memory.
    /// Defaults on after upgrades and can be disabled independently of Director.
    #[serde(default = "default_flavour_enabled")]
    pub flavour_enabled: bool,
}

/// A deliberately narrow, non-secret view of the standard app's model choice.
/// API keys, website sessions, license data, and project settings are excluded.
#[derive(Debug, Clone, Serialize)]
pub struct OriginalModelSelection {
    pub provider: String,
    pub model: String,
    pub model_effort: String,
}

#[derive(Debug, Deserialize)]
struct OriginalModelSelectionFile {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    model_effort: String,
}

fn default_permission_mode() -> String {
    "adaptive".into()
}

fn default_capability_mode() -> String {
    "balanced".into()
}

fn default_model_effort() -> String {
    "high".into()
}

fn normalize_model_effort(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" | "light" => "light".into(),
        "medium" => "medium".into(),
        "high" => "high".into(),
        "xhigh" | "extra" | "extra-high" | "extrahigh" => "xhigh".into(),
        "ultra" | "max" => "ultra".into(),
        _ => default_model_effort(),
    }
}

fn default_computer_use_prompt_activation() -> bool {
    true
}

fn default_smart_agent_enabled() -> bool {
    true
}

fn default_flavour_enabled() -> bool {
    true
}

/// Hosted aliases are selected from the server-managed catalog. Keeping the
/// prefix constrained prevents a desktop client from using the shared hosted
/// credential to request an arbitrary upstream model.
fn is_hormachuelos_model_alias(model: &str) -> bool {
    let model = model.trim();
    let Some(rest) = model.strip_prefix("hormachuelos-") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 80
        && rest.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_' | '.')
        })
}

fn capability_for_mode(mode: &str) -> &'static str {
    match mode {
        "adaptive" | "auto" => "balanced",
        "agentic" => "orchestrated",
        "ask" => "answer_max",
        "research" => "investigate",
        "build" | "full" => "agent",
        "multi_agent" => "autonomous",
        _ => "thinking",
    }
}

pub(crate) fn normalize_capability_for_mode(mode: &str, capability: &str) -> String {
    let mode = mode.trim().to_ascii_lowercase();
    let capability = capability.trim().to_ascii_lowercase();
    let allowed = match mode.as_str() {
        "adaptive" | "auto" => matches!(capability.as_str(), "balanced" | "agent"),
        "agentic" => matches!(capability.as_str(), "orchestrated" | "thorough"),
        "ask" => matches!(capability.as_str(), "answer_max" | "brief"),
        "research" => matches!(capability.as_str(), "investigate" | "answer_max"),
        "plan" => matches!(capability.as_str(), "thinking" | "guided"),
        "build" | "full" => matches!(capability.as_str(), "agent" | "balanced"),
        "multi_agent" => matches!(capability.as_str(), "autonomous" | "max"),
        _ => false,
    };
    if allowed {
        capability
    } else {
        capability_for_mode(&mode).into()
    }
}

/// Normalize permission/capability fields the same way `save_settings` does
/// before the payload is validated and written. Tests use this as the IPC
/// contract without opening a Tauri window or touching the user config file.
pub(crate) fn prepare_settings_for_save(mut settings: Settings) -> Result<Settings> {
    let mode = settings.permission_mode.trim().to_ascii_lowercase();
    settings.permission_mode = match mode.as_str() {
        "auto" => "adaptive".into(),
        "full" => "build".into(),
        "adaptive" | "agentic" | "ask" | "research" | "plan" | "build" | "multi_agent" => mode,
        _ => {
            if settings.auto_approve {
                "adaptive".into()
            } else {
                "plan".into()
            }
        }
    };
    settings.auto_approve = matches!(
        settings.permission_mode.as_str(),
        "adaptive" | "agentic" | "build" | "multi_agent"
    );
    settings.capability_mode =
        normalize_capability_for_mode(&settings.permission_mode, &settings.capability_mode);
    settings.validate()?;
    Ok(settings)
}

fn should_migrate_cursor_grok_to_xai(
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    migrated_legacy_xai_key: bool,
    has_cursor_sdk_key: bool,
) -> bool {
    let model = model.trim();
    provider.eq_ignore_ascii_case("cursor")
        && (model.eq_ignore_ascii_case("grok-4.5") || model.eq_ignore_ascii_case("gpt-5.6-sol"))
        && (base_url == Some(XAI_API_BASE_URL) || migrated_legacy_xai_key || !has_cursor_sdk_key)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Public OpenAI alias over the Cursor SDK (GPT 5.6 Sol by default).
            provider: "cursor".into(),
            model: "grok-4.5".into(),
            base_url: Some("https://api.cursor.com/v1".into()),
            max_iterations: 0,
            command_timeout_secs: 120,
            auto_approve: true,
            permission_mode: default_permission_mode(),
            capability_mode: default_capability_mode(),
            taglish: false,
            model_effort: default_model_effort(),
            computer_use_enabled: false,
            computer_use_prompt_activation: default_computer_use_prompt_activation(),
            desktop_computer_use_enabled: false,
            desktop_computer_use_allowed_apps: Vec::new(),
            smart_agent_enabled: default_smart_agent_enabled(),
            flavour_enabled: default_flavour_enabled(),
        }
    }
}

fn original_model_selection_from_json(raw: &str) -> Result<OriginalModelSelection> {
    let source: OriginalModelSelectionFile =
        serde_json::from_str(raw).context("could not parse original Hormachuelos settings")?;
    let mut candidate = Settings::default();
    candidate.provider = source.provider.trim().to_ascii_lowercase();
    candidate.model = source.model.trim().to_string();
    // The original endpoint is intentionally not copied. Use only the optimized
    // app's canonical protected endpoint where validation requires one.
    candidate.base_url = match candidate.provider.as_str() {
        "hormachuelos_free" => Some("https://hormachuelos.vercel.app/api/v1".into()),
        "commandcode" => Some(crate::license::hosted_chat_base_url()),
        _ if is_custom_hosted_provider_alias(&candidate.provider) => {
            Some(crate::license::hosted_chat_base_url())
        }
        _ => None,
    };
    candidate.model_effort = normalize_model_effort(&source.model_effort);
    candidate.validate()?;

    Ok(OriginalModelSelection {
        provider: candidate.provider,
        model: candidate.model,
        model_effort: candidate.model_effort,
    })
}

/// Return the standard edition's selected provider/model/effort without reading
/// any credential, session, license, project, or general application data.
pub fn load_original_model_selection() -> Result<Option<OriginalModelSelection>> {
    let path = original_settings_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| "could not read original Hormachuelos model selection")?;
    original_model_selection_from_json(&raw).map(Some)
}

impl Settings {
    pub fn load() -> Result<Self> {
        let p = settings_path()?;
        if !p.exists() {
            let s = Self::default();
            s.save()?;
            return Ok(s);
        }
        let raw = std::fs::read_to_string(&p)?;
        let mut s: Self = serde_json::from_str(&raw)?;
        s.provider = s.provider.trim().to_ascii_lowercase();
        if s.command_timeout_secs == 0 {
            s.command_timeout_secs = 120;
        }
        if s.permission_mode.trim().is_empty() {
            s.permission_mode = default_permission_mode();
        }
        // Keep auto_approve in sync with mode for older code paths
        let mode = s.permission_mode.to_ascii_lowercase();
        match mode.as_str() {
            "adaptive" | "agentic" | "multi_agent" => {
                s.permission_mode = mode;
                s.auto_approve = true;
            }
            "auto" => {
                s.permission_mode = "adaptive".into();
                s.auto_approve = true;
            }
            "build" | "full" => {
                s.permission_mode = "build".into();
                s.auto_approve = true;
            }
            "plan" => {
                s.permission_mode = mode;
                // Plan stays locked until the user confirms Apply (see agent plan lock).
                s.auto_approve = false;
            }
            "ask" | "research" => {
                s.permission_mode = mode;
                s.auto_approve = false;
            }
            _ => {
                // Migrate legacy unknown values from auto_approve flag
                s.permission_mode = if s.auto_approve {
                    "adaptive".into()
                } else {
                    "plan".into()
                };
                s.auto_approve = matches!(
                    s.permission_mode.as_str(),
                    "adaptive" | "agentic" | "build" | "multi_agent"
                );
            }
        }
        s.capability_mode = normalize_capability_for_mode(&s.permission_mode, &s.capability_mode);
        s.model_effort = normalize_model_effort(&s.model_effort);
        // Older builds stored a fabricated OpenAI/GPT label while sending the
        // request through Cursor/Grok. Migrate only that known alias.
        if s.provider.eq_ignore_ascii_case("openai")
            && s.base_url.as_deref() == Some("https://api.cursor.com/v1")
        {
            s.provider = "cursor".into();
            if s.model.trim().is_empty() {
                s.model = "grok-4.5".into();
            }
            s.base_url = Some("https://api.cursor.com/v1".into());
        }
        // A real Grok/xAI key must use xAI's OpenAI-compatible endpoint, not
        // the Cursor SDK endpoint. Honour explicit old settings that already
        // point at xAI, then repair the common legacy Cursor/Grok combination
        // after the credential has been safely migrated to the xAI key slot.
        if s.provider.eq_ignore_ascii_case("openai")
            && s.base_url.as_deref() == Some(XAI_API_BASE_URL)
        {
            s.provider = "xai".into();
        }
        let migrated_legacy_xai_key = migrate_legacy_xai_key().unwrap_or(false);
        let has_cursor_sdk_key = load_cursor_sdk_api_key("cursor").is_ok();
        if should_migrate_cursor_grok_to_xai(
            &s.provider,
            &s.model,
            s.base_url.as_deref(),
            migrated_legacy_xai_key,
            has_cursor_sdk_key,
        ) {
            s.provider = "xai".into();
            s.base_url = Some(XAI_API_BASE_URL.into());
        }
        // Translate legacy display aliases to the Cursor SDK model IDs. The
        // frontend displays these as GPT 5.6 Sol/Luna, but Cursor receives its
        // native model identifiers.
        if s.provider.eq_ignore_ascii_case("cursor") {
            match s.model.trim() {
                "gpt-5.6-sol" => s.model = "grok-4.5".into(),
                "gpt-5.6-luna" => s.model = "composer-2.5".into(),
                _ => {}
            }
        }
        // Keep whatever Cursor model the user selected — do not force grok-only.
        match (s.provider.as_str(), s.model.as_str()) {
            ("deepseek", "deepseek-chat") => s.model = "deepseek-v4-flash".into(),
            ("deepseek", "deepseek-reasoner") => s.model = "deepseek-v4-pro".into(),
            _ => {}
        }
        if s.provider == "hormachuelos_free" {
            if !is_hormachuelos_model_alias(&s.model) {
                s.model = "hormachuelos-v1".into();
            }
            s.base_url = Some("https://hormachuelos.vercel.app/api/v1".into());
        }
        // HORMACHUELOS NEW MODELS is hidden from the picker. DeepSeek V4 Flash
        // now lives on FREE as Hormachuelos v4 (VISION), still backed by the
        // shared Command Code key on the hosted proxy.
        if s.provider == "commandcode" {
            s.provider = "hormachuelos_free".into();
            s.model = "hormachuelos-v4".into();
            s.base_url = Some("https://hormachuelos.vercel.app/api/v1".into());
        }
        if is_custom_hosted_provider_alias(&s.provider) {
            // Custom provider aliases are controlled by the website admin and
            // always run through the protected hosted proxy. Never persist an
            // arbitrary desktop-side endpoint for them.
            s.base_url = Some(crate::license::hosted_chat_base_url());
        }
        if s.provider == "xai" {
            if s.model.trim().is_empty() || s.model.eq_ignore_ascii_case("gpt-5.6-sol") {
                s.model = "grok-4.5".into();
            }
            // The hosted proxy replaces this at request time for paid clients;
            // this is the direct BYOK endpoint for everyone else.
            s.base_url = Some(XAI_API_BASE_URL.into());
        }
        if s.provider == "deepseek" && s.base_url.as_deref() == Some("https://api.deepseek.com/v1")
        {
            s.base_url = Some("https://api.deepseek.com".into());
        }
        if s.provider == "glm" {
            let legacy = matches!(
                s.base_url.as_deref(),
                Some("https://api.atomeocean.com/v1")
                    | Some("https://open.bigmodel.cn/api/paas/v4")
                    | None
            ) || s.base_url.as_deref().is_some_and(|u| u.trim().is_empty());
            if legacy {
                s.base_url = Some("https://opencode.ai/zen/v1".into());
            }
            let free = [
                "deepseek-v4-flash-free",
                "mimo-v2.5-free",
                "north-mini-code-free",
                "ling-3.0-flash-free",
                "laguna-s-2.1-free",
                "nemotron-3-ultra-free",
                "big-pickle",
            ];
            if !free.iter().any(|m| *m == s.model) {
                s.model = "deepseek-v4-flash-free".into();
            }
        }
        if s.provider == "pollinations"
            && s.base_url.as_deref() == Some("https://text.pollinations.ai/openai")
        {
            s.base_url = Some("https://gen.pollinations.ai/v1".into());
        }
        if s.provider == "commandcode" {
            // The direct Command Code gateway is the BYOK endpoint; the
            // Hormachuelos hosted proxy serves paid plans with the shared
            // server-side key. Preserve whichever is configured.
            let hosted = crate::license::hosted_chat_base_url();
            if s.base_url.as_deref().is_none_or(|url| {
                !url.eq_ignore_ascii_case(hosted.as_str())
                    && !url.eq_ignore_ascii_case(COMMANDCODE_API_BASE_URL)
            }) {
                s.base_url = Some(hosted);
            }
            if s.model.trim().is_empty() {
                s.model = "deepseek/deepseek-v4-flash".into();
            }
        }
        s.desktop_computer_use_allowed_apps =
            crate::desktop_computer_use::sanitize_allowed_apps(s.desktop_computer_use_allowed_apps);
        s.validate()?;
        Ok(s)
    }

    pub fn save(&self) -> Result<()> {
        self.validate()?;
        let p = settings_path()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&p, raw)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        validate_provider_id(&self.provider)?;
        ensure!(
            !self.model.trim().is_empty() && self.model.len() <= 200,
            "Model must be 1-200 characters."
        );
        ensure!(
            !self.model.chars().any(char::is_control),
            "Model cannot contain control characters."
        );
        ensure!(
            (5..=600).contains(&self.command_timeout_secs),
            "Command timeout must be between 5 and 600 seconds."
        );
        ensure!(
            matches!(
                self.permission_mode.as_str(),
                "adaptive"
                    | "agentic"
                    | "ask"
                    | "research"
                    | "plan"
                    | "build"
                    | "multi_agent"
                    | "auto"
                    | "full"
            ),
            "Permission mode must be adaptive, agentic, ask, research, plan, build, or multi_agent."
        );
        ensure!(
            matches!(
                self.capability_mode.as_str(),
                "thinking"
                    | "guided"
                    | "agent"
                    | "balanced"
                    | "answer_max"
                    | "investigate"
                    | "brief"
                    | "autonomous"
                    | "max"
                    | "orchestrated"
                    | "thorough"
            ),
            "Capability mode is invalid."
        );
        ensure!(
            matches!(
                self.model_effort.as_str(),
                "light" | "medium" | "high" | "xhigh" | "ultra" | "low" | "max"
            ),
            "Model effort must be light, medium, high, xhigh, or ultra."
        );
        if let Some(base_url) = &self.base_url {
            ensure!(
                !base_url.trim().is_empty() && base_url.len() <= 2048,
                "Base URL must be 1-2048 characters."
            );
            crate::llm::validate_provider_base_url(&self.provider, base_url)?;
        }
        if self.provider == "hormachuelos_free" {
            ensure!(
                is_hormachuelos_model_alias(&self.model),
                "HORMACHUELOS FREE model aliases must start with 'hormachuelos-'."
            );
            ensure!(
                self.base_url.as_deref() == Some("https://hormachuelos.vercel.app/api/v1"),
                "HORMACHUELOS FREE uses the protected Hormachuelos endpoint."
            );
        }
        if is_custom_hosted_provider_alias(&self.provider) {
            ensure!(
                self.base_url.as_deref() == Some(crate::license::hosted_chat_base_url().as_str()),
                "Server-managed provider aliases use the protected Hormachuelos endpoint."
            );
        }
        if self.provider == "commandcode" {
            let hosted = crate::license::hosted_chat_base_url();
            let allowed = matches!(self.base_url.as_deref(), Some(COMMANDCODE_API_BASE_URL))
                || self
                    .base_url
                    .as_deref()
                    .is_some_and(|url| url.eq_ignore_ascii_case(&hosted));
            ensure!(
                allowed,
                "COMMANDCODE uses the Command Code gateway or the Hormachuelos hosted proxy."
            );
        }
        ensure!(
            self.desktop_computer_use_allowed_apps.len() <= 32,
            "Desktop mode can pin at most 32 allowed apps."
        );
        Ok(())
    }
}

/// True for a dashboard-created hosted provider alias. These aliases share the
/// existing OpenAI-compatible proxy, not a user-provided base URL or key.
pub fn is_custom_hosted_provider_alias(provider: &str) -> bool {
    let id = provider.trim();
    if id.len() > 49 || id.is_empty() || BUILTIN_PROVIDER_IDS.contains(&id) {
        return false;
    }
    let mut chars = id.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
}

pub fn validate_provider_id(provider: &str) -> Result<()> {
    let id = provider.trim();
    ensure!(
        provider == id
            && (BUILTIN_PROVIDER_IDS.contains(&id) || is_custom_hosted_provider_alias(id)),
        "Unknown provider."
    );
    Ok(())
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry> {
    validate_provider_id(provider)?;
    Ok(keyring::Entry::new("hormachuelos-optimized", provider)?)
}

pub fn store_api_key(provider: &str, key: &str) -> Result<()> {
    let key = key.trim();
    ensure!(
        (8..=4096).contains(&key.len()),
        "API key must be between 8 and 4096 characters."
    );
    ensure!(
        !key.chars().any(char::is_control),
        "API key cannot contain control characters."
    );
    if provider.eq_ignore_ascii_case("xai") {
        ensure!(
            is_xai_api_key(key),
            "A Grok / xAI API key must start with 'xai-'."
        );
    }
    let entry = keyring_entry(provider)?;
    entry.set_password(key)?;
    Ok(())
}

pub fn load_api_key(provider: &str) -> Result<String> {
    let entry = keyring_entry(provider)?;
    Ok(entry.get_password()?)
}

pub fn has_api_key(provider: &str) -> bool {
    load_api_key(provider)
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false)
}

fn is_xai_api_key(key: &str) -> bool {
    key.trim().to_ascii_lowercase().starts_with("xai-")
}

/// Load an xAI key without ever sending a non-xAI credential to api.x.ai.
///
/// Earlier releases called the Grok integration "OpenAI" and stored a user's
/// xAI key under either the OpenAI or Cursor keychain entry. Move only a key
/// with xAI's public prefix into the dedicated entry; a Cursor `crsr_…` key
/// remains untouched and continues to power the Cursor provider.
pub fn load_xai_api_key() -> Result<String> {
    if let Ok(key) = load_api_key("xai") {
        ensure!(
            is_xai_api_key(&key),
            "The saved Grok / xAI API key is invalid. Save a current key that starts with 'xai-'."
        );
        return Ok(key);
    }

    if migrate_legacy_xai_key()? {
        return load_api_key("xai");
    }

    Err(anyhow::anyhow!(
        "No Grok / xAI API key is configured. Save a key that starts with 'xai-'."
    ))
}

/// Move only an xAI-shaped legacy credential. `false` means the dedicated
/// entry already existed or no compatible legacy value was found.
fn migrate_legacy_xai_key() -> Result<bool> {
    if let Ok(key) = load_api_key("xai") {
        ensure!(
            is_xai_api_key(&key),
            "The saved Grok / xAI API key is invalid. Save a current key that starts with 'xai-'."
        );
        return Ok(false);
    }
    for legacy_provider in ["cursor", "openai"] {
        let Ok(key) = load_api_key(legacy_provider) else {
            continue;
        };
        if !is_xai_api_key(&key) {
            continue;
        }
        store_api_key("xai", &key)?;
        // Deleting only the xAI-shaped legacy value prevents the Cursor card
        // from reporting a false-positive saved Cursor credential. Ignore a
        // cleanup failure because the newly stored xAI entry is authoritative.
        let _ = delete_api_key(legacy_provider);
        return Ok(true);
    }

    Ok(false)
}

/// Provider-aware key lookup used by chat, model discovery, and connection
/// tests. It keeps provider-specific credential formats isolated.
pub fn load_provider_api_key(provider: &str) -> Result<String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "cursor" => load_cursor_sdk_api_key(provider),
        "xai" => load_xai_api_key(),
        _ => load_api_key(provider),
    }
}

pub fn has_provider_api_key(provider: &str) -> bool {
    load_provider_api_key(provider)
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false)
}

/// Load the Cursor credential, with a narrow migration for old builds that
/// stored a `crsr_` key under the former OpenAI display alias.
pub fn load_cursor_sdk_api_key(_provider: &str) -> Result<String> {
    if let Ok(key) = load_api_key("cursor") {
        if key.trim().starts_with("crsr_") {
            return Ok(key);
        }
    }
    let legacy = load_api_key("openai")?;
    if legacy.trim().starts_with("crsr_") {
        return Ok(legacy);
    }
    Err(anyhow::anyhow!(
        "No Cursor SDK key is configured. Save a Cursor key that starts with 'crsr_'."
    ))
}

pub fn delete_api_key(provider: &str) -> Result<()> {
    let entry = keyring_entry(provider)?;
    let _ = entry.delete_credential();
    Ok(())
}

fn website_session_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(
        "hormachuelos-optimized",
        "website_session",
    )?)
}

pub fn store_website_session(token: &str) -> Result<()> {
    let token = token.trim();
    ensure!(
        (16..=4096).contains(&token.len()),
        "Session token must be between 16 and 4096 characters."
    );
    ensure!(
        !token.chars().any(char::is_control),
        "Session token cannot contain control characters."
    );
    website_session_entry()?.set_password(token)?;
    Ok(())
}

pub fn load_website_session() -> Result<String> {
    Ok(website_session_entry()?.get_password()?)
}

pub fn has_website_session() -> bool {
    load_website_session()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false)
}

pub fn clear_website_session() -> Result<()> {
    let _ = website_session_entry()?.delete_credential();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        capability_for_mode, is_custom_hosted_provider_alias, is_hormachuelos_model_alias,
        normalize_capability_for_mode, original_model_selection_from_json,
        prepare_settings_for_save, should_migrate_cursor_grok_to_xai, validate_provider_id,
        Settings, XAI_API_BASE_URL,
    };

    #[test]
    fn rejects_unknown_provider_ids() {
        assert!(validate_provider_id("../../credential").is_err());
    }

    #[test]
    fn accepts_the_dedicated_xai_provider() {
        assert!(validate_provider_id("xai").is_ok());
        assert!(validate_provider_id("gemini_cli").is_ok());
        assert_eq!(XAI_API_BASE_URL, "https://api.x.ai/v1");
    }

    #[test]
    fn permits_safe_dashboard_managed_provider_aliases() {
        assert!(is_custom_hosted_provider_alias("my-neuralwatt"));
        assert!(validate_provider_id("my-neuralwatt").is_ok());
        assert!(!is_custom_hosted_provider_alias("cursor"));
        assert!(!is_custom_hosted_provider_alias("My Provider"));

        let settings = Settings {
            provider: "my-neuralwatt".into(),
            model: "deepseek-v4-flash".into(),
            base_url: Some(crate::license::hosted_chat_base_url()),
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn migrates_only_legacy_grok_settings_without_a_cursor_credential() {
        assert!(should_migrate_cursor_grok_to_xai(
            "cursor",
            "gpt-5.6-sol",
            Some("https://api.cursor.com/v1"),
            false,
            false,
        ));
        assert!(should_migrate_cursor_grok_to_xai(
            "cursor",
            "grok-4.5",
            Some(XAI_API_BASE_URL),
            false,
            true,
        ));
        assert!(!should_migrate_cursor_grok_to_xai(
            "cursor",
            "composer-2.5",
            Some("https://api.cursor.com/v1"),
            true,
            false,
        ));
        assert!(!should_migrate_cursor_grok_to_xai(
            "cursor",
            "grok-4.5",
            Some("https://api.cursor.com/v1"),
            false,
            true,
        ));
    }

    #[test]
    fn permits_custom_model_ids() {
        let settings = Settings {
            model: "vendor/new-tool-model".into(),
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn imports_only_non_secret_original_model_selection() {
        let selection = original_model_selection_from_json(
            r#"{
                "provider": "hormachuelos_free",
                "model": "hormachuelos-v4",
                "model_effort": "ultra",
                "base_url": "https://hormachuelos.vercel.app/api/v1",
                "api_key": "must-not-be-copied",
                "website_session": "must-not-be-copied"
            }"#,
        )
        .unwrap();

        assert_eq!(selection.provider, "hormachuelos_free");
        assert_eq!(selection.model, "hormachuelos-v4");
        assert_eq!(selection.model_effort, "ultra");
        let exported = serde_json::to_string(&selection).unwrap();
        assert!(!exported.contains("api_key"));
        assert!(!exported.contains("website_session"));
        assert!(!exported.contains("base_url"));
    }

    #[test]
    fn computer_use_is_opt_in() {
        assert!(!Settings::default().computer_use_enabled);
        assert!(!Settings::default().desktop_computer_use_enabled);
        assert!(Settings::default()
            .desktop_computer_use_allowed_apps
            .is_empty());
    }

    #[test]
    fn flavour_memory_is_enabled_by_default() {
        assert!(Settings::default().flavour_enabled);
    }

    #[test]
    fn multi_agent_mode_is_a_valid_full_permission_mode() {
        let settings = Settings {
            permission_mode: "multi_agent".into(),
            auto_approve: true,
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn ask_and_research_are_distinct_valid_read_only_modes() {
        let ask = Settings {
            permission_mode: "ask".into(),
            auto_approve: false,
            ..Settings::default()
        };
        assert!(ask.validate().is_ok());
        let research = Settings {
            permission_mode: "research".into(),
            auto_approve: false,
            ..Settings::default()
        };
        assert!(research.validate().is_ok());
        assert_eq!(capability_for_mode("research"), "investigate");
        assert_eq!(capability_for_mode("ask"), "answer_max");
    }

    #[test]
    fn adaptive_director_is_the_default_and_legacy_modes_migrate_capabilities() {
        let defaults = Settings::default();
        assert_eq!(defaults.permission_mode, "adaptive");
        assert_eq!(defaults.capability_mode, "balanced");
        assert!(defaults.auto_approve);
        assert_eq!(capability_for_mode("auto"), "balanced");
        assert_eq!(capability_for_mode("full"), "agent");
        assert_eq!(capability_for_mode("build"), "agent");
        assert_eq!(
            normalize_capability_for_mode("research", "max"),
            "investigate"
        );
        assert_eq!(
            normalize_capability_for_mode("build", "balanced"),
            "balanced"
        );
        assert_eq!(
            normalize_capability_for_mode("multi_agent", "agent"),
            "autonomous"
        );
    }

    fn agentic_settings(capability: &str) -> Settings {
        Settings {
            permission_mode: "agentic".into(),
            capability_mode: capability.into(),
            auto_approve: true,
            ..Settings::default()
        }
    }

    fn assert_agentic_round_trip(capability: &str) {
        let prepared = prepare_settings_for_save(agentic_settings(capability))
            .unwrap_or_else(|error| panic!("AGENTIC + {capability} must save: {error}"));
        assert_eq!(prepared.permission_mode, "agentic");
        assert_eq!(prepared.capability_mode, capability);
        assert!(prepared.auto_approve);

        let json = serde_json::to_string(&prepared).expect("serialize AGENTIC settings");
        let mut loaded: Settings =
            serde_json::from_str(&json).expect("reload AGENTIC settings from saved JSON");
        loaded.capability_mode =
            normalize_capability_for_mode(&loaded.permission_mode, &loaded.capability_mode);
        loaded
            .validate()
            .unwrap_or_else(|error| panic!("reloaded AGENTIC + {capability} must validate: {error}"));
        assert_eq!(loaded.permission_mode, "agentic");
        assert_eq!(loaded.capability_mode, capability);
    }

    #[test]
    fn agentic_orchestrated_settings_save_and_reload() {
        assert_agentic_round_trip("orchestrated");
    }

    #[test]
    fn agentic_thorough_settings_save_and_reload() {
        assert_agentic_round_trip("thorough");
    }

    #[test]
    fn save_settings_ipc_accepts_an_agentic_payload() {
        let prepared = prepare_settings_for_save(agentic_settings("orchestrated"))
            .expect("save_settings must accept an AGENTIC settings payload");
        assert_eq!(prepared.permission_mode, "agentic");
        assert_eq!(prepared.capability_mode, "orchestrated");

        let thorough = prepare_settings_for_save(Settings {
            capability_mode: "thorough".into(),
            ..agentic_settings("orchestrated")
        })
        .expect("save_settings must accept AGENTIC + thorough");
        assert_eq!(thorough.permission_mode, "agentic");
        assert_eq!(thorough.capability_mode, "thorough");
    }

    #[test]
    fn accepts_legacy_iteration_values_without_capping_runs() {
        let unlimited = Settings {
            max_iterations: 0,
            ..Settings::default()
        };
        assert!(unlimited.validate().is_ok());

        let old_high_value = Settings {
            max_iterations: u32::MAX,
            ..unlimited
        };
        assert!(old_high_value.validate().is_ok());
    }

    #[test]
    fn permits_server_managed_hormachuelos_free_aliases() {
        let settings = Settings {
            provider: "hormachuelos_free".into(),
            model: "hormachuelos-v1".into(),
            base_url: Some("https://hormachuelos.vercel.app/api/v1".into()),
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());

        let v2 = Settings {
            model: "hormachuelos-v2".into(),
            ..settings.clone()
        };
        assert!(v2.validate().is_ok());
        let v4 = Settings {
            model: "hormachuelos-v4".into(),
            ..settings.clone()
        };
        assert!(v4.validate().is_ok());
        assert!(is_hormachuelos_model_alias("hormachuelos-custom_1"));

        let wrong_model = Settings {
            model: "deepseek-v4-flash".into(),
            ..settings
        };
        assert!(wrong_model.validate().is_err());
    }
}
