import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Ask mode defaults to Answer Max and requires a visible response", async () => {
  const [agent, config, modelbar, settings] = await Promise.all([
    read("src-tauri/src/agent.rs"),
    read("src-tauri/src/config.rs"),
    read("src/components/modelbar.ts"),
    read("src/components/settings.ts"),
  ]);

  assert.match(agent, /AutomaticContinuationReason::EmptyAnswer/);
  assert.match(agent, /response_has_visible_answer/);
  assert.match(agent, /maximum answer reliability/i);
  assert.match(agent, /Every turn must end with a substantive visible answer/i);
  assert.match(config, /"ask" \| "research" => "answer_max"/);
  assert.match(modelbar, /id: "answer_max"/);
  assert.match(settings, /ask: \["answer_max", "investigate", "brief"\]/);
});

test("Cursor bridge reports and recovers blank assistant completions", async () => {
  const [rustBridge, sourceBridge, runtimeBridge] = await Promise.all([
    read("src-tauri/src/cursor_bridge.rs"),
    read("scripts/cursor-bridge.mjs"),
    read("src-tauri/runtime/scripts/cursor-bridge.mjs"),
  ]);

  assert.equal(runtimeBridge, sourceBridge, "packaged Cursor bridge must match source");
  assert.match(sourceBridge, /answered: sawText/);
  assert.match(rustBridge, /CURSOR_EMPTY_REPLY_PROMPT/);
  assert.match(rustBridge, /answer_text_seen/);
  assert.match(rustBridge, /Cursor returned no visible answer/);
});

test("Preview Computer Use exposes Off Auto On and prompt-intent activation", async () => {
  const [main, preview, ipc, config, css] = await Promise.all([
    read("src/main.ts"),
    read("src/components/site-preview.ts"),
    read("src/ipc.ts"),
    read("src-tauri/src/config.rs"),
    read("src/theme/workspace.css"),
  ]);

  assert.match(main, /resolvePreviewComputerUsePromptIntent/);
  assert.match(main, /playwright\|browser automation/);
  assert.match(main, /computer_use_enabled: computerUseForRun/);
  assert.match(preview, /PreviewComputerUseMode = "off" \| "auto" \| "on"/);
  assert.match(preview, /site-preview-computer-mode/);
  assert.match(preview, /ACTIVE PREVIEW TAB ONLY/);
  assert.match(ipc, /computer_use_prompt_activation: boolean/);
  assert.match(config, /default_computer_use_prompt_activation/);
  assert.match(css, /\.site-preview-computer-modes/);
});