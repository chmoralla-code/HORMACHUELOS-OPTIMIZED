import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  isExternalPreviewUrl,
  previewTabKindForEntry,
} from "../src/components/preview-url-policy.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const broker = read("src-tauri/src/computer_use.rs");
const tools = read("src-tauri/src/tools.rs");
const devServer = read("src-tauri/src/dev_server.rs");
const nativeLib = read("src-tauri/src/lib.rs");
const cursorBridge = read("src-tauri/src/cursor_bridge.rs");
const preview = read("src/components/site-preview.ts");
const main = read("src/main.ts");
const ipc = read("src/ipc.ts");
const session = read("src/components/session.ts");
const state = read("src-tauri/src/state.rs");
const cursorRuntime = read("src-tauri/src/cursor_bridge.rs");
const frameController = read("src/components/preview-computer-use.ts");
const browserController = read("src-tauri/src/preview_browser.rs");
const agent = read("src-tauri/src/agent.rs");
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
  assert.match(broker, /open_tab, navigate, and activate_tab must be the only action/);
});

test("model surface is reduced to observe plus bounded action batches", () => {
  assert.match(tools, /"computer_observe" \| "computer_actions"/);
  assert.match(tools, /"maxItems": 48/);
  assert.match(tools, /inside Preview/);
  assert.match(tools, /"open_tab", "navigate", "activate_tab"/);
  assert.match(tools, /never launch the system browser/);
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
  assert.match(agent, /Never use open_url/);
  assert.match(agent, /Hidden-tab page content remains unreadable/);
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
  assert.match(preview, /this\.navigateBrowserTab\(current, url, serverLeaseId\)/);
  assert.match(preview, /this\.activateTab\(tab\.id\)/);
  assert.match(preview, /activeTabUrl: active\.entryPath/);
  assert.match(preview, /needsObservation: true/);
  assert.doesNotMatch(preview, /frame\.src\s*=\s*tab\.entryPath/);
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
    assert.doesNotMatch(source, /animation:[^;]*(?:infinite|linear infinite)/);
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
  assert.match(tools, /Exact standards-format value/);
  assert.match(tools, /"set_value"[\s\S]*"check"/);
  assert.match(broker, /accepts_native_form_values_and_evidence_checks/);
  assert.match(agent, /PREVIEW COMPUTER USE · MAX QA/);
  assert.match(agent, /set_value/);
  assert.match(agent, /check/);
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
test("Preview routing rejects stale project/session owners across async boundaries", () => {
  assert.match(ipc, /setProjectRoot: \(path: string\): Promise<string>/);
  assert.match(ipc, /sessionId: string;[\s\S]*projectRoot: string;[\s\S]*runNonce: string;/);

  assert.match(main, /let projectRootMutationQueue: Promise<void> = Promise\.resolve\(\)/);
  assert.match(main, /serializeProjectRootMutation\(async \(\) => \{[\s\S]*if \(!quickSession\) return api\.setProjectRoot\(path\);[\s\S]*const quickPath = await api\.ensureQuickSessionWorkspace\(\);[\s\S]*return api\.setProjectRoot\(quickPath\)/);
  const ensureQuickStart = nativeLib.indexOf("fn ensure_quick_session_workspace");
  const ensureQuickEnd = nativeLib.indexOf("#[tauri::command]", ensureQuickStart + 10);
  const ensureQuick = nativeLib.slice(ensureQuickStart, ensureQuickEnd);
  assert.doesNotMatch(ensureQuick, /tauri::State|state\.project_root|state:/,
    "Quick workspace discovery must not mutate the native active root outside the selection queue");
  const quickOpenStart = main.indexOf("async function openQuickSessionWorkspace");
  const quickOpenEnd = main.indexOf("function repairProjectRootReferences", quickOpenStart);
  const quickOpen = main.slice(quickOpenStart, quickOpenEnd);
  assert.match(quickOpen, /await selectProject\(/);
  assert.doesNotMatch(quickOpen, /ensureQuickSessionWorkspace|serializeProjectRootMutation/,
    "a Quick click must enqueue exactly one root mutation, so a later Project click remains last");
  const selectStart = main.indexOf("async function selectProject");
  const selectAwait = main.indexOf("await serializeProjectRootMutation", selectStart);
  const selectGuard = main.indexOf("selectionGeneration !== projectSelectionGeneration", selectAwait);
  assert.ok(selectStart >= 0 && selectAwait > selectStart && selectGuard > selectAwait,
    "rapid project switches must be serialized and invalidated after canonical-root resolution");

  const openStart = main.indexOf("async function openBuildPreview");
  const openAwait = main.indexOf("await sitePreview.open", openStart);
  const openOwnerGuard = main.indexOf("activeSessionId !== expectedActiveSessionId", openAwait);
  assert.ok(openStart >= 0 && openAwait > openStart && openOwnerGuard > openAwait,
    "a delayed Preview open must re-check its session owner after awaiting");
  assert.match(main, /ownerSessionId: targetSessionId \?\? null/);
  assert.match(main, /persistPreviewForSession\(owner\.sessionId, preview\)/);
  assert.match(main, /!request\.runNonce\?\.trim\(\)/);
  assert.match(main, /activeRunNonces\.get\(request\.sessionId\) !== request\.runNonce/);
  assert.match(main, /activeRunNonces\.set\(sid, nonce\)/);
  assert.match(main, /activeRunNonces\.delete\(sessionId\)/);
  assert.match(state, /run_nonce: uuid::Uuid::new_v4\(\)\.to_string\(\)/);
  assert.match(agent, /let run_nonce = run\.run_nonce\(\)\.to_string\(\)/);
  assert.match(cursorRuntime, /let run_nonce = run\.run_nonce\(\)\.to_string\(\)/);
  assert.match(agent, /"run_nonce": run\.run_nonce\(\)/);
  assert.match(cursorRuntime, /"run_nonce": run\.run_nonce\(\)/);
  assert.match(main, /!sitePreview\.ownsView\(request\.sessionId, request\.projectRoot\)/);

  const restoreStart = preview.indexOf("async restoreSessionState");
  const activeAssignment = preview.indexOf("this.activeTabId = this.tabs[activeIndex].id", restoreStart);
  const firstReload = preview.indexOf("await this.reloadTab(tab)", restoreStart);
  assert.ok(restoreStart >= 0 && activeAssignment > restoreStart && firstReload > activeAssignment,
    "restoration must expose the intended active tab before asynchronous reloads");
  assert.match(preview, /const ownerChanged = this\.ownerSessionId !== nextOwnerSessionId/);
  assert.match(preview, /if \(projectChanged \|\| ownerChanged\)/);
  assert.match(preview, /Computer Use request owner does not match the active Preview session\/project/);
  assert.match(session, /serverOwner\?: string/);
  assert.match(session, /isLocalServer\(entryPath\) && !ownsLocalServer/);
});
test("dev-server Preview opens only from verified result metadata for its exact owner", () => {
  const openSetStart = main.indexOf("const PREVIEW_OPEN_TOOLS");
  const openSetEnd = main.indexOf("]);", openSetStart);
  const openSet = main.slice(openSetStart, openSetEnd);
  assert.doesNotMatch(openSet, /open_url|openurl/,
    "open_url tool calls must not speculatively navigate Preview");
  assert.match(main, /pendingDevServerTools = new Map/);
  assert.match(main, /normalizeToolName\(e\.payload\.name\) !== "start_dev_server"/);
  assert.match(main, /HORMACHUELOS_DEV_SERVER_META /);
  assert.match(main, /meta\.kind !== "dev_server"/);
  assert.match(main, /!isExternalPreviewUrl\(url\.toString\(\)\) \|\| url\.protocol !== "http:"/);
  assert.match(main, /!sameProjectPath\(meta\.projectRoot, expectedProjectRoot\)/);
  const openArgsStart = main.indexOf("function htmlPathFromOpenArgs");
  const openArgsEnd = main.indexOf("async function openBuildPreview", openArgsStart);
  const openArgs = main.slice(openArgsStart, openArgsEnd);
  assert.match(openArgs, /if \(isExternalPreviewUrl\(raw\)\) return null/);
  assert.doesNotMatch(openArgs, /return raw\.trim\(\)/);
  assert.match(main, /const key = devServerToolKey\(sid, e\.payload\.id\);[\s\S]*pendingDevServerTools\.delete\(key\)/);
  assert.match(main, /sid !== pending\.sessionId/);
  assert.match(main, /sessionId: pending\.sessionId,[\s\S]*projectRoot: pending\.projectRoot,[\s\S]*entryPath: meta\.url/);
  assert.match(main, /if \(sid && isTerminalAgentEvent\(e\)\) clearPendingDevServerTools\(sid\)/);
});


test("local Preview URLs share one parsed loopback policy", () => {
  for (const url of [
    "http://localhost:3000",
    "https://app.localhost:4443/path",
    "http://127.42.0.7:5173",
    "http://[::1]:3000",
    "http://0.0.0.0:3000",
    "http://[::]:3000",
  ]) {
    assert.equal(isExternalPreviewUrl(url), true, url);
  }
  assert.equal(isExternalPreviewUrl("https://example.com"), false);
  assert.equal(isExternalPreviewUrl("file:///tmp/site.html"), false);
});

test("saved local Preview tabs require a native live server lease", () => {
  assert.match(session, /serverLeaseId\?: string;/);
  assert.match(session, /serverStatus\?: "ready" \| "restart_required";/);
  assert.match(preview, /api\.validateDevServerLease\(tab\.serverLeaseId, projectRoot, tab\.entryPath\)/);
  assert.match(preview, /tab\.serverStatus = validation\?\.valid === true && validation\.ready === true/);
  assert.match(preview, /renderServerRestartState\(tab\)/);
  assert.match(preview, /if \(tab\.serverStatus === "restart_required"\)/);
  const ensureStart = preview.indexOf("private async ensureBrowserSurface");
  const restartGuard = preview.indexOf('tab.serverStatus === "restart_required"', ensureStart);
  const readyGuard = preview.indexOf("if (tab.browserReady) return", ensureStart);
  assert.ok(restartGuard > ensureStart && readyGuard > restartGuard,
    "restart-required tabs must close/downgrade before browserReady can return");
  assert.match(preview, /await api\.closePreviewBrowser\(tab\.id\)[\s\S]*tab\.browserReady = false[\s\S]*tab\.browserLoading = false/);
  assert.match(preview, /const nextServerReady = opts\.serverReady !== false/);
  assert.match(preview, /\|\| !nextServerReady/);
  assert.match(ipc, /validateDevServerLease: \(\s*leaseId: string \| null,\s*projectRoot: string,\s*url: string,?\s*\)/);
  assert.match(devServer, /listener_belongs_to_process_tree\(port, lease\.pid\)/);
  assert.match(devServer, /reason: "listener_owner_mismatch"/);
});

test("verified server routing waits for ownership and bypasses broad run dedupe", () => {
  assert.match(main, /const devServerToolKey = \(sessionId: string, toolId: string\)/);
  assert.match(main, /pendingDevServerTools\.set\(\s*devServerToolKey\(sid, e\.payload\.id\)/);
  assert.match(main, /pendingDevServerTools\.get\(key\)/);
  assert.match(main, /forceExactEntry\?: boolean;/);
  assert.match(main, /previewOpenedForRun\.has\(opts\.sessionId\)[\s\S]*opts\.forceExactEntry !== true/);
  assert.match(main, /const deadline = Date\.now\(\) \+ 8_000;/);
  assert.match(main, /api\.validateDevServerLease\(\s*meta\.leaseId,\s*pending\.projectRoot,\s*meta\.url,?\s*\)/);
  assert.match(main, /serverReady: ready/);
  assert.match(main, /forceExactEntry: true/);
  assert.match(main, /runNonce: string/);
  assert.match(main, /const stillOwnsRun = \(\) =>[\s\S]*activeRunNonces\.get\(pending\.sessionId\) === pending\.runNonce/);
  assert.match(main, /if \(!stillOwnsRun\(\)\) return;[\s\S]*await api\.validateDevServerLease/);
  assert.match(main, /const runNonce = activeRunNonces\.get\(sid\)/);
  assert.match(main, /\{ sessionId: sid, projectRoot, runNonce \}/);
  assert.match(main, /if \(sid && isTerminalAgentEvent\(e\)\) \{[\s\S]*activeRunNonces\.delete\(sid\)/);
});

test("Computer Use rejects guessed localhost before frontend dispatch", () => {
  assert.match(broker, /validate_loopback_navigation\(args, owner\)\?/);
  assert.match(broker, /validate_dev_server_lease\(\s*None,\s*&owner\.project_root,\s*url,?\s*\)/);
  assert.match(broker, /loopback URL only when it matches a ready, live development-server lease owned by this exact project/);
  assert.match(preview, /api\.validateDevServerLease\(null, this\.projectRoot, url\)/);
  assert.match(preview, /validation\?\.valid !== true \|\| validation\.ready !== true/);
  assert.match(preview, /private async requireActiveLocalLease\(tab: PreviewTab\)/);
  assert.match(preview, /api\.validateDevServerLease\(\s*leaseId,\s*this\.projectRoot,\s*url,?\s*\)/);
  assert.match(preview, /if \(url && isExternalPreviewUrl\(url\)\)[\s\S]*localUrlHasLiveLease\(tab, url\)[\s\S]*downgradeLocalServerTab\(tab\)/);
  assert.match(preview, /validation\.leaseId === leaseId/);
  assert.match(preview, /await api\.closePreviewBrowser\(tab\.id\)/);
  assert.match(preview, /await this\.requireActiveLocalLease\(tab\)/);
  assert.match(preview, /The localhost Preview cannot be promoted without a ready development-server lease owned by this project/);
});

test("dev server ownership is byte-exact, descendant-bound, and retryable", () => {
  assert.match(devServer, /Sha256::digest\(command\.trim\(\)\.as_bytes\(\)\)/);
  assert.doesNotMatch(devServer, /command\.split_whitespace\(\)/);
  assert.match(devServer, /command_succeeds_before\(&mut command, Duration::from_millis\(1_500\)\)/);
  assert.match(devServer, /process_descends_from_with/);
  assert.match(devServer, /OwnershipDecision::LeaseOwnerMismatch/);
  assert.match(devServer, /OwnershipDecision::ManagedNotReady =>/);
  assert.match(tools, /validate_dev_server_lease\(\s*Some\(&lease\.lease_id\),\s*&lease\.project_root,\s*&url,?\s*\)/);
});
