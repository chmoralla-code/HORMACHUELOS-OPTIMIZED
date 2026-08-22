import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  builtinLatestRelease,
  effectiveLatestRelease,
} from "../api/_lib/releases.js";

test("bundled release supersedes an older database release", () => {
  const builtin = builtinLatestRelease();
  const release = effectiveLatestRelease({
    id: "database-v0.1.5",
    version: "0.1.5",
    title: "Hormachuelos 0.1.5",
    whats_new: "Older release",
    msi_url: "https://example.com/old.msi",
    exe_url: "https://example.com/old.exe",
    force_update: false,
    is_latest: true,
    published_at: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(release.version, builtin.version);
  assert.equal(release.msiUrl, builtin.msiUrl);
  assert.match(release.msiUrl, /^https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS\/releases\/download\/v\d+\.\d+\.\d+\/Hormachuelos_\d+\.\d+\.\d+_x64_en-US\.msi$/);
  assert.match(release.exeUrl, /^https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS\/releases\/download\/v\d+\.\d+\.\d+\/Hormachuelos_\d+\.\d+\.\d+_x64-setup\.exe$/);
  assert.match(release.msiSha256, /^[a-f0-9]{64}$/);
  assert.match(release.exeSha256, /^[a-f0-9]{64}$/);
});

test("database releases remain authoritative at the same or newer version", () => {
  const builtin = builtinLatestRelease();
  const release = effectiveLatestRelease({
    id: `database-v${builtin.version}`,
    version: builtin.version,
    title: "Admin release",
    whats_new: "Admin-managed notes",
    msi_url: "https://example.com/admin.msi",
    exe_url: "https://example.com/admin.exe",
    force_update: true,
    is_latest: true,
    published_at: "2026-08-01T15:00:00.000Z",
  });
  assert.equal(release.id, `database-v${builtin.version}`);
  assert.equal(release.msiUrl, "https://example.com/admin.msi");
});

test("bundled release never exposes a credential", () => {
  const release = builtinLatestRelease();
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.equal(release.forceUpdate, false, "feature releases stay optional by default");
  // A SHA-256 checksum is allowed to contain the characters `sk-` in the
  // middle by chance. Detect a real credential-shaped token instead of
  // rejecting a valid installer checksum through a substring collision.
  assert.doesNotMatch(
    JSON.stringify(release),
    /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/,
  );
});

test("download page advertises the independent Optimized release without replacing Standard", () => {
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /const OPTIMIZED_DOWNLOADS = \{/);
  assert.match(app, /version: "1.3.6"/);
  assert.match(app, /HORMACHUELOS-OPTIMIZED\/releases\/download\/v1.3.6/);
  assert.match(app, /Hormachuelos_Optimized_1.3.6_x64-setup\.exe/);
  assert.match(app, /Hormachuelos_Optimized_1.3.6_x64\.msi/);
  assert.match(app, /Mission Control/);
  assert.match(app, /Time Machine/);
  assert.match(app, /Standard edition/);
  assert.match(app, /fetch\("\/api\/update"\)/);
});
