import test from "node:test";
import assert from "node:assert/strict";
import {
  choosePreviewScrollCandidate,
  previewScrollCanMove,
  previewScrollMoved,
} from "../src/components/preview-scroll-policy.ts";

const candidate = (target, x, y, maxX, maxY) => ({
  target,
  position: { x, y, maxX, maxY },
});

test("nested scroll candidate wins while it can move in the requested direction", () => {
  const nested = candidate("roles-table", 0, 0, 0, 900);
  const page = candidate("page", 0, 65, 0, 65);
  assert.equal(choosePreviewScrollCandidate([nested, page], 0, 520, false)?.target, "roles-table");
  assert.equal(previewScrollCanMove(nested.position, 0, 520), true);
  assert.equal(previewScrollCanMove(page.position, 0, 520), false);
});

test("scroll chains outward when the nested pane is at its boundary", () => {
  const nestedBottom = candidate("roles-table", 0, 900, 0, 900);
  const page = candidate("page", 0, 65, 0, 1200);
  assert.equal(choosePreviewScrollCandidate([nestedBottom, page], 0, 520, false)?.target, "page");

  const nestedTop = candidate("roles-table", 0, 0, 0, 900);
  const pageBelowTop = candidate("page", 0, 65, 0, 1200);
  assert.equal(choosePreviewScrollCandidate([nestedTop, pageBelowTop], 0, -520, false)?.target, "page");
});

test("explicit pane refs stay locked and report boundaries instead of silently retargeting", () => {
  const nestedBottom = candidate("roles-table", 0, 900, 0, 900);
  const page = candidate("page", 0, 65, 0, 1200);
  assert.equal(choosePreviewScrollCandidate([nestedBottom, page], 0, 520, true)?.target, "roles-table");
});

test("horizontal and vertical movement detection is measured from before and after state", () => {
  assert.equal(previewScrollCanMove({ x: 0, y: 0, maxX: 400, maxY: 0 }, 300, 0), true);
  assert.equal(previewScrollCanMove({ x: 400, y: 0, maxX: 400, maxY: 0 }, 300, 0), false);
  assert.equal(previewScrollMoved(
    { x: 0, y: 65, maxX: 0, maxY: 65 },
    { x: 0, y: 65, maxX: 0, maxY: 65 },
  ), false);
  assert.equal(previewScrollMoved(
    { x: 0, y: 0, maxX: 0, maxY: 900 },
    { x: 0, y: 520, maxX: 0, maxY: 900 },
  ), true);
});

test("positive delta is down/right and negative delta is up/left", () => {
  const mid = { x: 200, y: 400, maxX: 500, maxY: 900 };
  assert.equal(previewScrollCanMove(mid, 0, 300), true);
  assert.equal(previewScrollCanMove(mid, 0, -300), true);
  assert.equal(previewScrollCanMove(mid, 300, 0), true);
  assert.equal(previewScrollCanMove(mid, -300, 0), true);
});
