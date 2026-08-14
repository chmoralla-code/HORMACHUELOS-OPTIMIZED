import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/components/settings.ts", import.meta.url), "utf8");

test("Gemini 3.7 Flash is a built-in Optimized picker model", () => {
  assert.match(settings, /id: "gemini"/);
  assert.match(settings, /defaultModel: "gemini-3\.7-flash"/);
  assert.match(settings, /"gemini-3\.7-flash"/);
  assert.match(settings, /"Gemini 3\.7 Flash"/);
  assert.match(settings, /id === "hormachuelos_free" \|\| id === "gemini"/);
});
