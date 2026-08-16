import {
  deleteHostedModelConfig,
  getHostedModelConfigById,
  getHostedModelConfig,
  insertHostedModelConfig,
  listHostedModelConfigs,
  supabaseConfigured,
  updateHostedModelConfig,
} from "./supabase.js";
import {
  decryptHostedModelCredential,
  encryptHostedModelCredential,
  hostedModelCredentialStorageReady,
} from "./secret-box.js";

export const HORMACHUELOS_FREE_PROVIDER = "hormachuelos_free";
export const XAI_PROVIDER = "xai";
export const COMMANDCODE_PROVIDER = "commandcode";
// A provider profile is stored alongside model aliases in the existing
// encrypted, service-role-only table. Keeping it in the same protected store
// means a dashboard upgrade does not require a public schema change before an
// administrator can safely manage providers and their keys.
export const PROVIDER_PROFILE_ALIAS = "hormachuelos-provider-profile-v1";

/**
 * Built-in provider ids that can be managed from the admin dashboard. They
 * are all forwarded through the OpenAI-compatible hosted proxy when an admin
 * route is configured for them. A custom provider alias uses the same safe
 * route format, so it never needs to be added to a desktop build first.
 */
export const BUILTIN_HOSTED_PROVIDERS = Object.freeze([
  HORMACHUELOS_FREE_PROVIDER,
  XAI_PROVIDER,
  COMMANDCODE_PROVIDER,
  "openai",
  "deepseek",
  "openrouter",
  "glm",
  "pollinations",
  "anthropic",
  "gemini",
]);

// Cursor uses its local SDK and Ollama is intentionally local-only. Neither
// can be safely represented as a server-side OpenAI-compatible route.
const LOCAL_ONLY_PROVIDERS = new Set(["cursor", "ollama", "gemini_cli"]);
const PROVIDER_ALIAS_RE = /^[a-z][a-z0-9_-]{0,48}$/;
// Model aliases may include provider-prefixed ids (e.g. "deepseek/deepseek-v4-pro")
// so the desktop's real model ids can be used as public aliases. The alias is
// used only as an exact-map lookup key, never in a URL, path, or SQL value.
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,100}$/;
let routeCache = null;
let routeCacheAt = 0;
const CACHE_MS = 10_000;

const PROVIDER_DEFAULTS = Object.freeze({
  [HORMACHUELOS_FREE_PROVIDER]: {
    displayName: "HORMACHUELOS FREE",
    baseUrl: "https://api.neuralwatt.com/v1",
  },
  [XAI_PROVIDER]: { displayName: "xAI", baseUrl: "https://api.x.ai/v1" },
  // Command Code uses its own hosted gateway, which is not OpenAI-compatible.
  // The v1 proxy translates requests into the /alpha/generate envelope.
  [COMMANDCODE_PROVIDER]: {
    displayName: "HORMACHUELOS NEW MODELS",
    baseUrl: "https://api.commandcode.ai",
  },
  openai: { displayName: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  deepseek: { displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  openrouter: { displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  glm: { displayName: "OpenCode", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  pollinations: { displayName: "Pollinations", baseUrl: "https://gen.pollinations.ai/v1" },
  // These hosted routes need an OpenAI-compatible upstream proxy. The default
  // points at the existing OpenRouter-compatible path, but an administrator
  // can set a different compatible endpoint in the dashboard.
  anthropic: { displayName: "Anthropic", baseUrl: "https://openrouter.ai/api/v1" },
  gemini: { displayName: "Gemini", baseUrl: "https://openrouter.ai/api/v1" },
});

function inputText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw Object.assign(new Error(`${label} is required and must be valid.`), { status: 400 });
  }
  return text;
}

function validHostedBaseUrl(value) {
  const raw = inputText(value, "Base URL", 400);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Base URL must be a complete HTTPS URL."), { status: 400 });
  }
  const host = url.hostname.toLowerCase();
  const privateIpv4 =
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    privateIpv4
  ) {
    throw Object.assign(new Error("Base URL must be a public HTTPS endpoint."), { status: 400 });
  }
  return url.toString().replace(/\/$/, "");
}

function optionalHostedBaseUrl(value) {
  const raw = String(value || "").trim();
  return raw ? validHostedBaseUrl(raw) : "";
}

export function isHostedProviderAlias(value) {
  const provider = String(value || "").trim().toLowerCase();
  return PROVIDER_ALIAS_RE.test(provider) && !LOCAL_ONLY_PROVIDERS.has(provider);
}

/** Normalize a built-in id or a new dashboard-created provider alias. */
export function normalizeHostedProviderAlias(value) {
  const provider = String(value || HORMACHUELOS_FREE_PROVIDER).trim().toLowerCase();
  if (!isHostedProviderAlias(provider)) {
    throw Object.assign(
      new Error(
        "Provider alias must use lowercase letters, numbers, dashes, or underscores (and cannot be cursor, ollama, or gemini_cli).",
      ),
      { status: 400 },
    );
  }
  return provider;
}

function normalizeProvider(value) {
  return normalizeHostedProviderAlias(value);
}

function normalizeAlias(value) {
  // Preserve case: Command Code model ids are case-sensitive (e.g.
  // "Qwen/Qwen3.6-Max-Preview", "MiniMaxAI/MiniMax-M3").
  const alias = String(value || "").trim();
  if (!ALIAS_RE.test(alias)) {
    throw Object.assign(
      new Error("Model alias uses unsupported characters."),
      { status: 400 },
    );
  }
  return alias;
}

export function isHostedProviderProfileRow(row) {
  return String(row?.alias || "").trim().toLowerCase() === PROVIDER_PROFILE_ALIAS;
}

function normalizeConfig(body) {
  const alias = normalizeAlias(body.alias);
  if (alias === PROVIDER_PROFILE_ALIAS) {
    throw Object.assign(new Error("That model alias is reserved for a provider profile."), {
      status: 400,
    });
  }
  return {
    provider_id: normalizeProvider(body.providerId || body.provider_id),
    alias,
    display_name: inputText(body.displayName || body.display_name, "Display name", 120),
    upstream_model: inputText(body.upstreamModel || body.upstream_model, "Upstream model", 200),
    // A model can inherit the provider profile endpoint. Existing records keep
    // their own endpoint and therefore continue to work unchanged.
    base_url: optionalHostedBaseUrl(body.baseUrl || body.base_url),
    active: body.active !== false,
  };
}

function normalizeProviderProfile(body) {
  const provider_id = normalizeProvider(body?.providerId || body?.provider_id);
  return {
    provider_id,
    display_name: inputText(
      body?.displayName || body?.display_name || hostedProviderDefaultProfile(provider_id).displayName,
      "Provider display name",
      120,
    ),
    base_url: validHostedBaseUrl(
      body?.baseUrl || body?.base_url || hostedProviderDefaultProfile(provider_id).baseUrl,
    ),
    active: body?.active !== false,
  };
}

/** Safe response shape for the admin UI: it deliberately never includes a credential. */
export function publicHostedModelConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id,
    alias: row.alias,
    displayName: row.display_name,
    upstreamModel: row.upstream_model,
    baseUrl: row.base_url,
    active: Boolean(row.active),
    keyConfigured: Boolean(String(row.api_key_ciphertext || "").trim()),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Synthetic FREE Vision alias that borrows the Command Code credential at runtime. */
export const HORMACHUELOS_V4_ALIAS = "hormachuelos-v4";
const HORMACHUELOS_V4_DISPLAY_NAME = "Hormachuelos v4 (VISION)";
const HORMACHUELOS_V4_UPSTREAM_MODEL = "deepseek/deepseek-v4-flash";
const HORMACHUELOS_V4_BASE_URL = "https://api.commandcode.ai";
const HORMACHUELOS_V4_VIRTUAL_ID = "virtual:hormachuelos-v4";

function commandCodeCredentialConfigured(rows) {
  const hasStoredKey = (Array.isArray(rows) ? rows : []).some((row) => {
    const provider = String(row?.provider_id || "").trim().toLowerCase();
    return provider === COMMANDCODE_PROVIDER && Boolean(String(row?.api_key_ciphertext || "").trim());
  });
  if (hasStoredKey) return true;
  return Boolean(String(process.env.COMMANDCODE_API_KEY || "").trim());
}

function hasHormachuelosV4Alias(configs) {
  return (Array.isArray(configs) ? configs : []).some((config) => {
    return (
      String(config?.providerId || "").trim().toLowerCase() === HORMACHUELOS_FREE_PROVIDER &&
      String(config?.alias || "").trim().toLowerCase() === HORMACHUELOS_V4_ALIAS
    );
  });
}

export function syntheticHormachuelosV4AdminConfig({ available = false } = {}) {
  return {
    id: HORMACHUELOS_V4_VIRTUAL_ID,
    providerId: HORMACHUELOS_FREE_PROVIDER,
    alias: HORMACHUELOS_V4_ALIAS,
    displayName: HORMACHUELOS_V4_DISPLAY_NAME,
    upstreamModel: HORMACHUELOS_V4_UPSTREAM_MODEL,
    baseUrl: HORMACHUELOS_V4_BASE_URL,
    active: Boolean(available),
    keyConfigured: Boolean(available),
    virtual: true,
    systemManaged: true,
    note: available
      ? "Uses the HORMACHUELOS NEW MODELS (Command Code) API key at runtime"
      : "Configure HORMACHUELOS NEW MODELS with an API key to enable Vision",
    createdAt: null,
    updatedAt: null,
  };
}

function withSyntheticHormachuelosV4(configs, rows) {
  const list = (Array.isArray(configs) ? configs : []).filter(Boolean);
  if (hasHormachuelosV4Alias(list)) return list;
  return [
    ...list,
    syntheticHormachuelosV4AdminConfig({
      available: commandCodeCredentialConfigured(rows),
    }),
  ];
}

/** Public-safe provider profile. Credentials are write-only and never serialized. */
export function publicHostedProviderConfig(row, { modelCount = 0, providerId: fallbackProviderId = "" } = {}) {
  const providerId = String(row?.provider_id || fallbackProviderId || "").trim().toLowerCase();
  const defaults = hostedProviderDefaultProfile(providerId);
  return {
    id: row?.id || null,
    providerId,
    displayName: String(row?.display_name || defaults.displayName),
    baseUrl: String(row?.base_url || defaults.baseUrl),
    active: row ? Boolean(row.active) : true,
    keyConfigured: Boolean(String(row?.api_key_ciphertext || "").trim()),
    profileConfigured: Boolean(row),
    modelCount: Math.max(0, Number(modelCount) || 0),
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  };
}

/** Friendly names are derived from the stable provider alias, not a secret. */
export function hostedProviderDisplayName(providerId) {
  const provider = String(providerId || "").trim().toLowerCase();
  const known = {
    [HORMACHUELOS_FREE_PROVIDER]: "HORMACHUELOS FREE",
    [XAI_PROVIDER]: "xAI",
    [COMMANDCODE_PROVIDER]: "HORMACHUELOS NEW MODELS",
    openai: "OpenAI",
    cursor: "OpenAI",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    glm: "OpenCode",
    pollinations: "Pollinations",
    anthropic: "Anthropic",
    gemini: "Gemini",
  };
  if (known[provider]) return known[provider];
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Hosted provider";
}

/** Defaults used only to prefill a dashboard profile; no credential is implied. */
export function hostedProviderDefaultProfile(providerId) {
  const provider = String(providerId || "").trim().toLowerCase();
  const known = PROVIDER_DEFAULTS[provider];
  return {
    providerId: provider,
    displayName: known?.displayName || hostedProviderDisplayName(provider),
    baseUrl: known?.baseUrl || "",
    active: true,
  };
}

/** Options shown by the dashboard before it has any custom provider rows. */
export function hostedProviderOptions() {
  return BUILTIN_HOSTED_PROVIDERS.map((id) => ({ id, label: hostedProviderDisplayName(id) }));
}

export function invalidateHostedModelRouteCache() {
  routeCache = null;
  routeCacheAt = 0;
}

export async function adminListHostedModelConfigs() {
  const rows = await listHostedModelConfigs();
  const modelRows = rows.filter((row) => !isHostedProviderProfileRow(row));
  const configs = withSyntheticHormachuelosV4(
    modelRows.map(publicHostedModelConfig),
    rows,
  );
  return {
    credentialStorageReady: hostedModelCredentialStorageReady(),
    providerOptions: hostedProviderOptions(),
    configs,
  };
}

/**
 * The provider registry powers the admin dashboard. Profiles have a writable
 * label, endpoint, activation state, and default encrypted credential; model
 * aliases under the provider may optionally carry their own key override.
 */
export async function adminListHostedProviderConfigs() {
  const rows = await listHostedModelConfigs();
  const profileRows = rows.filter(isHostedProviderProfileRow);
  const modelRows = rows.filter((row) => !isHostedProviderProfileRow(row));
  const profileByProvider = new Map(
    profileRows.map((row) => [String(row.provider_id || "").trim().toLowerCase(), row]),
  );
  const configs = withSyntheticHormachuelosV4(
    modelRows.map(publicHostedModelConfig),
    rows,
  );
  const modelCountByProvider = new Map();
  for (const config of configs) {
    const provider = String(config.providerId || "").trim().toLowerCase();
    modelCountByProvider.set(provider, (modelCountByProvider.get(provider) || 0) + 1);
  }
  const providerIds = new Set([
    ...BUILTIN_HOSTED_PROVIDERS,
    ...profileByProvider.keys(),
    ...modelCountByProvider.keys(),
  ]);
  const providers = [...providerIds]
    .filter(Boolean)
    .map((providerId) => publicHostedProviderConfig(profileByProvider.get(providerId), {
      modelCount: modelCountByProvider.get(providerId) || 0,
      providerId,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  return {
    credentialStorageReady: hostedModelCredentialStorageReady(),
    providerOptions: providers.map(({ providerId, displayName }) => ({ id: providerId, label: displayName })),
    providers,
    configs,
  };
}

function applyCredentialChange(body, patch) {
  const replaceCredential = Object.prototype.hasOwnProperty.call(body || {}, "apiKey") ||
    Object.prototype.hasOwnProperty.call(body || {}, "api_key");
  const clearCredential = body?.clearApiKey === true || body?.clear_api_key === true;
  const rawCredential = String(body?.apiKey ?? body?.api_key ?? "").trim();
  if (clearCredential && rawCredential) {
    throw Object.assign(new Error("Choose either a replacement key or clear the existing key."), {
      status: 400,
    });
  }
  if (replaceCredential && rawCredential.length > 4096) {
    throw Object.assign(new Error("API key is too long."), { status: 400 });
  }
  if (clearCredential) {
    patch.api_key_ciphertext = "";
  } else if (replaceCredential && rawCredential) {
    patch.api_key_ciphertext = encryptHostedModelCredential(rawCredential);
  }
}

export async function adminSaveHostedModelConfig(body) {
  const id = String(body?.id || "").trim();
  const alias = String(body?.alias || body?.model || "").trim().toLowerCase();
  if (id === HORMACHUELOS_V4_VIRTUAL_ID || alias === HORMACHUELOS_V4_ALIAS) {
    // Vision is synthesized from the Command Code credential; keep it out of the
    // editable alias table so admins do not store a duplicate broken route.
    throw Object.assign(
      new Error(
        "Hormachuelos v4 is managed automatically from HORMACHUELOS NEW MODELS. Configure that provider's API key instead of editing this alias.",
      ),
      { status: 400 },
    );
  }
  const input = normalizeConfig(body || {});

  let existing = null;
  if (id) {
    existing = await getHostedModelConfigById(id);
    if (!existing) throw Object.assign(new Error("Hosted model configuration not found."), { status: 404 });
    if (isHostedProviderProfileRow(existing)) {
      throw Object.assign(new Error("Use the provider controls to edit a provider profile."), {
        status: 400,
      });
    }
  } else {
    existing = await getHostedModelConfig(input.provider_id, input.alias);
  }

  const patch = { ...input };
  applyCredentialChange(body, patch);

  const saved = existing
    ? await updateHostedModelConfig(existing.id, patch)
    : await insertHostedModelConfig({ ...patch, api_key_ciphertext: patch.api_key_ciphertext || "" });
  invalidateHostedModelRouteCache();
  return publicHostedModelConfig(saved);
}

export async function adminSaveHostedProviderConfig(body) {
  const input = normalizeProviderProfile(body || {});
  const id = String(body?.id || "").trim();
  let existing = null;
  if (id) {
    existing = await getHostedModelConfigById(id);
    if (!existing || !isHostedProviderProfileRow(existing)) {
      throw Object.assign(new Error("Hosted provider configuration not found."), { status: 404 });
    }
    if (String(existing.provider_id || "").trim().toLowerCase() !== input.provider_id) {
      throw Object.assign(
        new Error("Provider ID is stable after creation. Create a new provider ID and move model aliases deliberately."),
        { status: 409 },
      );
    }
  } else {
    existing = await getHostedModelConfig(input.provider_id, PROVIDER_PROFILE_ALIAS);
  }

  const patch = {
    ...input,
    alias: PROVIDER_PROFILE_ALIAS,
    upstream_model: PROVIDER_PROFILE_ALIAS,
  };
  applyCredentialChange(body, patch);
  const saved = existing
    ? await updateHostedModelConfig(existing.id, patch)
    : await insertHostedModelConfig({ ...patch, api_key_ciphertext: patch.api_key_ciphertext || "" });
  invalidateHostedModelRouteCache();
  return publicHostedProviderConfig(saved);
}

export async function adminDeleteHostedProviderConfig(providerId) {
  const provider = normalizeProvider(providerId);
  const rows = await listHostedModelConfigs();
  const models = rows.filter(
    (row) => String(row.provider_id || "").trim().toLowerCase() === provider && !isHostedProviderProfileRow(row),
  );
  if (models.length) {
    throw Object.assign(
      new Error("Delete or move this provider's model aliases before removing its provider profile."),
      { status: 409 },
    );
  }
  const profile = rows.find(
    (row) => String(row.provider_id || "").trim().toLowerCase() === provider && isHostedProviderProfileRow(row),
  );
  if (!profile) throw Object.assign(new Error("Hosted provider configuration not found."), { status: 404 });
  await deleteHostedModelConfig(profile.id);
  invalidateHostedModelRouteCache();
}

export async function adminDeleteHostedModelConfig(id) {
  const configId = String(id || "").trim();
  if (configId === HORMACHUELOS_V4_VIRTUAL_ID) {
    throw Object.assign(
      new Error("Hormachuelos v4 is managed automatically and cannot be deleted from this list."),
      { status: 400 },
    );
  }
  const existing = await getHostedModelConfigById(configId);
  if (!existing) throw Object.assign(new Error("Hosted model configuration not found."), { status: 404 });
  if (isHostedProviderProfileRow(existing)) {
    throw Object.assign(new Error("Use the provider controls to remove a provider profile."), { status: 400 });
  }
  await deleteHostedModelConfig(existing.id);
  invalidateHostedModelRouteCache();
}

/**
 * Load all decryptable, active model routes for the hosted proxy. This stays
 * server-side: `apiKey` is never returned from the admin API or public
 * catalog. A bad record fails closed while unrelated routes continue working.
 */
export async function activeAllHostedModelRoutes() {
  if (!supabaseConfigured()) return [];
  const now = Date.now();
  if (!routeCache || now - routeCacheAt > CACHE_MS) {
    const rows = await listHostedModelConfigs();
    const providerProfiles = new Map(
      rows
        .filter(isHostedProviderProfileRow)
        .map((row) => [String(row.provider_id || "").trim().toLowerCase(), row]),
    );
    const routes = [];
    for (const row of rows.filter((candidate) => !isHostedProviderProfileRow(candidate))) {
      try {
        const providerId = String(row.provider_id || "").trim().toLowerCase();
        const profile = providerProfiles.get(providerId);
        if (!row.active || (profile && !profile.active)) continue;
        const modelKey = decryptHostedModelCredential(row.api_key_ciphertext);
        // A model-specific credential must remain usable even if an unrelated
        // provider-default credential was rotated incorrectly or cannot be
        // decrypted on this server.
        const providerKey = !modelKey && profile
          ? decryptHostedModelCredential(profile.api_key_ciphertext)
          : "";
        const apiKey = modelKey || providerKey;
        const baseUrl = String(row.base_url || profile?.base_url || "").trim();
        if (!apiKey || !baseUrl) continue;
        routes.push({
          id: row.id,
          providerId,
          providerDisplayName: String(
            profile?.display_name || hostedProviderDefaultProfile(providerId).displayName,
          ),
          alias: row.alias,
          displayName: row.display_name,
          upstreamModel: row.upstream_model,
          baseUrl,
          apiKey,
        });
      } catch (error) {
        // Fail closed for one invalid row while keeping the remaining hosted
        // models available. Do not log the encrypted value or credential.
        console.error(`Hosted model config ${row.id} is unavailable: ${String(error?.message || error)}`);
      }
    }
    routeCache = routes;
    routeCacheAt = now;
  }
  return routeCache;
}

/** Load active routes belonging to one built-in or custom provider alias. */
export async function activeHostedModelRoutes(providerId = HORMACHUELOS_FREE_PROVIDER) {
  const provider = normalizeProvider(providerId);
  return (await activeAllHostedModelRoutes()).filter((route) => route.providerId === provider);
}

/**
 * Public-safe catalog for the desktop picker. It intentionally omits upstream
 * model ids, base URLs, encrypted values, and API keys.
 */
export function publicHostedProviderCatalogFromRoutes(routes) {
  const grouped = new Map();
  for (const route of Array.isArray(routes) ? routes : []) {
    const current = grouped.get(route.providerId) || [];
    current.push(route);
    grouped.set(route.providerId, current);
  }
  return [...grouped.entries()]
    .sort(([left, leftRoutes], [right, rightRoutes]) => {
      const leftLabel = leftRoutes[0]?.providerDisplayName || hostedProviderDisplayName(left);
      const rightLabel = rightRoutes[0]?.providerDisplayName || hostedProviderDisplayName(right);
      return leftLabel.localeCompare(rightLabel);
    })
    .map(([id, routes]) => ({
      id,
      label: String(routes[0]?.providerDisplayName || hostedProviderDisplayName(id)),
      models: routes
        .slice()
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map((route) => ({ id: route.alias, label: route.displayName })),
    }));
}

export async function publicHostedProviderCatalog() {
  return publicHostedProviderCatalogFromRoutes(await activeAllHostedModelRoutes());
}
