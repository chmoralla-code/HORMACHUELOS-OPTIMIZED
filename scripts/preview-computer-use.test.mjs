import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  extractPreviewBrowserUrlFromPrompt,
  isExternalPreviewUrl,
  previewTabKindForEntry,
  promptWantsLocalWebsite,
} from "../src/components/preview-url-policy.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const broker = read("src-tauri/src/computer_use.rs");
const tools = read("src-tauri/src/tools.rs");
const cursorBridge = read("src-tauri/src/cursor_bridge.rs");
const preview = read("src/components/site-preview.ts");
const frameController = read("src/components/preview-computer-use.ts");
const browserController = read("src-tauri/src/preview_browser.rs");
const agent = read("src-tauri/src/agent.rs");
const main = read("src/main.ts");
const cursorNodeBridge = read("scripts/cursor-bridge.mjs");
const packagedCursorNodeBridge = read("src-tauri/runtime/scripts/cursor-bridge.mjs");

const removedDesktopSymbols = [
  "SetCursorPos", "SendInput", "PrintWindow", "EnumWindows", "GetForegroundWindow",
  "computer_list_windows", "computer_focus_window", "computer_game_sequence",
];

test("localhost project servers always use the native Preview Browser", () => {
  for (const url of [
    "http://localhost:3000",
    "http://localhost:3100/supervisor/incident-reports",
    "http://127.0.0.1:3000/",
    "https://127.0.0.1:8443/path",
  ]) {
    assert.equal(isExternalPreviewUrl(url), true, `${url} must be recognized as local`);
    assert.equal(
      previewTabKindForEntry(url, "preview"),
      "browser",
      `${url} must never be persisted as a project iframe`,
    );
  }
  assert.equal(previewTabKindForEntry("index.html", "preview"), "preview");
  assert.equal(previewTabKindForEntry("index.html", "browser"), "browser");
  assert.equal(isExternalPreviewUrl("https://example.com"), false);
});

test("computer broker contains no native desktop input path", () => {
  for (const symbol of removedDesktopSymbols) {
    assert.doesNotMatch(broker, new RegExp(symbol), `${symbol} must not return to the broker`);
  }
  assert.match(broker, /preview-computer-request/);
  assert.match(broker, /active-preview-tab-only/);
  assert.match(broker, /MAX_ACTIONS: usize = 48/);
  assert.match(broker, /tauri::Url::parse/);
  assert.match(broker, /credential-free http\(s\) URLs/);
  assert.match(broker, /open_tab, navigate, activate_tab, set_viewport, save_spec, record, and replay must be the only action/);
});

test("model surface is reduced to observe plus bounded action batches", () => {
  assert.match(tools, /"computer_observe" \| "computer_actions"/);
  assert.match(tools, /"maxItems": 48/);
  assert.match(tools, /inside Preview/);
  assert.match(tools, /"open_tab", "navigate", "activate_tab"/);
  assert.match(tools, /never launch the system browser/);
  assert.match(tools, /fn desktop_computer_tool_schemas/);
  assert.match(tools, /computer_observe_window/);
  assert.match(cursorBridge, /cursor_host_tool_schemas\(/);
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
  assert.match(agent, /Never use open_url/);
  assert.match(agent, /opens the Preview window/);
  assert.match(agent, /Never ask the user to open Preview/);
  assert.match(agent, /Hidden-tab page content remains unreadable/);
});

test("Computer Use opens Preview and a Browser tab from a prompt", () => {
  assert.equal(
    extractPreviewBrowserUrlFromPrompt("can you use computer use and search for youtube.com"),
    "https://youtube.com/",
  );
  assert.equal(
    extractPreviewBrowserUrlFromPrompt("open https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(extractPreviewBrowserUrlFromPrompt("describe this screenshot"), null);
  assert.equal(promptWantsLocalWebsite("open the website"), true);
  assert.equal(promptWantsLocalWebsite("show the site"), true);
  assert.equal(promptWantsLocalWebsite("build a marketing website"), false);
  assert.equal(promptWantsLocalWebsite("open https://youtube.com"), false);
  assert.match(preview, /async openForComputerUse/);
  assert.match(preview, /ensureOpenForComputerUse/);
  assert.match(preview, /this\.showShell\("Preview"\)/);
  assert.match(preview, /this\.openBrowserTab\(url/);
  assert.match(preview, /this\.openBrowserTab\(BROWSER_HOME/);
  assert.doesNotMatch(preview, /Open the Preview window before using the AI cursor/);
  assert.match(main, /openForComputerUse/);
  assert.match(main, /extractPreviewBrowserUrlFromPrompt\(visiblePrompt\)/);
  assert.match(main, /promptWantsLocalWebsite\(visiblePrompt\)/);
  assert.match(main, /ensureProjectDevServer\(projectRoot\)/);
  assert.match(main, /computerUseIntent === "enable" \|\| computerUseIntent === "auto" \|\| promptWantsLocalWebsite\(visiblePrompt\)/);
  assert.match(tools, /If Preview is closed, the host opens the Preview window/);
});

test("frontend always selects the active Preview tab and stops on tab changes", () => {
  assert.match(preview, /let tab = this\.activeTab/);
  assert.match(preview, /tab\.kind === "browser"/);
  assert.match(preview, /runFrameComputerUse\(tab\.frame, request\)/);
  assert.match(preview, /this\.activeTabId !== tabId\) this\.stopComputerUse\(\)/);
  assert.match(preview, /isCrossOriginFrame\(tab\.frame\)/);
  assert.match(preview, /promoteExternalPreviewTab\(tab/);
  assert.match(preview, /previewTabKindForEntry\(clean\) === "browser"/);
  assert.match(preview, /computerUseTabList\(\)/);
  assert.match(preview, /runComputerUseTabAction/);
  assert.match(preview, /this\.openBrowserTab\(url/);
  assert.match(preview, /this\.navigateBrowserTab\(current, url\)/);
  assert.match(preview, /this\.activateTab\(tab\.id\)/);
  assert.match(preview, /activeTabUrl: active\.entryPath/);
  assert.match(preview, /needsObservation: true/);
  assert.doesNotMatch(preview, /frame\.src\s*=\s*tab\.entryPath/);
  assert.match(preview, /overlayChromeOpen\(\)/);
  assert.match(preview, /!this\.newTabMenu\.hidden \|\| !this\.previewActionsMenu\.hidden/);
  assert.match(preview, /browserSurfaceAllowed\(\)/);
});

test("project and Browser tabs select and verify nested scroll targets", () => {
  assert.match(frameController, /elementFromPoint\(this\.cursorPoint\.x, this\.cursorPoint\.y\)/);
  assert.match(frameController, /while \(node\)/);
  assert.match(frameController, /choosePreviewScrollCandidate/);
  assert.match(frameController, /target: candidate\.target === this\.view \? "page" : "nested"/);
  assert.match(frameController, /before, after/);
  assert.match(frameController, /moved, boundary: !moved/);
  assert.match(frameController, /scrollable = true|scrollable: true/);
  assert.match(frameController, /MAX_INTERACTIVE_SCAN = 320/);
  assert.match(frameController, /MAX_ANCESTOR_SCAN = 480/);
  assert.match(frameController, /inspectedAncestors/);
  assert.match(frameController, /\[\.\.\.scrollables, \.\.\.interactive\]/);
  assert.match(frameController, /visibleSemanticContent/);
  assert.match(frameController, /MAX_SEMANTIC_SCAN = 240/);
  assert.match(frameController, /MAX_VISIBLE_CONTENT = 32/);
  assert.match(frameController, /content: visibleSemanticContent/);
  assert.doesNotMatch(frameController, /querySelectorAll\("\*"\)/);
  assert.match(frameController, /viewport\.scrollY is page-only/);

  assert.match(browserController, /document\.elementFromPoint\(point\.x,point\.y\)/);
  assert.match(browserController, /for\(let n=el;n;n=n\.parentElement\)/);
  assert.match(browserController, /chooseScroll\(scrollCandidates/);
  assert.match(browserController, /target:candidate\.kind/);
  assert.match(browserController, /before,after,applied/);
  assert.match(browserController, /moved,boundary:!moved/);
  assert.match(browserController, /item\.scrollable=true/);
  assert.match(browserController, /scanned>=320\|\|interactive\.length>=80/);
  assert.match(browserController, /inspected=new Set\(\)/);
  assert.match(browserController, /\[\.\.\.scrollables,\.\.\.interactive\]/);
  assert.match(browserController, /const semantic=/);
  assert.match(browserController, /scanned<240&&out\.length<32/);
  assert.match(browserController, /content:semantic\(\)/);
  assert.doesNotMatch(browserController, /querySelectorAll\('\*'\)\.filter\(scrollable\)/);
  assert.match(browserController, /viewport\.scrollY is page-only/);

  assert.match(tools, /with no target it scrolls under the visible AI cursor/i);
  assert.match(tools, /Positive delta_y scrolls down and negative scrolls up/);
  assert.match(agent, /viewport\.scrollY measures only the page/);
  assert.match(agent, /do not repeat the identical scroll blindly/);
});

test("project and Browser tabs render bounded cinematic cursor feedback", () => {
  for (const source of [frameController, browserController]) {
    assert.match(source, /translate3d/);
    assert.match(source, /width:52px/);
    assert.match(source, /will-change:transform,opacity|willChange/);
    assert.match(source, /contain:(?:layout style paint|strict)/);
    assert.match(source, /pointer-events:none/);
    assert.match(source, /data-gesture|dataset\.gesture/);
    assert.match(source, /prefers-reduced-motion/);
    assert.match(source, /(?:ai-target|browser_target)/);
    assert.match(source, /(?:trail|shockwave)/);
    assert.match(source, /hover/);
    assert.match(source, /click/);
    assert.match(source, /scroll/);
    assert.match(source, /drag/);
    assert.doesNotMatch(source, /backdrop-filter/);
    const cursorFx = source
      .replace(/@keyframes __horma-ai-frame-(?:spin|breathe|glow|shade)\{[^}]*\}/g, "")
      .replace(/#__horma_browser_viewport(?::after)?\{[^}]*\}/g, "");
    assert.doesNotMatch(cursorFx, /animation:[^;]*(?:infinite|linear infinite)/);
  }
  assert.match(frameController, /MAX_CURSOR_TRAIL_SPARKS = 3/);
  assert.match(frameController, /MAX_CURSOR_TRANSIENTS = 8/);
  assert.match(browserController, /transients\.length>8/);
  assert.match(browserController, /initialization_script\(BROWSER_COMPUTER_SCRIPT\)/);
  assert.match(browserController, /ensure_main_caller\(&caller\)/);
});

test("Preview Computer Use can fill native controls and verify evidence", () => {
  for (const source of [frameController, browserController]) {
    assert.match(source, /set_value/);
    assert.match(source, /check/);
    assert.match(source, /inputType/);
    assert.match(source, /validationMessage/);
    assert.match(source, /\[redacted\]/);
    assert.match(source, /(?:MouseEvent|mouseEvent)/);
    assert.match(source, /(?:visibleSemanticContent|const semantic=)/);
  }
  assert.match(tools, /wait_for/);
  assert.match(tools, /tiny\.png/);
  assert.match(tools, /set_viewport/);
  assert.match(tools, /save_spec/);
  assert.match(broker, /wait_for/);
  assert.match(broker, /tiny\.png/);
  assert.match(agent, /wait_for/);
  assert.match(agent, /a11y/);
  assert.match(preview, /Watch me/);
  assert.match(preview, /Save as test/);
  assert.match(preview, /data-device-frame|deviceFrame/);
  assert.match(frameController, /wait_for/);
  assert.match(frameController, /tiny\.png/);
  assert.match(frameController, /scanPreviewA11y|a11y/);
  assert.match(browserController, /wait_for/);
  assert.match(browserController, /tiny\.png/);
  assert.match(browserController, /a11y/);
  assert.match(broker, /accepts_native_form_values_and_evidence_checks/);
  assert.match(agent, /PREVIEW COMPUTER USE · MAX QA/);
  assert.match(agent, /set_value/);
  assert.match(agent, /check/);
});

test("desktop overlay is click-through cinematic FX for Desktop mode", () => {
  for (const path of [
    "src-tauri/src/computer_fx.rs",
    "src-tauri/capabilities/computer-fx.json",
    "src/computer-fx.html",
    "src/computer-fx.ts",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `${path} must exist`);
  }
  assert.equal(
    existsSync(new URL("../src/components/computer-use-hud.ts", import.meta.url)),
    false,
    "in-app computer-use HUD must stay removed",
  );
  const fx = read("src-tauri/src/computer_fx.rs");
  const overlay = read("src/computer-fx.ts");
  const lib = read("src-tauri/src/lib.rs");
  const desktop = read("src-tauri/src/desktop_computer_use.rs");
  const capability = read("src-tauri/capabilities/computer-fx.json");
  const vite = read("vite.config.ts");
  assert.match(fx, /typing_fx_never_serializes_typed_content/);
  assert.match(fx, /payload\.text = None/);
  assert.match(overlay, /__horma-ai-cursor/);
  assert.match(overlay, /__horma-ai-shockwave/);
  assert.match(overlay, /AI cursor · Desktop/);
  assert.match(overlay, /prefers-reduced-motion/);
  assert.match(overlay, /overlayWindow\.hide/);
  assert.match(overlay, /__horma-ai-frame-glow/);
  assert.match(overlay, /linear-gradient\(to right/);
  assert.match(overlay, /inset 0 0 0 2px #fff/);
  assert.doesNotMatch(overlay, /backdrop-filter/);
  assert.match(browserController, /__horma_browser_viewport/);
  assert.match(browserController, /viewportFx\?\.remove/);
  assert.match(lib, /set_ignore_cursor_events\(true\)/);
  assert.match(lib, /computer_fx::install_emitter/);
  assert.match(capability, /"computer-fx"/);
  assert.match(capability, /allow-set-ignore-cursor-events/);
  assert.match(vite, /computer-fx\.html/);
  assert.match(desktop, /computer_fx::clear/);
  assert.match(desktop, /computer_fx::click/);
  assert.match(desktop, /computer_fx::target/);
  assert.match(desktop, /cursor_diverged/);
  assert.match(desktop, /crate::computer_fx::clear\(\)/);
});