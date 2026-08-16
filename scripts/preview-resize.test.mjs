import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PREVIEW_RESIZE_GUTTER,
  previewBrowserBoundsFromRect,
} from "../src/components/preview-resize.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("native Preview Browser stays off the resize sash", () => {
  const side = previewBrowserBoundsFromRect({ left: 800, top: 90, width: 500, height: 700 }, false);
  assert.deepEqual(side, {
    x: 800 + PREVIEW_RESIZE_GUTTER,
    y: 90,
    width: 500 - PREVIEW_RESIZE_GUTTER,
    height: 700,
  });

  const stacked = previewBrowserBoundsFromRect({ left: 20, top: 400, width: 900, height: 320 }, true);
  assert.deepEqual(stacked, {
    x: 20,
    y: 400 + PREVIEW_RESIZE_GUTTER,
    width: 900,
    height: 320 - PREVIEW_RESIZE_GUTTER,
  });

  assert.equal(previewBrowserBoundsFromRect({ left: -1, top: 0, width: 400, height: 400 }, false), null);
});

test("preview drag hides the native browser and disables the column transition", () => {
  const preview = read("src/components/site-preview.ts");
  const css = read("src/theme/workspace.css");
  assert.match(preview, /this\.syncBrowserSurfaces\(false\)/);
  assert.match(preview, /handle\.setPointerCapture/);
  assert.match(preview, /addEventListener\("pointermove", onMove, true\)/);
  assert.match(css, /#app \.workbench\.preview-open\.is-resizing/);
  assert.match(css, /\.site-preview-resize \{[\s\S]*width: 12px;/);
});
