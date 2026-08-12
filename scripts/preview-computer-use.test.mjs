import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const broker = read("src-tauri/src/computer_use.rs");
const tools = read("src-tauri/src/tools.rs");
const cursorBridge = read("src-tauri/src/cursor_bridge.rs");
const preview = read("src/components/site-preview.ts");
const frameController = read("src/components/preview-computer-use.ts");
const browserController = read("src-tauri/src/preview_browser.rs");
const agent = read("src-tauri/src/agent.rs");
const cursorNodeBridge = read("scripts/cursor-bridge.mjs");
const packagedCursorNodeBridge = read("src-tauri/runtime/scripts/cursor-bridge.mjs");

const removedDesktopSymbols = [
  "SetCursorPos", "SendInput", "PrintWindow", "EnumWindows", "GetForegroundWindow",
  "computer_list_windows", "computer_focus_window", "computer_game_sequence",
];

test("computer broker contains no native desktop input path", () => {
  for (const symbol of removedDesktopSymbols) {
    assert.doesNotMatch(broker, new RegExp(symbol), `${symbol} must not return to the broker`);
  }
  assert.match(broker, /preview-computer-request/);
  assert.match(broker, /active-preview-tab-only/);
  assert.match(broker, /MAX_ACTIONS: usize = 48/);
});

test("model surface is reduced to observe plus bounded action batches", () => {
  assert.match(tools, /"computer_observe" \| "computer_actions"/);
  assert.match(tools, /"maxItems": 48/);
  assert.match(tools, /active Preview tab/);
  for (const symbol of removedDesktopSymbols.slice(5)) assert.doesNotMatch(tools, new RegExp(symbol));
  assert.match(cursorBridge, /cursor_host_tool_schemas\(permission_mode, computer_use_active\)/);
  assert.match(cursorBridge, /"computerUseEnabled": false/);
});

test("all model runtimes receive the same Preview-only tool contract", () => {
  assert.equal(cursorNodeBridge, packagedCursorNodeBridge);
  assert.match(cursorNodeBridge, /"computer_observe"[\s\S]*"computer_actions"/);
  assert.doesNotMatch(
    agent,
    /computer_\* tools: protected Windows desktop control/,
  );
  assert.doesNotMatch(
    agent,
    /TOOL REFERENCE:[^\n]*(?:computer_list_windows|computer_focus_window|computer_click|computer_type_text|computer_game_sequence)/,
  );
  assert.match(
    agent,
    /TOOL REFERENCE:[^\n]*computer_observe, computer_actions/,
  );
  assert.match(agent, /playwright this website/);
  assert.match(agent, /drive the live Preview first/);
  assert.match(agent, /computer_observe \/ computer_actions: Preview-only control/);
});

test("frontend always selects the active Preview tab and stops on tab changes", () => {
  assert.match(preview, /const tab = this\.activeTab/);
  assert.match(preview, /tab\.kind === "browser"/);
  assert.match(preview, /runFrameComputerUse\(tab\.frame, request\)/);
  assert.match(preview, /this\.activeTabId !== tabId\) this\.stopComputerUse\(\)/);
  assert.match(preview, /isCrossOriginFrame\(tab\.frame\)/);
});

test("project and Browser tabs render a compositor-friendly in-preview cursor", () => {
  for (const source of [frameController, browserController]) {
    assert.match(source, /translate3d/);
    assert.match(source, /will-change:transform|willChange/);
    assert.match(source, /pointer-events:none/);
    assert.match(source, /hover/);
    assert.match(source, /click/);
    assert.match(source, /scroll/);
    assert.match(source, /drag/);
  }
  assert.match(browserController, /initialization_script\(BROWSER_COMPUTER_SCRIPT\)/);
  assert.match(browserController, /ensure_main_caller\(&caller\)/);
});

test("desktop overlay assets stay deleted", () => {
  for (const path of [
    "src-tauri/src/computer_fx.rs",
    "src-tauri/capabilities/computer-fx.json",
    "src/computer-fx.html",
    "src/computer-fx.ts",
    "src/components/computer-use-hud.ts",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} must remain removed`);
  }
});