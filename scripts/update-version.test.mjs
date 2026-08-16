import test from "node:test";
import assert from "node:assert/strict";
import { compareAppVersion, isVersionNewer, parseAppVersion } from "../src/update-version.ts";

test("parses three-part versions and numeric revision builds", () => {
  assert.deepEqual(parseAppVersion("v1.0.2"), [1, 0, 2]);
  assert.deepEqual(parseAppVersion("1.2.11-1"), [1, 2, 11, 1]);
  assert.equal(parseAppVersion("1.2.11-beta"), null);
  assert.equal(parseAppVersion("1.2"), null);
});

test("treats revision builds as newer than the same three-part version", () => {
  assert.equal(isVersionNewer("1.2.11-1", "1.2.11"), true);
  assert.equal(isVersionNewer("1.2.11", "1.2.11-1"), false);
  assert.equal(isVersionNewer("1.2.11-1", "1.0.2"), true);
  assert.equal(isVersionNewer("1.2.12", "1.2.11-1"), true);
  assert.equal(isVersionNewer("1.2.11-1", "1.2.11-1"), false);
  assert.equal(isVersionNewer("1.2.12", "1.2.11-beta"), true);
  assert.equal(compareAppVersion("1.2.11-2", "1.2.11-1") > 0, true);
  assert.equal(isVersionNewer("1.3.0", "1.2.16"), true);
  assert.equal(isVersionNewer("1.2.16", "1.3.0"), false);
});
