/**
 * Plan budgets + billable weights — keep in sync with src-tauri/src/license.rs
 *
 * Pricing basis (official list rates, USD / 1M tokens):
 *   GPT 5.6 Sol  (Cursor Grok 4.5)     $2.00 in / $6.00 out
 *   GPT 5.6 Luna (Composer 2.5 Fast*)  $3.00 in / $15.00 out  (*Cursor default)
 *   Composer 2.5 Standard              $0.50 in / $2.50 out
 *   DeepSeek V4 Flash                  $0.14 in / $0.28 out
 *   DeepSeek V4 Pro                    $0.435 in / $0.87 out
 *   OpenAI GPT-5.6 Sol (direct API)    $5.00 in / $30.00 out
 *   OpenAI GPT-5.6 Terra               $2.00 in / $12.00 out
 *   OpenAI GPT-5.6 Luna (direct API)   $0.20 in / $1.20 out
 *   Claude Opus-class                  $5.00 in / $25.00 out
 *   Gemini 3.1 Pro                     $2.00 in / $12.00 out
 *   GLM 5.2                            $1.40 in / $4.40 out
 *   OpenRouter :free / Ollama          $0 (local or free tier)
 *
 * Agent mix assumed 80% input / 20% output. Reference COGS = Grok 4.5 blend
 * ($2.80 / 1M). Plan pools use a 2× markup: 50% of PHP price funds that COGS
 * (₱58 / $1). Billable weights = model_blend / $2.80 so expensive models
 * drain the wallet faster.
 */

const PHP_PER_USD = 58;
const MARKUP = 2; // earn 2× on upstream list COGS
const REF_BLEND_USD_PER_1M = 2.8; // Grok 4.5 / GPT 5.6 Sol @ 80/20 mix

/** PHP sticker prices used to size usage pools. */
export const PLAN_PRICES_PHP = {
  starter: 299,
  pro: 999,
  proplus: 2499,
  max5: 2499,
  max10: 4999,
  max20: 9999,
};

/** Official blended $/1M at 80% input + 20% output. */
export const MODEL_BLEND_USD_PER_1M = {
  "grok-4.5": 2.8,
  "gpt-5.6-sol": 2.8,
  "composer-2.5": 5.4, // Fast default
  "gpt-5.6-luna": 5.4,
  "composer-2.5-standard": 0.9,
  "gpt-5.6-terra": 4.0,
  "deepseek-v4-flash": 0.168,
  "deepseek-v4-pro": 0.522,
  "claude-opus": 9.0,
  "gemini-3.7-flash": 1.5,
  "gemini-3.1-pro": 4.0,
  "glm-5.2": 2.0,
  free: 0.05,
};

function tokensForPlanPrice(pricePhp) {
  const cogsUsd = pricePhp / PHP_PER_USD / MARKUP;
  return Math.max(1, Math.round((cogsUsd / REF_BLEND_USD_PER_1M) * 1_000_000));
}

export const PLAN_BUDGETS = {
  starter: tokensForPlanPrice(PLAN_PRICES_PHP.starter), // ~920k
  pro: tokensForPlanPrice(PLAN_PRICES_PHP.pro), // ~3.08M
  proplus: tokensForPlanPrice(PLAN_PRICES_PHP.proplus), // ~7.69M
  max5: tokensForPlanPrice(PLAN_PRICES_PHP.max5),
  max: tokensForPlanPrice(PLAN_PRICES_PHP.max5),
  agency: tokensForPlanPrice(PLAN_PRICES_PHP.max5),
  max10: tokensForPlanPrice(PLAN_PRICES_PHP.max10), // ~15.39M
  max20: tokensForPlanPrice(PLAN_PRICES_PHP.max20), // ~30.79M
};

export function normalizePlan(planId) {
  const id = String(planId || "starter").toLowerCase().trim();
  if (id === "max" || id === "agency" || id === "ultra") return "max5";
  if (id === "pro+" || id === "pro_plus") return "proplus";
  if (id === "fifteen" || id === "15day" || id === "15-day") return "pro";
  if (id === "start") return "starter";
  return id;
}

export function planBudget(planId) {
  const plan = normalizePlan(planId);
  return PLAN_BUDGETS[plan] ?? PLAN_BUDGETS.starter;
}

export function licensePrefix(planId) {
  const plan = normalizePlan(planId);
  if (plan === "max20") return "HORMA-MAX20";
  if (plan === "max10") return "HORMA-MAX10";
  if (plan === "max5") return "HORMA-MAX";
  if (plan === "proplus") return "HORMA-PROPLUS";
  if (plan === "pro") return "HORMA-PRO";
  return "HORMA-STARTER";
}

function billableWeight(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  const ratio = (blend) => blend / REF_BLEND_USD_PER_1M;

  if (p === "deepseek" && m.includes("flash")) return ratio(MODEL_BLEND_USD_PER_1M["deepseek-v4-flash"]);
  if (p === "deepseek") return ratio(MODEL_BLEND_USD_PER_1M["deepseek-v4-pro"]);
  if (p === "hormachuelos_free") return ratio(MODEL_BLEND_USD_PER_1M["deepseek-v4-flash"]);
  if (p === "ollama" || p === "pollinations") return ratio(MODEL_BLEND_USD_PER_1M.free);
  if (p === "openrouter" && (m.includes("free") || m.endsWith(":free"))) {
    return ratio(MODEL_BLEND_USD_PER_1M.free);
  }
  if (p === "openrouter") return 0.45;
  if (p === "glm" || p === "zhipu") return ratio(MODEL_BLEND_USD_PER_1M["glm-5.2"]);
  if (p === "gemini") return ratio(MODEL_BLEND_USD_PER_1M["gemini-3.1-pro"]);
  if (p === "anthropic") return ratio(MODEL_BLEND_USD_PER_1M["claude-opus"]);
  if (p === "cursor" || p === "openai" || p === "xai") {
    if (m.includes("composer") || m.includes("luna")) {
      return ratio(MODEL_BLEND_USD_PER_1M["composer-2.5"]);
    }
    if (m.includes("terra")) return ratio(MODEL_BLEND_USD_PER_1M["gpt-5.6-terra"]);
    return ratio(MODEL_BLEND_USD_PER_1M["grok-4.5"]);
  }
  return 1;
}

export function billableTokens(provider, model, raw) {
  if (!raw || raw <= 0) return 0;
  const weight = billableWeight(provider, model);
  return Math.max(1, Math.ceil(raw * weight));
}
