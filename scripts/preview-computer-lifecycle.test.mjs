import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sitePreview = read("src/components/site-preview.ts");
const main = read("src/main.ts");
const frame = read("src/components/preview-computer-use.ts");
const nativeBrowser = read("src-tauri/src/preview_browser.rs");
const workspaceCss = read("src/theme/workspace.css");

test("Preview shell exposes Computer Use activity only while the controller run is live", () => {
  assert.match(sitePreview, /setComputerUseActive\(true\)/);
  assert.match(sitePreview, /classList\.toggle\("is-computer-use-active", active\)/);
  assert.match(sitePreview, /setAttribute\("aria-busy", String\(active\)\)/);
  assert.match(sitePreview, /stopComputerUse\(\): void \{[\s\S]*setComputerUseActive\(false\)/);
  assert.match(sitePreview, /runComputerUseTabAction[\s\S]*stopComputerUseControllers\(\)/);
});

test("every terminal host path removes Preview Computer Use visuals immediately", () => {
  assert.match(main, /finally \{[\s\S]*activeSessionId === sessionId\) sitePreview\.stopComputerUse\(\)/);
  assert.match(main, /else if \(isTerminalAgentEvent\(e\)\) \{[\s\S]*sitePreview\.stopComputerUse\(\)/);
  assert.match(main, /onStop: \(\) => \{\s*sitePreview\.stopComputerUse\(\)/);
  assert.match(main, /catch \(error\) \{\s*sitePreview\.stopComputerUse\(\);[\s\S]*respondPreviewComputer/);
  assert.match(main, /onPreviewComputerStop\(\(\) => sitePreview\.stopComputerUse\(\)\)/);
});

test("both page engines destroy their overlays on errors and explicit stop", () => {
  assert.match(frame, /catch \(error\) \{[\s\S]*this\.destroyOverlay\(\);[\s\S]*throw error/);
  assert.match(frame, /stop\(\): void \{[\s\S]*this\.destroyOverlay\(\)/);
  assert.match(nativeBrowser, /async actions\(args\)\{try\{/);
  assert.match(nativeBrowser, /catch\(error\)\{destroyFx\(\);throw error\}/);
  assert.match(nativeBrowser, /stop\(\)\{generation\+\+;destroyFx\(\)/);
});

test("active perimeter is monochrome, bounded, background-aware, and accessible", () => {
  const activeRule = workspaceCss.match(/\.site-preview\.is-computer-use-active\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(activeRule, /border-color: transparent/);
  assert.doesNotMatch(activeRule, /(?:backdrop-)?filter\s*:/);
  assert.match(workspaceCss, /site-preview-computer-glow/);
  assert.match(workspaceCss, /site-preview-computer-shade/);
  assert.match(workspaceCss, /5\.2s ease-in-out infinite/);
  assert.match(workspaceCss, /linear-gradient\(to right, #000/);
  assert.match(workspaceCss, /inset 0 0 0 2px #fff/);
  assert.match(workspaceCss, /site-preview-frame-host::before/);
  assert.match(workspaceCss, /:root\.app-backgrounded \.site-preview\.is-computer-use-active[\s\S]*animation-play-state: paused/);
  assert.match(workspaceCss, /prefers-reduced-motion: reduce[\s\S]*\.site-preview\.is-computer-use-active[\s\S]*animation: none/);
  assert.match(workspaceCss, /border: 2px solid transparent/);
});