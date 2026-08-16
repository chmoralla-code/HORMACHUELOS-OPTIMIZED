import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/components/settings.ts", import.meta.url), "utf8");

test("Gemini 3.7 Flash is a built-in Optimized picker model", () => {
  assert.match(settings, /id: "gemini"/);
  assert.match(settings, /id: "gemini_cli"/);
  assert.match(settings, /label: "Gemini CLI"/);
  assert.match(settings, /defaultModel: "gemini-3\.5-flash"/);
  assert.match(settings, /"gemini-3\.7-flash"/);
  assert.match(settings, /"gemini-3\.1-pro-preview"/);
  assert.match(settings, /"Gemini 3\.7 Flash"/);
  assert.match(settings, /geminiEffortOptions/);
  assert.match(settings, /label: "Minimal"/);
  assert.match(settings, /label: "Dynamic"/);
  assert.match(settings, /"gemini_cli"/);
  assert.match(settings, /id === "hormachuelos_free" \|\| id === "gemini"/);
  assert.match(settings, /Uses the Google account already logged into Gemini CLI/);
  assert.match(settings, /LOCAL_MACHINE_PROVIDER_IDS = new Set\(\["ollama", "gemini_cli"\]\)/);
  assert.match(settings, /keep local machine providers/i);
  assert.match(settings, /appendLocalMachineProviders/);
  assert.match(settings, /BUILTIN_PROVIDERS\.find\(\(p\) => p\.id === normalized\)/);
});
