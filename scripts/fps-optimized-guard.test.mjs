import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("optimized product identity is independent", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const packageManifest = JSON.parse(read("package.json"));
  const cargo = read("src-tauri/Cargo.toml");
  const escapedVersion = packageManifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.equal(config.productName, "Hormachuelos Optimized");
  assert.equal(config.identifier, "com.hormachuelos.optimized");
  assert.match(packageManifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(config.version, packageManifest.version);
  assert.match(cargo, new RegExp(`\\[package\\][\\s\\S]*?\\nversion = "${escapedVersion}"`));
  assert.match(read("src/index.html"), /body class="fps-optimized"/);
  assert.match(cargo, /name = "hormachuelos-optimized"/);
  assert.match(read("src-tauri/src/config.rs"), /hormachuelos-optimized/);
  assert.match(read("src/components/update-gate.ts"), /HORMACHUELOS-OPTIMIZED\/latest\.json/);
  assert.match(read("src-tauri/src/app_updater.rs"), /HORMACHUELOS-OPTIMIZED\/releases\/download/);
});

test("live rendering is frame-bounded and incremental", () => {
  const chat = read("src/components/chat.ts");
  assert.match(chat, /requestAnimationFrame\(tick\)/);
  assert.doesNotMatch(chat, /setTimeout\(tick, delay\)/);
  assert.match(chat, /appendData\(addition\)/);
  assert.match(chat, /const remaining = 48/);
  assert.match(chat, /private chatScrollFrame: number \| null/);
  assert.match(chat, /private thinkingScrollFrame: number \| null/);
});

test("session persistence backs off and history is paint-contained", () => {
  const session = read("src/components/session.ts");
  const chat = read("src/components/chat.ts");
  const css = read("src/app.css");
  assert.match(session, /SESSION_SAVE_DELAY_MS = 1_500/);
  assert.match(session, /SESSION_SAVE_MAX_BACKOFF_MS = 60_000/);
  assert.match(css, /#chat > \.msg\.history-virtualized/);
  assert.doesNotMatch(css, /#chat > \.msg,\s*\n#chat > \.thinking-wrap/);
  assert.match(chat, /scheduleStableMessageVirtualization/);
  assert.match(chat, /getBoundingClientRect\(\)\.height/);
  assert.match(css, /Hormachuelos Optimized FPS profile/);
});

test("Source Lens uses reduced and frame-throttled hover work", () => {
  const browser = read("src-tauri/src/preview_browser.rs");
  const preview = read("src/components/site-preview.ts");
  assert.doesNotMatch(browser, /visited > 2500/);
  assert.match(browser, /visited > 600/);
  assert.match(browser, /requestAnimationFrame\(processPointerMove\)/);
  assert.match(preview, /const featureChanged = hoveredFeature !== feature/);
  assert.match(preview, /delay = 220/);
});

test("download page targets only the optimized release", () => {
  const page = read("docs/index.html");
  assert.match(page, /Download MSI/);
  assert.match(page, /Download Setup EXE/);
  assert.match(page, /HORMACHUELOS-OPTIMIZED\/releases\/latest\/download/);
  assert.doesNotMatch(page, /HORMACHUELOS\/releases\/latest\/download/);
});
