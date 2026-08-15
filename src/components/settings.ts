import {
  api,
  onComputerUseStatus,
  type ComputerUseStatus,
  type DesktopComputerUseStatus,
  type HostedProviderCatalogEntry,
  type IntegrationStatus,
  type Settings,
} from "../ipc";
import { clear, div, el, escapeHtml, displayPlanLabel } from "./util";
import { icon, logo } from "./icons";

export type ProviderDef = {
  id: string;
  label: string;
  logoKey:
    | "deepseek"
    | "openrouter"
    | "glm"
    | "ollama"
    | "openai"
    | "grok"
    | "hormachuelos"
    | "commandcode"
    | "gemini";
  logoSrc: string;
  defaultModel: string;
  defaultBaseUrl: string;
  keyUrl: string;
  keyRequired: boolean;
  models: string[];
  /** Hide compatibility entries from provider pickers. */
  hidden?: boolean;
  /** True when aliases and credentials are administered by the hosted service. */
  hostedManaged?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    // BYOK xAI remains available for existing installs, but is hidden from the
    // provider picker. Public OpenAI branding routes through the Cursor alias.
    id: "xai",
    label: "xAI",
    logoKey: "grok",
    logoSrc: "./logos/grok.png",
    defaultModel: "grok-4.5",
    defaultBaseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    keyRequired: true,
    // Stable built-in alias. The desktop sends the real model id below.
    models: ["grok-4.5"],
    hidden: true,
  },
  {
    // Public OpenAI alias over the Cursor SDK. Sol/Luna are display names for
    // the pinned Cursor model ids; credentials remain Cursor `crsr_…` keys.
    id: "cursor",
    label: "OpenAI",
    logoKey: "openai",
    logoSrc: "./logos/openai.svg",
    defaultModel: "grok-4.5",
    defaultBaseUrl: "https://api.cursor.com/v1",
    keyUrl: "https://cursor.com/dashboard?tab=integrations",
    keyRequired: true,
    models: ["grok-4.5", "composer-2.5"],
  },
  {
    // Preserve native OpenAI settings for existing installations without
    // exposing a second OpenAI entry in the provider picker.
    id: "openai",
    label: "OpenAI API",
    logoKey: "openai",
    logoSrc: "./logos/openai.svg",
    defaultModel: "gpt-5.6-sol",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyRequired: true,
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    hidden: true,
  },
  {
    id: "hormachuelos_free",
    label: "Hormachuelos",
    logoKey: "hormachuelos",
    logoSrc: "./logos/hormachuelos-free.png",
    defaultModel: "hormachuelos-v1",
    defaultBaseUrl: "https://hormachuelos.vercel.app/api/v1",
    keyUrl: "",
    keyRequired: false,
    // The signed-in desktop refreshes this catalog from the hosted service.
    // These are safe offline fallbacks, not credentials.
    models: ["hormachuelos-v1", "hormachuelos-v2", "hormachuelos-v3", "hormachuelos-v4"],
  },
  {
    id: "ollama",
    label: "Ollama",
    logoKey: "ollama",
    logoSrc: "./logos/ollama.svg",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://localhost:11434/v1",
    keyUrl: "https://ollama.com/download",
    keyRequired: false,
    models: [
      "llama3.2",
      "llama3.1",
      "qwen2.5-coder",
      "qwen2.5",
      "mistral",
      "gemma2",
      "phi3",
      "codellama",
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    logoKey: "deepseek",
    logoSrc: "./logos/deepseek.png",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyRequired: true,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    logoKey: "openrouter",
    logoSrc: "./logos/openrouter.svg",
    defaultModel: "openrouter/free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    // Free Models Router uses the Hormachuelos hosted OpenRouter key when a
    // plan is active. A local key is optional BYOK only.
    keyRequired: false,
    models: ["openrouter/free"],
  },
  {
    id: "gemini",
    label: "Gemini",
    logoKey: "gemini",
    logoSrc: "./logos/gemini.svg",
    defaultModel: "gemini-3.7-flash",
    defaultBaseUrl: "https://hormachuelos.vercel.app/api/v1",
    keyUrl: "https://commandcode.ai/docs/studio/api-keys",
    keyRequired: false,
    hostedManaged: true,
    models: [
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
  },
  {
    id: "gemini_cli",
    label: "Gemini CLI",
    logoKey: "gemini",
    logoSrc: "./logos/gemini.svg",
    defaultModel: "gemini-3.5-flash",
    defaultBaseUrl: "https://cloudcode-pa.googleapis.com",
    keyUrl: "",
    keyRequired: false,
    models: [
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
  },
  {
    id: "glm",
    label: "OpenCode",
    logoKey: "glm",
    logoSrc: "./logos/opencode.svg",
    defaultModel: "deepseek-v4-flash-free",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    keyUrl: "https://opencode.ai/auth",
    keyRequired: true,
    // Free OpenCode Zen models only (not paid Go / Zen catalog).
    models: [
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "north-mini-code-free",
      "ling-3.0-flash-free",
      "laguna-s-2.1-free",
      "nemotron-3-ultra-free",
      "big-pickle",
    ],
    hidden: true,
  },
  {
    id: "commandcode",
    label: "HORMACHUELOS NEW MODELS",
    logoKey: "commandcode",
    logoSrc: "./logos/commandcode.svg",
    defaultModel: "deepseek/deepseek-v4-flash",
    // Hosted through the shared server-side key on paid plans; direct BYOK
    // with a local key also works (agent.rs picks the native gateway).
    defaultBaseUrl: "https://hormachuelos.vercel.app/api/v1",
    keyUrl: "https://commandcode.ai",
    // Clients on a paid Hormachuelos plan use the shared server-side key
    // through the hosted proxy. A local BYOK key is optional.
    keyRequired: false,
    hostedManaged: true,
    // DeepSeek V4 Flash moved to HORMACHUELOS FREE as Hormachuelos v4 (VISION).
    // Keep the provider definition for admin/BYOK compatibility, but hide it
    // from the desktop picker.
    hidden: true,
    // The gateway accepts the same model ids as `cmd --list-models`.
    models: [
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
    ],
  },
];

const HOSTED_PROXY_BASE_URL = "https://hormachuelos.vercel.app/api/v1";
const BUILTIN_PROVIDERS: ProviderDef[] = PROVIDERS.map((provider) => ({
  ...provider,
  models: [...provider.models],
}));
/** Providers that run on this PC, not through the Hormachuelos hosted catalog. */
export const LOCAL_MACHINE_PROVIDER_IDS = new Set(["ollama", "gemini_cli"]);

export function isLocalMachineProvider(providerId: string): boolean {
  return LOCAL_MACHINE_PROVIDER_IDS.has(String(providerId || "").trim().toLowerCase());
}
const HOSTED_PROVIDER_CATALOG = new Map<string, HostedProviderCatalogEntry>();
const HOSTED_MODEL_DISPLAY_NAMES = new Map<string, string>();
/** When true, the server allowlist is exclusive — no builtin provider/model fallbacks. */
let hostedCatalogRestricted = false;

export function isHostedCatalogRestricted(): boolean {
  return hostedCatalogRestricted;
}

function hostedModelNameKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function isHostedProviderAlias(value: string): boolean {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,48}$/.test(id) && id !== "cursor" && id !== "ollama" && id !== "gemini_cli";
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function fallbackHostedProvider(id: string): ProviderDef {
  const label = id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Hosted provider";
  return {
    id,
    label,
    logoKey: "hormachuelos",
    logoSrc: "./logos/hormachuelos-free.png",
    defaultModel: "",
    defaultBaseUrl: HOSTED_PROXY_BASE_URL,
    keyUrl: "",
    keyRequired: false,
    models: [],
    hostedManaged: true,
  };
}

function providerFromHostedCatalog(entry: HostedProviderCatalogEntry): ProviderDef | null {
  const id = String(entry?.id || "").trim().toLowerCase();
  if (!isHostedProviderAlias(id)) return null;
  const label = String(entry?.label || "").trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) return null;
  const models = uniqueModels(
    Array.isArray(entry.models)
      ? entry.models
          .map((model) => String(model?.id || "").trim())
          .filter((model) => model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model))
      : [],
  );
  if (!models.length) return null;
  const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === id);
  if (!builtin) {
    return {
      ...fallbackHostedProvider(id),
      label,
      defaultModel: models[0],
      models,
    };
  }
  // HORMACHUELOS FREE deliberately keeps its installed V1/V2 fallback aliases
  // visible while newer aliases come from the server — unless this account is
  // under an admin allowlist, in which case the server list is exclusive.
  const approvedModels = hostedCatalogRestricted
    ? models
    : id === "hormachuelos_free" || id === "gemini"
      ? uniqueModels([...builtin.models, ...models])
      : id === "openrouter"
        ? ["openrouter/free"]
        : models;
  return {
    ...builtin,
    label,
    // Keep intentionally hidden built-ins out of the picker (xAI, OpenCode).
    hidden: Boolean(builtin.hidden),
    hostedManaged: true,
    defaultModel: id === "openrouter" ? "openrouter/free" : (approvedModels[0] || builtin.defaultModel),
    defaultBaseUrl: HOSTED_PROXY_BASE_URL,
    keyUrl: "",
    keyRequired: false,
    models: approvedModels,
  };
}

function rebuildProviderCatalog() {
  const managed = new Map<string, ProviderDef>();
  for (const entry of HOSTED_PROVIDER_CATALOG.values()) {
    const provider = providerFromHostedCatalog(entry);
    if (provider) managed.set(provider.id, provider);
  }

  // Keep local machine providers such as Gemini CLI and Ollama in the picker.
  // Admin allowlists hide hosted BYOK chips. These local providers do not use
  // the Hormachuelos plan catalog.
  if (hostedCatalogRestricted && managed.size > 0) {
    const providers = [...managed.values()].map((provider) => ({
      ...provider,
      hidden: false,
      models: [...provider.models],
    }));
    appendLocalMachineProviders(providers);
    PROVIDERS.splice(0, PROVIDERS.length, ...providers);
    return;
  }

  const providers = BUILTIN_PROVIDERS.map((provider) => managed.get(provider.id) || {
    ...provider,
    models: [...provider.models],
  });
  for (const provider of managed.values()) {
    if (!BUILTIN_PROVIDERS.some((builtin) => builtin.id === provider.id)) providers.push(provider);
  }
  PROVIDERS.splice(0, PROVIDERS.length, ...providers);
}

/** Store a fresh, public-safe catalog after a successful hosted API request. */
export function setHostedProviderCatalog(
  entries: readonly HostedProviderCatalogEntry[],
  options?: { restricted?: boolean },
) {
  hostedCatalogRestricted = Boolean(options?.restricted);
  HOSTED_PROVIDER_CATALOG.clear();
  HOSTED_MODEL_DISPLAY_NAMES.clear();
  for (const entry of entries) {
    const provider = providerFromHostedCatalog(entry);
    if (!provider || HOSTED_PROVIDER_CATALOG.has(provider.id)) continue;
    // Keep friendly names for every catalog model the picker can actually
    // show. Hosted-managed providers (including dashboard-created ones) must
    // accept newly added aliases without waiting for a desktop rebuild.
    const models = entry.models
      .map((model) => ({ id: String(model?.id || "").trim(), label: String(model?.label || "").trim() }))
      .filter((model) =>
        model.id.length > 0 &&
        model.label.length > 0 &&
        model.label.length <= 120 &&
        !/[\u0000-\u001f\u007f]/.test(model.label) &&
        (hostedCatalogRestricted || provider.hostedManaged || provider.models.includes(model.id)),
      );
    if (!models.length) continue;
    HOSTED_PROVIDER_CATALOG.set(provider.id, {
      id: provider.id,
      label: provider.label,
      models,
    });
    for (const model of models) {
      HOSTED_MODEL_DISPLAY_NAMES.set(hostedModelNameKey(provider.id, model.id), model.label);
    }
  }
  rebuildProviderCatalog();
}

/** Fetch current administrator-managed aliases without ever receiving API keys. */
export async function refreshHostedProviderCatalog(): Promise<HostedProviderCatalogEntry[]> {
  const raw = await api.listHostedProviderCatalog();
  const payload = Array.isArray(raw)
    ? { data: raw, restricted: false }
    : {
        data: Array.isArray(raw?.data) ? raw.data : [],
        restricted: Boolean(raw?.restricted),
      };
  setHostedProviderCatalog(payload.data, { restricted: payload.restricted });
  return payload.data;
}

function localMachineBuiltinProviders(): ProviderDef[] {
  return BUILTIN_PROVIDERS
    .filter((provider) => isLocalMachineProvider(provider.id))
    .map((provider) => ({
      ...provider,
      hidden: false,
      models: [...provider.models],
    }));
}

function appendLocalMachineProviders(providers: ProviderDef[]) {
  for (const builtin of localMachineBuiltinProviders()) {
    if (providers.some((provider) => provider.id === builtin.id)) continue;
    providers.push(builtin);
  }
}

/** Providers shown in pickers. */
export function visibleProviders(): ProviderDef[] {
  const visible = PROVIDERS.filter((p) => !p.hidden);
  appendLocalMachineProviders(visible);
  return visible;
}

/** Friendly labels for model IDs (API id unchanged). */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "hormachuelos-v1": "Hormachuelos v1",
  "hormachuelos-v2": "Hormachuelos v2",
  "hormachuelos-v3": "Hormachuelos v3",
  "hormachuelos-v4": "Hormachuelos v4 (VISION)",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "grok-4.5": "GPT 5.6 Sol",
  "composer-2.5": "GPT 5.6 Luna",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.4": "GPT 5.4",
  "gpt-5.2": "GPT 5.2",
  "gpt-5.1": "GPT 5.1",
  "gpt-5": "GPT 5",
  "gpt-4.1": "GPT 4.1",
  "gpt-4o": "GPT 4o",
  "claude-4.6-sonnet": "Claude 4.6 Sonnet",
  "claude-4.5-sonnet": "Claude 4.5 Sonnet",
  "claude-4.5-opus": "Claude 4.5 Opus",
  "claude-4-sonnet": "Claude 4 Sonnet",
  "claude-opus-4": "Claude Opus 4",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3-7-flash": "Gemini 3.7 Flash",
  "google/gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-pro-preview": "Gemini 3 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "composer-2": "Composer 2",
  "composer-1.5": "Composer 1.5",
  "kimi-k2.5": "Kimi K2.5",
  "glm-5.2": "GLM 5.2",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash Free",
  "mimo-v2.5-free": "MiMo V2.5 Free",
  "north-mini-code-free": "North Mini Code Free",
  "ling-3.0-flash-free": "Ling 3.0 Flash Free",
  "laguna-s-2.1-free": "Laguna S 2.1 Free",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra Free",
  "big-pickle": "Big Pickle Free",
  "openrouter/free": "Free Models Router",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
  "moonshotai/Kimi-K3": "Kimi K3",
  "thinkingmachines/inkling-small": "Inkling Small",
  "poolside/laguna-s-2.1-free": "Laguna S 2.1 Free",
};

/** Allowed OpenRouter model — Free Models Router only. */
export function isOpenRouterFreeModel(modelId: string): boolean {
  return String(modelId || "").trim().toLowerCase() === "openrouter/free";
}

/** Providers routed through the Cursor local SDK (not chat-completions). */
export const CURSOR_SDK_PROVIDER_IDS = new Set(["cursor"]);

/** Providers whose selected model supports an explicit reasoning-effort value. */
export const REASONING_EFFORT_PROVIDER_IDS = new Set([
  "cursor",
  "xai",
  "deepseek",
  "glm",
  "openrouter",
  "commandcode",
  "hormachuelos_free",
  "openai",
  "ollama",
  "pollinations",
  "gemini",
  "gemini_cli",
]);

/** Provider catalogs that are deliberately pinned (no live /models flood). */
export const STATIC_MODEL_PROVIDER_IDS = new Set([
  "cursor",
  "xai",
  "glm",
  "openrouter",
  "commandcode",
]);

export function isCursorSdkProvider(providerId: string): boolean {
  return CURSOR_SDK_PROVIDER_IDS.has(providerId);
}

export function usesReasoningEffort(providerId: string): boolean {
  return REASONING_EFFORT_PROVIDER_IDS.has(providerId);
}

export function hasStaticModelCatalog(providerId: string): boolean {
  return STATIC_MODEL_PROVIDER_IDS.has(providerId) || Boolean(getProviderMeta(providerId)?.hostedManaged);
}

function modelBelongsWithProvider(providerId: string, modelId: string): boolean {
  const provider = String(providerId || "").trim().toLowerCase();
  const model = String(modelId || "").trim().toLowerCase();
  if (!provider || !model) return false;
  if (model.startsWith("hormachuelos-v")) return provider === "hormachuelos_free";
  if (model.startsWith("gemini-") || model.startsWith("google/gemini")) {
    return provider === "gemini" || provider === "gemini_cli";
  }
  if (model.startsWith("deepseek")) return provider === "deepseek";
  if (model === "openrouter/free" || model === "free") return provider === "openrouter";
  return true;
}

/**
 * Preserve the built-in Hormachuelos aliases when the hosted catalog is
 * refreshed.  The website can add models at any time, but an older deployed
 * catalog must never make a locally supported alias disappear from the
 * desktop picker.
 */
export function mergeProviderModelCatalog(providerId: string, models: readonly string[]): string[] {
  const hosted = HOSTED_PROVIDER_CATALOG.get(providerId);
  if (hostedCatalogRestricted && hosted?.models?.length && !isLocalMachineProvider(providerId)) {
    return uniqueModels(hosted.models.map((model) => model.id));
  }
  const meta = getProviderMeta(providerId);
  const configured =
    providerId === "hormachuelos_free" ||
    providerId === "openrouter" ||
    providerId === "gemini" ||
    providerId === "gemini_cli" ||
    meta?.hostedManaged
      ? meta?.models ?? []
      : [];
  const incoming = models.filter((model) => modelBelongsWithProvider(providerId, model));
  return [...new Set([...configured, ...incoming].map((model) => model.trim()).filter(Boolean))];
}

/**
 * Effort options shown for the Cursor/OpenAI chip.
 * Stored ids map to Cursor SDK values via `toCursorEffort()`.
 */
export const CURSOR_EFFORT_OPTIONS = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "xHigh" },
  { id: "ultra", label: "Ultra" },
] as const;

/** DeepSeek V4 accepts low / high / max on its OpenAI-compatible endpoint. */
export const DEEPSEEK_EFFORT_OPTIONS = [
  { id: "light", label: "Low" },
  { id: "high", label: "High" },
  { id: "ultra", label: "Max" },
] as const;

export type EffortId = (typeof CURSOR_EFFORT_OPTIONS)[number]["id"];

export function effortOptionsForProvider(providerId: string, modelId?: string) {
  if (providerId === "deepseek") return DEEPSEEK_EFFORT_OPTIONS;
  if (providerId === "gemini" || providerId === "gemini_cli") {
    return geminiEffortOptions(modelId || "");
  }
  return CURSOR_EFFORT_OPTIONS;
}

function isGemini25Model(modelId: string): boolean {
  const model = String(modelId || "").toLowerCase();
  return model.includes("2.5") || model.includes("2-5");
}

function geminiAllowsMinimalThinking(modelId: string): boolean {
  const model = String(modelId || "").toLowerCase();
  if (isGemini25Model(model)) return false;
  if (model.includes("3.7")) return false;
  if (model.includes("pro") && !model.includes("flash")) return false;
  return true;
}

/** Google thinking levels / budgets, stored as the shared effort ids. */
export function geminiEffortOptions(modelId: string): { id: EffortId; label: string }[] {
  if (isGemini25Model(modelId)) {
    return [
      { id: "light", label: "Off" },
      { id: "medium", label: "Low" },
      { id: "high", label: "Medium" },
      { id: "xhigh", label: "High" },
      { id: "ultra", label: "Dynamic" },
    ];
  }
  if (geminiAllowsMinimalThinking(modelId)) {
    return [
      { id: "light", label: "Minimal" },
      { id: "medium", label: "Low" },
      { id: "high", label: "Medium" },
      { id: "xhigh", label: "High" },
    ];
  }
  return [
    { id: "light", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
}

/** Normalize UI effort ids (legacy low/max accepted). */
export function normalizeEffort(value: string | null | undefined): EffortId {
  const v = (value || "").trim().toLowerCase();
  if (v === "low" || v === "light") return "light";
  if (v === "medium") return "medium";
  if (v === "high") return "high";
  if (v === "xhigh" || v === "extra" || v === "extra-high" || v === "extrahigh") return "xhigh";
  if (v === "ultra" || v === "max") return "ultra";
  return "high";
}

/** Normalize effort to the values accepted consistently by Rust and the UI. */
export function normalizeEffortForProvider(
  providerId: string,
  value: string | null | undefined,
  modelId?: string,
): EffortId {
  const v = (value || "").trim().toLowerCase();
  if (providerId === "deepseek") {
    // DeepSeek accepts light/high/ultra (→ low/high/max upstream).
    if (v === "medium" || v === "xhigh") return v === "medium" ? "light" : "ultra";
    return normalizeEffort(value);
  }
  if (providerId === "gemini" || providerId === "gemini_cli") {
    const opts = geminiEffortOptions(modelId || "");
    let id: EffortId = normalizeEffort(value);
    if (v === "minimal" || v === "off") id = "light";
    if (v === "dynamic") id = "ultra";
    if (!opts.some((opt) => opt.id === id)) {
      return (opts[opts.length - 1]?.id as EffortId) || "high";
    }
    return id;
  }
  return normalizeEffort(value);
}

/** Map UI effort → Cursor SDK effort param (low | medium | high). */
export function toCursorEffort(value: string | null | undefined): "low" | "medium" | "high" {
  switch (normalizeEffort(value)) {
    case "light":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "ultra":
      return "high";
    default:
      return "high";
  }
}

export function isUltraEffort(value: string | null | undefined): boolean {
  return normalizeEffort(value) === "ultra";
}

/** Resolve locally selected models to the provider that actually serves them. */
export function backendForModel(modelId: string): { provider: string; baseUrl: string | null } {
  const id = (modelId || "").trim();
  if (/^hormachuelos-[a-z0-9._-]+$/i.test(id)) {
    return {
      provider: "hormachuelos_free",
      baseUrl: "https://hormachuelos.vercel.app/api/v1",
    };
  }
  if (id === "deepseek-v4-flash" || id === "deepseek-v4-pro") {
    return { provider: "deepseek", baseUrl: "https://api.deepseek.com" };
  }
  return { provider: "ollama", baseUrl: "http://localhost:11434/v1" };
}

/** UI provider id for pickers (no longer merges DeepSeek into Ollama). */
export function uiProviderId(providerId: string, _modelId?: string): string {
  return providerId;
}

/** Display name for a model id (chip / menus). Falls back to a short id. */
export function displayModelName(id: string, providerId?: string): string {
  const raw = (id || "").trim();
  if (!raw) return raw;
  if (providerId) {
    const hostedName = HOSTED_MODEL_DISPLAY_NAMES.get(hostedModelNameKey(providerId, raw));
    if (hostedName) return hostedName;
  }
  if (
    (providerId === "openrouter" || !providerId) &&
    (raw === "openrouter/free" || raw.toLowerCase() === "free")
  ) {
    return "Free Models Router";
  }
  if (MODEL_DISPLAY_NAMES[raw]) return MODEL_DISPLAY_NAMES[raw];
  const short = raw.includes("/") ? raw.split("/").pop()! : raw;
  if (MODEL_DISPLAY_NAMES[short]) return MODEL_DISPLAY_NAMES[short];
  return short.replace(/:free$/, "");
}

/** UI-facing provider label. */
export function displayProviderName(providerId: string): string {
  const meta = getProviderMeta(providerId);
  if (meta) return meta.label;
  const id = (providerId || "").trim();
  if (!id) return "Unknown";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Legacy helper retained for callers that combine cloud and local catalogs. */
export function claudeCatalogModels(ollamaDiscovered: string[] = []): string[] {
  const branded = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.1:cloud",
    "glm-5.2:cloud",
  ];
  const rest = (ollamaDiscovered.length
    ? ollamaDiscovered
    : getProviderMeta("ollama")?.models || []
  ).filter((m) => !branded.includes(m) && !m.startsWith("deepseek-v4"));
  return [...branded, ...rest];
}

const LEGACY_PROVIDER_BASE_URLS = [
  "https://api.deepseek.com/v1",
  "https://api.atomeocean.com/v1",
  "https://text.pollinations.ai/openai",
];

function isKnownProviderBaseUrl(value: string): boolean {
  return PROVIDERS.some((provider) => provider.defaultBaseUrl === value)
    || LEGACY_PROVIDER_BASE_URLS.includes(value);
}

export function getProviderMeta(id: string) {
  const normalized = String(id || "").trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === normalized) ||
    BUILTIN_PROVIDERS.find((p) => p.id === normalized) ||
    (isHostedProviderAlias(normalized) ? fallbackHostedProvider(normalized) : undefined);
}

export function normalizeAllowedApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const item of value) {
    const name = String(item || "")
      .trim()
      .replace(/^.*[\\/]/, "")
      .toLowerCase();
    if (!name.endsWith(".exe") || name.length > 128 || !/^[a-z0-9._-]+\.exe$/.test(name)) {
      continue;
    }
    if (!cleaned.includes(name)) cleaned.push(name);
    if (cleaned.length >= 32) break;
  }
  return cleaned;
}

/** Default settings matching the Rust Default impl. */
export function defaultSettings(): Settings {
  const openai = PROVIDERS.find((p) => p.id === "cursor") || PROVIDERS[0];
  return {
    provider: openai.id,
    model: openai.defaultModel,
    base_url: openai.defaultBaseUrl || null,
    // Kept in the wire format for settings written by earlier releases.
    // The agent loop is now intentionally unbounded.
    max_iterations: 0,
    command_timeout_secs: 120,
    auto_approve: true,
    permission_mode: "adaptive",
    capability_mode: "balanced",
    taglish: false,
    computer_use_enabled: false,
    computer_use_prompt_activation: true,
    desktop_computer_use_enabled: false,
    desktop_computer_use_allowed_apps: [],
    smart_agent_enabled: true,
    flavour_enabled: true,
    model_effort: "high",
  };
}

/** Fetch settings via IPC; fall back to defaults on failure (e.g. no Tauri). */
export async function getSettingsSafe(): Promise<Settings> {
  try {
    return normalizeSettings(await api.getSettings());
  } catch {
    return defaultSettings();
  }
}

/** Normalize provider settings while preserving user-entered custom model IDs. */
export function normalizeSettings(s: Settings): Settings {
  s.provider = String(s.provider || "").trim().toLowerCase();
  const rawMode = String(s.permission_mode || "").trim().toLowerCase();
  s.permission_mode = rawMode === "auto"
    ? "adaptive"
    : rawMode === "full"
      ? "build"
      : ["adaptive", "ask", "research", "plan", "build", "multi_agent"].includes(rawMode)
        ? rawMode
        : "adaptive";
  s.auto_approve =
    s.permission_mode === "adaptive" ||
    s.permission_mode === "build" ||
    s.permission_mode === "multi_agent";
  const capsByMode: Record<string, string[]> = {
    adaptive: ["balanced", "agent"],
    ask: ["answer_max", "brief"],
    research: ["investigate", "answer_max"],
    plan: ["thinking", "guided"],
    build: ["agent", "balanced"],
    multi_agent: ["autonomous", "max"],
  };
  const allowed = capsByMode[s.permission_mode] || ["thinking"];
  if (!s.capability_mode || !allowed.includes(s.capability_mode)) {
    s.capability_mode = allowed[0];
  }
  s.taglish = !!s.taglish;
  s.computer_use_enabled = !!s.computer_use_enabled;
  // Missing on older settings means Auto: explicit user prompts may enable
  // Computer Use for that request, while unrelated requests remain off.
  s.computer_use_prompt_activation = s.computer_use_prompt_activation !== false;
  s.desktop_computer_use_enabled = !!s.desktop_computer_use_enabled;
  s.desktop_computer_use_allowed_apps = normalizeAllowedApps(
    s.desktop_computer_use_allowed_apps,
  );
  // Missing on older desktop settings means enabled: Director is a safe,
  // provider-neutral orchestration layer and does not change credentials.
  s.smart_agent_enabled = s.smart_agent_enabled !== false;
  // Flavour is local, provider-neutral memory. Missing on older settings means
  // enabled so long-running and continuing sessions benefit after upgrading.
  s.flavour_enabled = s.flavour_enabled !== false;
  s.model_effort = normalizeEffortForProvider(s.provider, s.model_effort, s.model);
  // Older builds pointed the OpenAI label at Cursor. Keep that path for a
  // genuine Cursor key; an explicit xAI endpoint uses the native xAI route.
  if (s.provider === "openai" && s.base_url === "https://api.cursor.com/v1") {
    s.provider = "cursor";
    s.model =
      s.model === "gpt-5.6-luna" || s.model === "composer-2.5"
        ? "composer-2.5"
        : "grok-4.5";
    s.base_url = "https://api.cursor.com/v1";
  }
  if (s.provider === "openai" && s.base_url === "https://api.x.ai/v1") {
    s.provider = "xai";
    if (s.model === "gpt-5.6-sol" || !s.model.trim()) s.model = "grok-4.5";
    s.base_url = "https://api.x.ai/v1";
  }
  const meta = getProviderMeta(s.provider);
  if (!meta) {
    const openai = PROVIDERS.find((p) => p.id === "cursor") || PROVIDERS[0];
    s.provider = openai.id;
    s.model = openai.defaultModel;
    s.base_url = openai.defaultBaseUrl || null;
    return s;
  }
  if (!s.model.trim()) {
    s.model = meta.defaultModel;
  }
  if (s.provider === "cursor") {
    // Accept legacy display IDs from builds that persisted UI aliases while
    // keeping the Cursor SDK request on its real model ID.
    if (s.model === "gpt-5.6-sol") s.model = "grok-4.5";
    if (s.model === "gpt-5.6-luna") s.model = "composer-2.5";
    if (!meta.models.includes(s.model)) s.model = meta.defaultModel;
  }
  if (s.provider === "xai") {
    if (s.model === "gpt-5.6-sol" || !s.model.trim()) s.model = "grok-4.5";
    s.base_url = meta.defaultBaseUrl;
  }
  if (s.provider === "hormachuelos_free") {
    if (!s.model.trim()) s.model = meta.defaultModel;
    s.base_url = meta.defaultBaseUrl;
  }
  if (meta.hostedManaged && s.provider !== "hormachuelos_free" && s.provider !== "xai") {
    if (!s.model.trim()) s.model = meta.defaultModel;
    s.base_url = meta.defaultBaseUrl;
  }
  if (s.provider === "deepseek" && s.model === "deepseek-chat") {
    s.model = "deepseek-v4-flash";
  }
  if (s.provider === "deepseek" && s.model === "deepseek-reasoner") {
    s.model = "deepseek-v4-pro";
  }
  if (s.provider === "deepseek" && s.base_url === "https://api.deepseek.com/v1") {
    s.base_url = meta.defaultBaseUrl;
  }
  if (s.provider === "glm") {
    const freeModels = meta.models || [];
    const legacyBigmodel =
      s.base_url === "https://open.bigmodel.cn/api/paas/v4" ||
      s.base_url === "https://api.atomeocean.com/v1" ||
      !s.base_url?.trim();
    if (legacyBigmodel) {
      s.base_url = meta.defaultBaseUrl;
    }
    if (!freeModels.includes(s.model)) {
      s.model = meta.defaultModel;
    }
  }
  if (s.provider === "openrouter") {
    // Pin OpenRouter to Free Models Router only.
    s.model = meta.defaultModel;
  }
  if (s.provider === "pollinations" && s.base_url === "https://text.pollinations.ai/openai") {
    s.base_url = meta.defaultBaseUrl;
  }
  if (s.provider === "cursor") {
    const openaiLegacy =
      s.base_url === "https://api.openai.com/v1" ||
      s.base_url === "https://api.openai.com" ||
      !s.base_url?.trim();
    if (openaiLegacy) {
      s.base_url = meta.defaultBaseUrl;
    }
  }
  return s;
}

export class SettingsModal {
  root: HTMLElement;
  settings!: Settings;
  keyStates: Record<string, boolean> = {};
  discoveredModels: Record<string, string[]> = {};
  modelDiscoveryMessages: Record<string, string> = {};
  integrations: IntegrationStatus[] = [];
  computerUseStatus: ComputerUseStatus | null = null;
  desktopComputerUseStatus: DesktopComputerUseStatus | null = null;
  private computerUseUnlisten: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private modalSessionActive = false;
  private fieldSequence = 0;
  private inertSiblings: Array<{ node: HTMLElement; wasInert: boolean }> = [];
  private readonly dialogKeyHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = this.root.querySelector<HTMLElement>("[role='dialog'],[role='alertdialog']");
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  constructor(
    private onClose: () => void,
    private requestedIntegrationId?: string,
  ) {
    this.root = document.getElementById("modal-root")!;
  }

  async open() {
    this.beginModalSession();
    try {
      // Pull provider/model aliases before loading settings so a saved custom
      // provider is recognized instead of being reset to a built-in choice.
      await refreshHostedProviderCatalog().catch(() => []);
      if (!this.modalSessionActive) return;
      this.settings = await getSettingsSafe();
    } catch (e) {
      if (!this.modalSessionActive) return;
      this.renderError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.modalSessionActive) return;
    this.computerUseStatus = await api.getComputerUseStatus().catch(() => null);
    this.desktopComputerUseStatus = await api.getDesktopComputerUseStatus().catch(() => null);
    if (!this.modalSessionActive) return;
    this.computerUseUnlisten?.();
    this.computerUseUnlisten = await onComputerUseStatus((status) => {
      this.computerUseStatus = status;
      if (!this.modalSessionActive) return;
      const panel = this.root.querySelector<HTMLElement>(".computer-use-panel");
      if (panel) panel.replaceWith(this.renderComputerUsePanel());
      const desktopPanel = this.root.querySelector<HTMLElement>(".desktop-computer-use-panel");
      if (desktopPanel) desktopPanel.replaceWith(this.renderDesktopComputerUsePanel());
    }).catch(() => null);
    if (!this.modalSessionActive) return;
    for (const p of PROVIDERS) {
      if (p.id === "openrouter") {
        // Optional BYOK — hosted plans do not need a local OpenRouter key.
        this.keyStates[p.id] = await api.hasApiKey(p.id).catch(() => false);
      } else if (p.keyRequired) {
        let has = await api.hasApiKey(p.id).catch(() => false);
        this.keyStates[p.id] = has;
      } else {
        this.keyStates[p.id] = true; // keyless providers are always "ready"
      }
      if (!this.modalSessionActive) return;
    }
    this.integrations = await api.listIntegrations().catch(() => []);
    if (!this.modalSessionActive) return;
    this.render();
    // Auto-load model catalogs for every provider that can list models
    void this.autoDiscoverAllReadyProviders();
  }

  private async reloadIntegrations() {
    this.integrations = await api.listIntegrations().catch(() => []);
  }

  private focusRequestedIntegration(): boolean {
    const requested = this.requestedIntegrationId;
    if (!requested || !this.integrations.some((integration) => integration.id === requested)) {
      return false;
    }
    window.requestAnimationFrame(() => {
      const card = Array.from(
        this.root.querySelectorAll<HTMLElement>("[data-integration-id]"),
      ).find((element) => element.dataset.integrationId === requested);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card
        .querySelector<HTMLInputElement>("[data-integration-secret]")
        ?.focus({ preventScroll: true });
    });
    return true;
  }

  private beginModalSession() {
    if (this.modalSessionActive) return;
    this.modalSessionActive = true;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.getElementById("app");
    this.inertSiblings = app
      ? Array.from(app.children)
          .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.root)
          .map((node) => ({ node, wasInert: node.inert }))
      : [];
    for (const { node } of this.inertSiblings) node.inert = true;
    this.root.addEventListener("keydown", this.dialogKeyHandler);
  }

  private focusDefault(control: HTMLElement) {
    if (this.focusRequestedIntegration()) return;
    window.requestAnimationFrame(() => control.focus({ preventScroll: true }));
  }

  private nextFieldId(): string {
    this.fieldSequence += 1;
    return `settings-field-${this.fieldSequence}`;
  }

  /** After a key is saved (or for keyless providers), pull the full model list from the API. */
  private async discoverModels(providerId: string, opts?: { silent?: boolean; reRender?: boolean }) {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return;
    // Branded integrations intentionally expose only their pinned model alias.
    if (hasStaticModelCatalog(providerId)) return;
    if (provider.keyRequired && !this.keyStates[providerId]) return;

    if (!opts?.silent) {
      this.modelDiscoveryMessages[providerId] = "Loading models…";
    }
    try {
      const base =
        this.settings.provider === providerId
          ? this.settings.base_url?.trim() || null
          : provider.defaultBaseUrl || null;
      const modelsRaw = await api.listProviderModels(providerId, base);
      // OpenRouter: keep free models only so the picker never floods with paid IDs.
      const discovered =
        providerId === "openrouter"
          ? ["openrouter/free"]
          : providerId === "glm"
            ? modelsRaw.filter(
                (id) =>
                  id.endsWith("-free") ||
                  id === "big-pickle" ||
                  id.includes("free"),
              )
            : modelsRaw;
      const models = mergeProviderModelCatalog(providerId, discovered);
      this.discoveredModels[providerId] = models;
      this.modelDiscoveryMessages[providerId] =
        models.length > 0
          ? `Loaded ${models.length} model${models.length === 1 ? "" : "s"} from ${provider.label}.`
          : `No models returned by ${provider.label}.`;
      // Keep selection valid for the active provider
      if (this.settings.provider === providerId && models.length > 0) {
        if (!models.includes(this.settings.model)) {
          this.settings.model = models[0];
        }
      }
    } catch (error) {
      this.modelDiscoveryMessages[providerId] = `Could not load models: ${String(error)}`;
    }
    // Never rebuild the modal after the user closed it (async discovery race).
    if (!this.modalSessionActive) return;
    if (opts?.reRender !== false) this.render();
  }

  private async autoDiscoverAllReadyProviders() {
    if (!this.modalSessionActive) return;
    const ready = PROVIDERS.filter((p) => !p.keyRequired || this.keyStates[p.id]);
    // Prefer active provider first so the dropdown fills quickly
    const ordered = [
      ...ready.filter((p) => p.id === this.settings.provider),
      ...ready.filter((p) => p.id !== this.settings.provider),
    ];
    for (const p of ordered) {
      if (!this.modalSessionActive) return;
      // Skip if already loaded this session
      if (this.discoveredModels[p.id]?.length) continue;
      await this.discoverModels(p.id, {
        silent: p.id !== this.settings.provider,
        reRender: p.id === this.settings.provider || p === ordered[ordered.length - 1],
      });
    }
  }

  private renderError(msg: string) {
    if (!this.modalSessionActive) return;
    clear(this.root);
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "settings-error-title" });
    const head = el("div", { class: "modal-head" });
    head.appendChild(el("div", { class: "modal-title", id: "settings-error-title" }, ["Settings"]));
    const closeBtn = el("button", { class: "modal-close", type: "button", "aria-label": "Close settings", html: icon("close", 16) });
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    head.appendChild(closeBtn);
    modal.appendChild(head);
    const body = el("div", { class: "modal-body" });
    body.appendChild(el("div", { class: "set-row" }, [
      el("div", { class: "set-hint", style: "color:var(--err);padding:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm)" }, [
        `Could not load settings: ${msg}`,
      ]),
    ]));
    const foot = el("div", { class: "modal-foot" });
    const dismissBtn = el("button", { class: "btn primary", type: "button" }, ["Close"]);
    dismissBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    foot.appendChild(dismissBtn);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) this.close(); });
    this.root.appendChild(overlay);
    (overlay as HTMLElement).style.pointerEvents = "auto";
    this.focusDefault(closeBtn);
  }

  private render() {
    if (!this.modalSessionActive) return;
    clear(this.root);
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "settings-title" });

    // Header
    const head = el("div", { class: "modal-head" });
    head.appendChild(el("div", { class: "modal-title", id: "settings-title" }, ["Settings"]));
    const closeBtn = el("button", { class: "modal-close", type: "button", "aria-label": "Close settings", html: icon("close", 16) });
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    head.appendChild(closeBtn);
    modal.appendChild(head);

    // Body
    const body = el("div", { class: "modal-body" });

    // Provider section — clickable logo cards
    body.appendChild(this.section("Provider"));
    const cardsWrap = el("div", { class: "provider-cards" });
    const uiProv = uiProviderId(this.settings.provider, this.settings.model);
    for (const p of visibleProviders()) {
      const card = el("button", {
        class: "provider-card" + (p.id === uiProv ? " active" : ""), type: "button",
        "aria-pressed": String(p.id === uiProv),
      });
      card.innerHTML =
        `<img class="provider-card-logo" src="${p.logoSrc}" alt="" width="22" height="22" draggable="false" />` +
        `<div class="provider-card-meta"><span class="provider-card-name">${escapeHtml(p.label)}</span></div>`;
      card.addEventListener("click", () => {
        const wasSelectedProvider = this.settings.provider === p.id;
        const currentBase = (this.settings.base_url || "").trim();
        this.settings.provider = p.id;
        this.settings.model = p.defaultModel;
        if (p.id === "ollama") {
          const backend = backendForModel(p.defaultModel);
          this.settings.provider = backend.provider;
          if (!wasSelectedProvider || !currentBase) {
            this.settings.base_url = backend.baseUrl;
          }
        } else {
          const newBase = p.defaultBaseUrl.trim();
          const wasDefault = !currentBase || isKnownProviderBaseUrl(currentBase);
          if (wasDefault) {
            this.settings.base_url = newBase || null;
          }
        }
        const known = this.discoveredModels[p.id];
        if (known?.length && !known.includes(this.settings.model)) {
          this.settings.model = known[0];
        }
        this.render();
        if (!this.discoveredModels[p.id]?.length && (!p.keyRequired || this.keyStates[p.id])) {
          void this.discoverModels(p.id);
        }
      });
      cardsWrap.appendChild(card);
    }
    body.appendChild(cardsWrap);

    body.appendChild(this.field("Active provider", () => {
      const sel = el("select", { class: "field" }) as HTMLSelectElement;
      for (const p of visibleProviders()) {
        const opt = el("option", { value: p.id }, [p.label]);
        if (p.id === uiProv) opt.setAttribute("selected", "selected");
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        const p = visibleProviders().find((x) => x.id === sel.value)!;
        this.settings.provider = sel.value;
        this.settings.model = p.defaultModel;
        if (p.id === "ollama") {
          const backend = backendForModel(p.defaultModel);
          this.settings.provider = backend.provider;
          this.settings.base_url = backend.baseUrl;
        } else {
          const newBase = p.defaultBaseUrl.trim();
          const currentBase = (this.settings.base_url || "").trim();
          const wasDefault = !currentBase || isKnownProviderBaseUrl(currentBase);
          if (wasDefault) {
            this.settings.base_url = newBase || null;
          }
          const known = this.discoveredModels[p.id];
          if (known?.length && !known.includes(this.settings.model)) {
            this.settings.model = known[0];
          }
        }
        this.render();
        if (!this.discoveredModels[p.id]?.length && (!p.keyRequired || this.keyStates[p.id])) {
          void this.discoverModels(p.id);
        }
      });
      return sel;
    }));

    body.appendChild(this.field("Model", () => {
      const uiId = uiProviderId(this.settings.provider, this.settings.model);
      const catalogProvider = PROVIDERS.find((p) => p.id === uiId) || PROVIDERS[0];
      const models = this.modelsFor(catalogProvider);
      const sel = el("select", { class: "field" }) as HTMLSelectElement;
      if (models.length === 0) {
        const opt = el("option", { value: catalogProvider.defaultModel }, ["No models yet"]);
        sel.appendChild(opt);
        sel.disabled = true;
      } else {
        for (const m of models) {
          const opt = el("option", { value: m }, [displayModelName(m, uiId)]);
          if (m === this.settings.model) opt.setAttribute("selected", "selected");
          sel.appendChild(opt);
        }
        if (!models.includes(this.settings.model) && this.settings.model) {
          const orphan = el("option", { value: this.settings.model }, [
            displayModelName(this.settings.model, uiId),
          ]);
          orphan.setAttribute("selected", "selected");
          sel.appendChild(orphan);
        }
        sel.addEventListener("change", () => {
          const m = sel.value;
          this.settings.model = m;
          if (uiId === "ollama") {
            // A local Ollama model may share an id with another provider. Model
            // selection must never change the selected provider or overwrite an
            // explicitly configured Ollama host.
            this.settings.provider = "ollama";
            if (!this.settings.base_url?.trim()) {
              this.settings.base_url = catalogProvider.defaultBaseUrl || null;
            }
          }
        });
      }
      return sel;
    }));

    const uiIdForKeys = uiProviderId(this.settings.provider, this.settings.model);
    const discoveryProvider = PROVIDERS.find((provider) => provider.id === uiIdForKeys) || PROVIDERS[0];
    const discoveryRow = el("div", { class: "set-row" });
      const msg =
      this.modelDiscoveryMessages[discoveryProvider.id] ||
      (uiIdForKeys === "hormachuelos_free"
        ? "Hormachuelos models are included for signed-in users. No provider key is stored on this computer."
        : uiIdForKeys === "openrouter"
        ? "Free Models Router only. An active Hormachuelos plan uses the hosted OpenRouter key — a local key is optional."
        : uiIdForKeys === "xai" && !this.keyStates[uiIdForKeys]
        ? "Paste an xAI key for BYOK, or use a signed-in paid plan with hosted Grok enabled by your administrator."
        : discoveryProvider.hostedManaged
        ? "Model aliases are managed securely by your administrator and require an active hosted plan. No provider key is stored on this computer."
        : uiIdForKeys === "glm"
        ? "Free OpenCode models only. Get a key at opencode.ai/auth."
        : uiIdForKeys === "ollama"
        ? "Select a locally installed Ollama model above."
        : uiIdForKeys === "gemini_cli"
        ? "Uses the Google account already logged into Gemini CLI on this PC. No API key is stored in Hormachuelos."
        : discoveryProvider.keyRequired && !this.keyStates[discoveryProvider.id]
          ? "Paste and save an API key — models load automatically from the provider."
          : "Models load automatically from the provider after the key is saved.");
    discoveryRow.appendChild(el("div", { class: "set-hint" }, [msg]));
    body.appendChild(discoveryRow);

    body.appendChild(this.field("Base URL (optional)", () => {
      const activeProvider = PROVIDERS.find((provider) => provider.id === this.settings.provider)!;
      const inp = el("input", { class: "field", type: "text", value: this.settings.base_url || "", placeholder: activeProvider.defaultBaseUrl }) as HTMLInputElement;
      if (activeProvider.id === "hormachuelos_free" || activeProvider.hostedManaged) {
        inp.readOnly = true;
        inp.setAttribute("aria-readonly", "true");
      }
      inp.addEventListener("input", () => (this.settings.base_url = inp.value || null));
      return inp;
    }));

    // API key
    body.appendChild(this.section("API Key"));
    const activeProvider = PROVIDERS.find((p) => p.id === this.settings.provider)!;
    const keyRow = el("div", { class: "set-row" });
    const showKeyField = activeProvider.keyRequired || activeProvider.id === "openrouter";
    if (showKeyField) {
      const keyLabel = el("label", { class: "label" });
      const providerKeyId = this.nextFieldId();
      keyLabel.setAttribute("for", providerKeyId);
      keyLabel.innerHTML =
        `<img class="provider-card-logo sm" src="${activeProvider.logoSrc}" alt="" width="14" height="14" draggable="false" />` +
        `&nbsp;${escapeHtml(activeProvider.label)} API key` +
        (activeProvider.id === "openrouter" ? " (optional)" : "");
      keyRow.appendChild(keyLabel);
      const inputRow = el("div", { class: "set-key-row" });
      const keyInput = el("input", { id: providerKeyId, class: "field", type: "password", placeholder: "Paste API key", value: "", autocomplete: "off" }) as HTMLInputElement;
      inputRow.appendChild(keyInput);
      const saveBtn = el("button", { class: "btn sm" }, ["Save key"]);
      const statusEl = el("div", { class: `set-status ${this.keyStates[activeProvider.id] ? "set" : "unset"}` });
      statusEl.textContent = this.keyStates[activeProvider.id]
        ? "Key saved in OS keychain"
        : activeProvider.id === "xai"
          ? "No local xAI key — a signed-in paid plan can use hosted Grok"
          : activeProvider.id === "openrouter"
            ? "No local key needed — Free Models Router uses your Hormachuelos plan"
            : activeProvider.id === "cursor"
              ? "No local Cursor key needed — an active Hormachuelos plan uses hosted models"
              : "No key set — paste a provider key above";
      saveBtn.addEventListener("click", async () => {
        const v = keyInput.value.trim();
        if (!v) return;
        saveBtn.setAttribute("disabled", "disabled");
        try {
          await api.setApiKey(activeProvider.id, v);
          this.keyStates[activeProvider.id] = true;
          keyInput.value = "";
          this.modelDiscoveryMessages[activeProvider.id] = "Key saved — loading models…";
          this.render();
          await this.discoverModels(activeProvider.id);
        } catch (error) {
          statusEl.className = "set-status unset";
          statusEl.textContent = `Could not save key: ${String(error)}`;
          saveBtn.removeAttribute("disabled");
        }
      });
      inputRow.appendChild(saveBtn);
      keyRow.appendChild(inputRow);
      keyRow.appendChild(statusEl);
      if (this.keyStates[activeProvider.id]) {
        const testBtn = el("button", { class: "btn sm", style: "margin-top:6px; margin-right:6px" }, ["Test connection"]);
        testBtn.addEventListener("click", async () => {
          testBtn.setAttribute("disabled", "disabled");
          testBtn.textContent = "Testing…";
          statusEl.className = "set-status unset";
          statusEl.textContent = `Testing ${displayModelName(this.settings.model, activeProvider.id)}…`;
          try {
            const result = await api.testProviderConnection(
              activeProvider.id,
              this.settings.model.trim(),
              this.settings.base_url?.trim() || null,
            );
            statusEl.className = `set-status ${result.ok ? "set" : "unset"}`;
            statusEl.textContent = result.message;
          } catch (error) {
            statusEl.className = "set-status unset";
            statusEl.textContent = `Connection test failed: ${String(error)}`;
          } finally {
            testBtn.removeAttribute("disabled");
            testBtn.textContent = "Test connection";
          }
        });
        keyRow.appendChild(testBtn);
        const clearBtn2 = el("button", { class: "btn sm danger", style: "margin-top:6px" }, ["Clear key"]);
        clearBtn2.addEventListener("click", async () => {
          await api.clearApiKey(activeProvider.id);
          this.keyStates[activeProvider.id] = false;
          this.render();
        });
        keyRow.appendChild(clearBtn2);
      }
      if (activeProvider.keyUrl) {
        keyRow.appendChild(el("div", { class: "set-hint" }, [
          activeProvider.id === "openrouter"
            ? `Optional BYOK at ${activeProvider.keyUrl}. With a Hormachuelos plan, Free Models Router works without a local key.`
            : activeProvider.id === "cursor"
              ? `Optional Cursor key at ${activeProvider.keyUrl}. With a Hormachuelos plan, OpenAI works without a local key (uses Hormachuelos v3).`
              : `Get a key at ${activeProvider.keyUrl}`,
        ]));
      }
    } else {
      const note = el("div", { class: "set-hint", style: "padding:8px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--fg-2)" });
      note.textContent = activeProvider.id === "hormachuelos_free"
        ? "Included for signed-in Hormachuelos users. Model credentials are protected by the hosted service and are never bundled with the app."
        : activeProvider.id === "gemini_cli"
          ? "Uses the Google account already logged into Gemini CLI on this PC. Sign in with `gemini` if the picker cannot load models. Hormachuelos never copies that login into its own keyring."
        : activeProvider.hostedManaged
          ? "This provider and its model aliases are managed in the Hormachuelos admin dashboard. Its upstream key stays on the hosted service; sign in with an active hosted plan to use it."
          : `${activeProvider.label} does not require an API key. Just pick a model and start building.`;
      keyRow.appendChild(note);
    }
    body.appendChild(keyRow);

    // Agent behavior
    body.appendChild(this.section("Agent"));
    body.appendChild(this.field("Command timeout (seconds)", () => {
      const inp = el("input", { class: "field", type: "number", value: String(this.settings.command_timeout_secs), min: "5", max: "600" }) as HTMLInputElement;
      inp.addEventListener("input", () => (this.settings.command_timeout_secs = parseInt(inp.value) || 120));
      return inp;
    }));

    body.appendChild(this.field("Adaptive Director runtime", () => {
      const wrap = el("label", { class: "set-check", style: "display:flex;align-items:center;gap:8px;cursor:pointer" });
      const inp = el("input", { type: "checkbox" }) as HTMLInputElement;
      inp.checked = this.settings.smart_agent_enabled !== false;
      inp.addEventListener("change", () => {
        this.settings.smart_agent_enabled = inp.checked;
      });
      wrap.appendChild(inp);
      wrap.appendChild(document.createTextNode("Keep host-owned Answer / Change / Ship / Operate jobs, automatic recovery, and verification for mutating work"));
      return wrap;
    }));
    body.appendChild(el("div", { class: "set-hint", style: "margin-top:-6px;margin-bottom:12px" }, [
      "This runtime enforces the effective mode after routing: read-only turns cannot mutate files, Build stays focused, and broad Parallel work gets one integrated verification pass. It never changes your selected provider, model, or API key.",
    ]));

    body.appendChild(this.field("Flavour memory", () => {
      const wrap = el("label", { class: "set-check", style: "display:flex;align-items:center;gap:8px;cursor:pointer" });
      const inp = el("input", { type: "checkbox" }) as HTMLInputElement;
      inp.checked = this.settings.flavour_enabled !== false;
      inp.addEventListener("change", () => {
        this.settings.flavour_enabled = inp.checked;
      });
      wrap.appendChild(inp);
      wrap.appendChild(document.createTextNode("Learn and recall project preferences throughout every AI run"));
      return wrap;
    }));
    body.appendChild(el("div", { class: "set-hint", style: "margin-top:-6px;margin-bottom:12px" }, [
      "Flavour recalls a small relevant digest before, during, and after work. Shareable preferences live in .hormachuelos/flavour.json; detailed working memory stays private per project and session. Credentials and full tool output are never saved.",
    ]));

    body.appendChild(this.field("Permission mode", () => {
      const sel = el("select", { class: "field" }) as HTMLSelectElement;
      for (const [value, label] of [
        ["adaptive", "Adaptive Director (recommended) — auto-route each turn by intent, complexity, and risk"],
        ["ask", "Ask — direct bounded answer; project writes locked"],
        ["research", "Research — deep read-only evidence, cross-checking, and synthesis"],
        ["plan", "Plan — scope, decisions, acceptance criteria, and verification before changes"],
        ["build", "Build — focused implementation with relevant verification"],
        ["multi_agent", "Parallel (Multi-Agent) — coordinated independent workstreams and one delivery"],
      ] as const) {
        const opt = el("option", { value }, [label]);
        if ((this.settings.permission_mode || "adaptive") === value) opt.setAttribute("selected", "selected");
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        this.settings.permission_mode = sel.value;
        this.settings.auto_approve =
          sel.value === "adaptive" || sel.value === "build" || sel.value === "multi_agent";
      });
      return sel;
    }));
    body.appendChild(el("div", { class: "set-hint", style: "margin-top:-6px;margin-bottom:12px" }, [
      "Adaptive keeps your selection stable while routing each turn to Ask, Research, Plan, Build, or Parallel. Ask is direct and bounded. Research performs deeper read-only evidence gathering. Plan stays locked until Apply. Build uses one focused owner and verifies the requested change. Parallel is for genuinely separable workstreams; dependent edits remain ordered and one Director synthesizes the delivery.",
    ]));

    body.appendChild(this.renderComputerUsePanel());
    body.appendChild(this.renderDesktopComputerUsePanel());

    body.appendChild(this.field("Taglish replies", () => {
      const wrap = el("label", { class: "set-check", style: "display:flex;align-items:center;gap:8px;cursor:pointer" });
      const inp = el("input", { type: "checkbox" }) as HTMLInputElement;
      inp.checked = !!this.settings.taglish;
      inp.addEventListener("change", () => {
        this.settings.taglish = inp.checked;
      });
      wrap.appendChild(inp);
      wrap.appendChild(document.createTextNode("Mix English + Filipino in agent replies"));
      return wrap;
    }));
    body.appendChild(el("div", { class: "set-hint", style: "margin-top:-6px;margin-bottom:12px" }, [
      "Built for PH freelancers and students. Technical terms stay in English.",
    ]));

    // Subscription / GCash license
    body.appendChild(this.section("Subscription · GCash"));
    const licensePanel = el("div", { class: "set-license-panel" });
    const licenseStatus = el("div", { class: "set-hint", style: "margin-bottom:8px", role: "status", "aria-live": "polite" }, ["Loading license…"]);
    const licenseKeyRow = el("div", { class: "set-key-row" });
    const keyInput = el("input", {
      class: "field",
      type: "text",
      placeholder: "HORMA-PRO-… from hormachuelos.vercel.app checkout",
      autocomplete: "off",
      "aria-label": "License key",
    }) as HTMLInputElement;
    const applyBtn = el("button", { class: "btn sm" }, ["Activate"]) as HTMLButtonElement;
    const topUpBtn = el("button", { class: "btn sm primary" }, ["Mag-load (GCash)"]) as HTMLButtonElement;
    const paintLicense = async () => {
      try {
        const lic = await api.getLicenseStatus();
        const planPct = lic.tokenBudget
          ? Math.max(0, Math.round(((lic.tokenBudget - lic.tokensUsed) / lic.tokenBudget) * 100))
          : 100;
        const u4 = Math.max(0, Number(lic.window4hUsed) || 0);
        const uw = Math.max(0, Number(lic.windowWeekUsed) || 0);
        const planLabel = displayPlanLabel(lic.plan || "plan");
        licenseStatus.textContent =
          `${planLabel} · Plan wallet ${planPct}% remaining` +
          ` · Recent activity: ${u4.toLocaleString()} tokens / 4h, ${uw.toLocaleString()} tokens / 7d` +
          " · Only the plan wallet controls access.";
        topUpBtn.onclick = () => {
          window.open(lic.topUpUrl || "https://hormachuelos.com/#/pricing", "_blank", "noopener");
        };
      } catch {
        licenseStatus.textContent = "License status unavailable.";
      }
    };
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        const lic = await api.applyLicenseKey(keyInput.value.trim());
        licenseStatus.textContent = lic.message;
        await paintLicense();
        window.dispatchEvent(new CustomEvent("horma:license-updated"));
      } catch (e) {
        licenseStatus.textContent = String(e);
      } finally {
        applyBtn.disabled = false;
      }
    });
    licenseKeyRow.appendChild(keyInput);
    licenseKeyRow.appendChild(applyBtn);
    licensePanel.appendChild(licenseStatus);
    licensePanel.appendChild(licenseKeyRow);
    licensePanel.appendChild(el("div", { style: "margin-top:8px" }, [topUpBtn]));
    body.appendChild(licensePanel);
    void paintLicense();

    // Connected accounts — GitHub, Supabase, Vercel, …
    body.appendChild(this.section("Integrations"));
    body.appendChild(el("div", { class: "set-hint", style: "margin-bottom:12px" }, [
      "Connect GitHub, Supabase, Vercel, and more. Tokens stay in the OS keyring and are supplied only to the matching integration command.",
    ]));
    body.appendChild(this.renderIntegrationsPanel());

    modal.appendChild(body);

    // Footer
    const foot = el("div", { class: "modal-foot" });
    const cancelBtn = el("button", { class: "btn", type: "button" }, ["Cancel"]);
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    const saveAllBtn = el("button", { class: "btn primary", type: "button" }, ["Save"]);
    saveAllBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.settings.permission_mode = (this.settings.permission_mode || "adaptive").toLowerCase();
      this.settings.auto_approve =
        this.settings.permission_mode === "adaptive" ||
        this.settings.permission_mode === "build" ||
        this.settings.permission_mode === "multi_agent";
      try {
        await api.saveSettings(this.settings);
        this.close();
      } catch (err) {
        console.error("save settings failed", err);
        if (!this.modalSessionActive) return;
        alert("Could not save settings: " + String(err));
      }
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveAllBtn);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    if (!this.modalSessionActive) return;
    this.root.appendChild(overlay);
    (overlay as HTMLElement).style.pointerEvents = "auto";
    this.focusDefault(closeBtn);
  }

  private section(label: string): HTMLElement {
    return el("div", { class: "sb-section-label", style: "margin: 4px 0 10px; padding: 0" }, [label.toUpperCase()]);
  }

  private renderComputerUsePanel(): HTMLElement {
    const status = this.computerUseStatus;
    const supported = status?.supported ?? false;
    const panel = el("section", {
      class: "computer-use-panel",
      "aria-labelledby": "computer-use-title",
    });

    const head = el("div", { class: "computer-use-head" });
    const titleWrap = el("div", { class: "computer-use-title-wrap" });
    titleWrap.appendChild(
      el("div", { class: "computer-use-title", id: "computer-use-title" }, ["Computer use"]),
    );
    titleWrap.appendChild(
      el("div", { class: "computer-use-subtitle" }, ["Active Preview-tab control for any provider"]),
    );
    head.appendChild(titleWrap);

    const badge = el("span", {
      class: "computer-use-badge",
      role: "status",
      "aria-live": "polite",
    });
    head.appendChild(badge);
    panel.appendChild(head);

    const helpId = this.nextFieldId();
    const emergencyId = this.nextFieldId();
    const alwaysId = this.nextFieldId();
    const alwaysToggle = el("label", { class: "computer-use-toggle", for: alwaysId });
    const alwaysInput = el("input", {
      id: alwaysId,
      type: "checkbox",
      "aria-describedby": helpId + " " + emergencyId,
    }) as HTMLInputElement;
    alwaysInput.checked = !!this.settings.computer_use_enabled;
    alwaysInput.disabled = !supported;
    alwaysToggle.appendChild(alwaysInput);
    const alwaysCopy = el("span", { class: "computer-use-toggle-copy" });
    alwaysCopy.appendChild(el("span", { class: "computer-use-toggle-label" }, ["Always on"]));
    alwaysCopy.appendChild(
      el("span", { class: "computer-use-toggle-note" }, [
        supported
          ? "Makes Preview Computer Use available on every request."
          : "Preview Computer Use is unavailable in this build.",
      ]),
    );
    alwaysToggle.appendChild(alwaysCopy);
    panel.appendChild(alwaysToggle);

    const autoId = this.nextFieldId();
    const autoToggle = el("label", { class: "computer-use-toggle", for: autoId });
    const autoInput = el("input", {
      id: autoId,
      type: "checkbox",
      "aria-describedby": helpId + " " + emergencyId,
    }) as HTMLInputElement;
    autoInput.checked = this.settings.computer_use_prompt_activation !== false;
    autoInput.disabled = !supported;
    autoToggle.appendChild(autoInput);
    const autoCopy = el("span", { class: "computer-use-toggle-copy" });
    autoCopy.appendChild(
      el("span", { class: "computer-use-toggle-label" }, ["Auto-enable from explicit prompts"]),
    );
    autoCopy.appendChild(
      el("span", { class: "computer-use-toggle-note" }, [
        "Examples: “Playwright my website” or “use computer use and debug the Preview.”",
      ]),
    );
    autoToggle.appendChild(autoCopy);
    panel.appendChild(autoToggle);

    const warning = el("div", { class: "computer-use-warning", id: helpId });
    panel.appendChild(warning);
    const paint = () => {
      this.settings.computer_use_enabled = alwaysInput.checked;
      this.settings.computer_use_prompt_activation = autoInput.checked;
      const paused = !!status?.paused;
      const label = !status
        ? "Unavailable"
        : !supported
          ? "Unsupported"
          : paused
            ? "Paused"
            : alwaysInput.checked
              ? "On"
              : autoInput.checked
                ? "Auto"
                : "Off";
      badge.textContent = label;
      badge.className = "computer-use-badge " +
        (paused ? "paused" : supported ? "ready" : "unavailable");
      warning.textContent = alwaysInput.checked
        ? "Computer Use is always available, but it remains strictly limited to the active Preview tab."
        : autoInput.checked
          ? "Auto mode activates Computer Use only when your prompt clearly requests Preview interaction."
          : "Computer Use is fully off. The model cannot activate Preview control from an implicit prompt.";
    };
    alwaysInput.addEventListener("change", paint);
    autoInput.addEventListener("change", paint);
    paint();

    const controls = el("div", { class: "computer-use-controls" });
    const shortcut = status?.emergencyShortcut || "Ctrl+Alt+Esc";
    controls.appendChild(
      el("div", { class: "computer-use-emergency", id: emergencyId }, [
        status?.emergencyShortcutAvailable === false
          ? shortcut + " could not be registered. Use the pause button to stop Preview actions."
          : "Emergency stop: press " + shortcut + " to pause Preview actions immediately.",
      ]),
    );

    if (supported && status) {
      const pauseButton = el("button", {
        class: "btn sm " + (status.paused ? "primary" : ""),
        type: "button",
        "aria-label": status.paused ? "Resume computer use" : "Pause computer use",
      }, [status.paused ? "Resume" : "Pause"]) as HTMLButtonElement;
      pauseButton.addEventListener("click", async () => {
        pauseButton.disabled = true;
        pauseButton.textContent = status.paused ? "Resuming…" : "Pausing…";
        try {
          this.computerUseStatus = await api.setComputerUsePaused(!status.paused);
          const replacement = this.renderComputerUsePanel();
          panel.replaceWith(replacement);
          window.requestAnimationFrame(() => {
            replacement
              .querySelector<HTMLButtonElement>(".computer-use-controls .btn")
              ?.focus({ preventScroll: true });
          });
        } catch (error) {
          badge.className = "computer-use-badge unavailable";
          badge.textContent = "Error";
          badge.setAttribute("title", String(error));
          pauseButton.disabled = false;
          pauseButton.textContent = status.paused ? "Resume" : "Pause";
        }
      });
      controls.appendChild(pauseButton);
    }
    panel.appendChild(controls);
    return panel;
  }

  private renderDesktopComputerUsePanel(): HTMLElement {
    const status = this.desktopComputerUseStatus;
    const supported = status?.supported ?? false;
    const panel = el("section", {
      class: "computer-use-panel desktop-computer-use-panel",
      "aria-labelledby": "desktop-computer-use-title",
    });

    const head = el("div", { class: "computer-use-head" });
    const titleWrap = el("div", { class: "computer-use-title-wrap" });
    titleWrap.appendChild(
      el("div", { class: "computer-use-title", id: "desktop-computer-use-title" }, ["Desktop mode"]),
    );
    titleWrap.appendChild(
      el("div", { class: "computer-use-subtitle" }, [
        "Control ordinary Windows apps, including Settings",
      ]),
    );
    head.appendChild(titleWrap);
    const badge = el("span", {
      class: "computer-use-badge",
      role: "status",
      "aria-live": "polite",
    });
    head.appendChild(badge);
    panel.appendChild(head);

    const enabledId = this.nextFieldId();
    const toggle = el("label", { class: "computer-use-toggle", for: enabledId });
    const input = el("input", { id: enabledId, type: "checkbox" }) as HTMLInputElement;
    input.checked = !!this.settings.desktop_computer_use_enabled;
    input.disabled = !supported;
    toggle.appendChild(input);
    const copy = el("span", { class: "computer-use-toggle-copy" });
    copy.appendChild(el("span", { class: "computer-use-toggle-label" }, ["Enable Desktop Computer Use"]));
    copy.appendChild(
      el("span", { class: "computer-use-toggle-note" }, [
        supported
          ? "Off by default. Lets the agent click, type, scroll, and drag outside Preview — including Windows Settings brightness."
          : "Desktop Computer Use is available on Windows only.",
      ]),
    );
    toggle.appendChild(copy);
    panel.appendChild(toggle);

    const warning = el("div", { class: "computer-use-warning" });
    const paint = () => {
      this.settings.desktop_computer_use_enabled = input.checked;
      const paused = !!status?.paused;
      badge.textContent = !supported ? "Unsupported" : paused ? "Paused" : input.checked ? "On" : "Off";
      badge.className = "computer-use-badge " +
        (paused ? "paused" : supported && input.checked ? "ready" : "unavailable");
      warning.textContent = input.checked
        ? "Password managers, Windows Security, terminals, and Hormachuelos stay blocked. Press Ctrl+Alt+Esc to stop."
        : "Desktop mode is off. Preview Computer Use above is unchanged.";
    };
    input.addEventListener("change", paint);
    panel.appendChild(warning);
    paint();

    const apps = el("div", { class: "computer-use-apps" });
    apps.appendChild(el("div", { class: "computer-use-apps-label" }, ["Allowed apps"]));
    const chips = el("div", { class: "computer-use-app-chips" });
    const renderChips = () => {
      clear(chips);
      const names = this.settings.desktop_computer_use_allowed_apps || [];
      if (!names.length) {
        chips.appendChild(
          el("span", { class: "computer-use-app-empty" }, [
            "Empty = all ordinary apps except the safety blocklist",
          ]),
        );
        return;
      }
      for (const name of names) {
        const chip = el("span", { class: "computer-use-app-chip" }, [name]);
        const remove = el("button", {
          class: "computer-use-app-remove",
          type: "button",
          "aria-label": "Remove " + name,
        }, ["×"]) as HTMLButtonElement;
        remove.addEventListener("click", () => {
          this.settings.desktop_computer_use_allowed_apps =
            this.settings.desktop_computer_use_allowed_apps.filter((item) => item !== name);
          renderChips();
        });
        chip.appendChild(remove);
        chips.appendChild(chip);
      }
    };
    renderChips();
    apps.appendChild(chips);

    const addRow = el("div", { class: "computer-use-app-add" });
    const addInput = el("input", {
      class: "field",
      type: "text",
      placeholder: "notepad.exe",
      "aria-label": "Process name to allow",
    }) as HTMLInputElement;
    const addButton = el("button", { class: "btn sm", type: "button" }, ["Add"]) as HTMLButtonElement;
    const addFromWindows = el("button", { class: "btn sm", type: "button" }, [
      "Add open window",
    ]) as HTMLButtonElement;
    const addName = (raw: string) => {
      const next = normalizeAllowedApps([
        ...(this.settings.desktop_computer_use_allowed_apps || []),
        raw,
      ]);
      this.settings.desktop_computer_use_allowed_apps = next;
      addInput.value = "";
      renderChips();
    };
    addButton.addEventListener("click", () => addName(addInput.value));
    addInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addName(addInput.value);
      }
    });
    addFromWindows.addEventListener("click", async () => {
      addFromWindows.disabled = true;
      try {
        const listed = await api.listComputerUseTargets();
        const windows = listed.windows || [];
        if (!windows.length) {
          alert("No ordinary windows are currently targetable.");
          return;
        }
        const choice = windows
          .map((window) => `${window.processName} — ${window.title}`)
          .join("\n");
        const picked = prompt("Type the process name to pin, for example notepad.exe:\n\n" + choice);
        if (picked) addName(picked);
      } catch (error) {
        alert("Could not list windows: " + String(error));
      } finally {
        addFromWindows.disabled = false;
      }
    });
    addRow.appendChild(addInput);
    addRow.appendChild(addButton);
    addRow.appendChild(addFromWindows);
    apps.appendChild(addRow);
    panel.appendChild(apps);

    const controls = el("div", { class: "computer-use-controls" });
    const shortcut = status?.emergencyShortcut || this.computerUseStatus?.emergencyShortcut || "Ctrl+Alt+Esc";
    controls.appendChild(
      el("div", { class: "computer-use-emergency" }, [
        "Emergency stop: press " + shortcut + " to pause Preview and Desktop actions.",
      ]),
    );
    panel.appendChild(controls);
    return panel;
  }

  /** GitHub / Supabase / Vercel / … connect cards */
  private renderIntegrationsPanel(): HTMLElement {
    const wrap = el("div", { class: "integrations-list" });
    if (!this.integrations.length) {
      wrap.appendChild(
        el("div", { class: "set-hint" }, [
          "Integrations unavailable (desktop shell required). Open the Hormachuelos app to connect accounts.",
        ]),
      );
      return wrap;
    }

    for (const svc of this.integrations) {
      const card = el("div", {
        class: "integration-card" + (svc.connected ? " connected" : ""),
        "data-integration-id": svc.id,
      });

      const head = el("div", { class: "integration-head" });
      head.appendChild(el("div", { class: "integration-title" }, [svc.label]));
      head.appendChild(
        el(
          "span",
          { class: "integration-badge " + (svc.connected ? "on" : "off") },
          [svc.connected ? "Connected" : "Not connected"],
        ),
      );
      card.appendChild(head);
      card.appendChild(el("div", { class: "set-hint" }, [svc.description]));
      card.appendChild(
        el("div", { class: "set-hint mono", style: "margin-top:4px" }, [
          `Env: ${svc.envKeys.join(", ")}`,
        ]),
      );

      const tokenRow = el("div", { class: "set-key-row", style: "margin-top:8px" });
      const tokenInput = el("input", {
        class: "field",
        type: "password",
        placeholder: svc.connected ? "••••••••  (paste to replace)" : svc.tokenLabel,
        value: "",
        autocomplete: "off",
        "data-integration-secret": "true",
        "aria-label": `${svc.label} credential (stored directly in the OS keyring)`,
      }) as HTMLInputElement;
      tokenInput.addEventListener("input", () => {
        if (this.requestedIntegrationId === svc.id) {
          this.requestedIntegrationId = undefined;
        }
      }, { once: true });
      tokenRow.appendChild(tokenInput);

      const saveBtn = el("button", { class: "btn sm primary", type: "button" }, ["Save"]) as HTMLButtonElement;
      const browserBtn = el(
        "button",
        { class: "btn sm", type: "button" },
        [svc.id === "github" ? "Browser login" : "Secure connect"],
      ) as HTMLButtonElement;
      const testBtn = el("button", { class: "btn sm", type: "button" }, ["Test"]) as HTMLButtonElement;
      const clearBtn = el("button", { class: "btn sm", type: "button" }, ["Clear"]) as HTMLButtonElement;
      const link = el("a", {
        class: "btn sm",
        href: svc.docsUrl,
        target: "_blank",
        rel: "noopener noreferrer",
      }, ["Get token"]);

      const statusEl = el("div", { class: "set-status unset", style: "margin-top:6px" });

      browserBtn.addEventListener("click", async () => {
        browserBtn.setAttribute("disabled", "disabled");
        browserBtn.textContent = "Opening…";
        statusEl.className = "set-status unset";
        statusEl.textContent =
          svc.id === "github"
            ? "Opening browser for GitHub login — complete auth in the browser window…"
            : `Opening ${svc.label} in your browser…`;
        try {
          const r = await api.startIntegrationBrowserAuth(svc.id);
          statusEl.className = `set-status ${r.ok ? "set" : "unset"}`;
          statusEl.textContent = r.message + (r.detail ? ` — ${r.detail}` : "");
          await this.reloadIntegrations();
          // Refresh badge without wiping status text: re-render after short delay
          if (r.ok) {
            window.setTimeout(() => this.render(), 400);
          }
        } catch (e) {
          statusEl.className = "set-status unset";
          statusEl.textContent = String(e);
        } finally {
          browserBtn.removeAttribute("disabled");
          browserBtn.textContent = svc.id === "github" ? "Browser login" : "Secure connect";
        }
      });

      saveBtn.addEventListener("click", async () => {
        const v = tokenInput.value.trim();
        if (!v) {
          statusEl.className = "set-status unset";
          statusEl.textContent = "Paste a token first.";
          return;
        }
        saveBtn.setAttribute("disabled", "disabled");
        try {
          await api.setIntegrationToken(svc.id, v);
          const extras: Record<string, string> = {};
          card.querySelectorAll<HTMLInputElement>("[data-extra-key]").forEach((inp) => {
            const k = inp.getAttribute("data-extra-key");
            if (k && inp.value.trim()) extras[k] = inp.value.trim();
          });
          if (Object.keys(extras).length) {
            await api.setIntegrationExtras(svc.id, extras);
          }
          tokenInput.value = "";
          statusEl.className = "set-status set";
          statusEl.textContent = `${svc.label} token saved.`;
          await this.reloadIntegrations();
          this.render();
        } catch (e) {
          statusEl.className = "set-status unset";
          statusEl.textContent = String(e);
        } finally {
          saveBtn.removeAttribute("disabled");
        }
      });

      testBtn.addEventListener("click", async () => {
        testBtn.setAttribute("disabled", "disabled");
        testBtn.textContent = "Testing…";
        try {
          const r = await api.testIntegration(svc.id);
          statusEl.className = `set-status ${r.ok ? "set" : "unset"}`;
          statusEl.textContent = r.message + (r.detail ? ` — ${r.detail}` : "");
        } catch (e) {
          statusEl.className = "set-status unset";
          statusEl.textContent = String(e);
        } finally {
          testBtn.removeAttribute("disabled");
          testBtn.textContent = "Test";
        }
      });

      clearBtn.addEventListener("click", async () => {
        if (!confirm(`Disconnect ${svc.label}?`)) return;
        try {
          await api.clearIntegrationToken(svc.id);
          await this.reloadIntegrations();
          this.render();
        } catch (e) {
          statusEl.className = "set-status unset";
          statusEl.textContent = String(e);
        }
      });

      tokenRow.appendChild(browserBtn);
      tokenRow.appendChild(saveBtn);
      tokenRow.appendChild(testBtn);
      if (svc.connected) tokenRow.appendChild(clearBtn);
      tokenRow.appendChild(link);
      card.appendChild(tokenRow);

      if (svc.id === "supabase") {
        const extraRow = el("div", { class: "set-key-row", style: "margin-top:6px" });
        extraRow.appendChild(
          el("input", {
            class: "field",
            type: "text",
            placeholder: "Project ref (optional)",
            value: svc.extras.project_ref || "",
            "data-extra-key": "project_ref",
            "aria-label": `${svc.label} project reference`,
          }) as HTMLInputElement,
        );
        extraRow.appendChild(
          el("input", {
            class: "field",
            type: "text",
            placeholder: "Project URL (optional)",
            value: svc.extras.project_url || "",
            "data-extra-key": "project_url",
            "aria-label": `${svc.label} project URL`,
          }) as HTMLInputElement,
        );
        card.appendChild(extraRow);
      }
      if (svc.id === "vercel") {
        const extraRow = el("div", { class: "set-key-row", style: "margin-top:6px" });
        extraRow.appendChild(
          el("input", {
            class: "field",
            type: "text",
            placeholder: "Team ID (optional)",
            value: svc.extras.team_id || "",
            "data-extra-key": "team_id",
            "aria-label": `${svc.label} team ID`,
          }) as HTMLInputElement,
        );
        card.appendChild(extraRow);
      }

      card.appendChild(statusEl);
      wrap.appendChild(card);
    }
    return wrap;
  }

  /**
   * Models shown in the picker. Once the provider returns a catalog,
   * use only that list (full available models) — no manual custom entry.
   */
  private modelsFor(provider: (typeof PROVIDERS)[number]): string[] {
    const discovered = this.discoveredModels[provider.id];
    if (discovered && discovered.length > 0) {
      return [...discovered];
    }
    return [...provider.models];
  }

  private field(label: string, makeControl: () => HTMLElement): HTMLElement {
    const row = el("div", { class: "set-row" });
    const control = makeControl();
    const target = control.matches("input, select, textarea")
      ? control
      : control.querySelector<HTMLElement>("input, select, textarea");
    if (target) {
      if (!target.id) target.id = this.nextFieldId();
      row.appendChild(el("label", { class: "label", for: target.id }, [label]));
    } else {
      row.appendChild(el("div", { class: "label" }, [label]));
    }
    row.appendChild(control);
    return row;
  }

  close() {
    if (!this.modalSessionActive) {
      // Still clear any leftover DOM if a stale async render left content behind.
      if (this.root?.childElementCount) clear(this.root);
      return;
    }
    this.modalSessionActive = false;
    this.computerUseUnlisten?.();
    this.computerUseUnlisten = null;
    this.root.removeEventListener("keydown", this.dialogKeyHandler);
    clear(this.root);
    for (const { node, wasInert } of this.inertSiblings) {
      try {
        node.inert = wasInert;
      } catch {
        /* ignore */
      }
    }
    this.inertSiblings = [];
    const restoreFocus = this.previousFocus;
    this.previousFocus = null;
    try {
      this.onClose();
    } catch (e) {
      console.warn("settings onClose failed", e);
    }
    window.requestAnimationFrame(() => {
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    });
  }
}
