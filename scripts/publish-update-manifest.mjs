#!/usr/bin/env node
/**
 * Write docs/latest.json (and refresh the GitHub Pages download links) so
 * installed Hormachuelos Optimized copies can see a newly published release.
 *
 * Usage:
 *   node scripts/publish-update-manifest.mjs
 *   node scripts/publish-update-manifest.mjs --push-pages
 *   node scripts/publish-update-manifest.mjs --from-release v1.2.11-1 --push-pages
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "chmoralla-code/HORMACHUELOS-OPTIMIZED";
const PAGES_BRANCH = "main";
const MANIFEST_PATH = "docs/latest.json";
const DOWNLOAD_PAGE_PATH = "docs/index.html";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findInstaller(kind) {
  const roots = [
    join(ROOT, "src-tauri", "target", "release", "bundle", kind),
    join(ROOT, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle", kind),
  ];
  const match = kind === "nsis" ? /-setup\.exe$/i : /\.msi$/i;
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((name) => match.test(name));
    if (hit) return join(dir, hit);
  }
  return "";
}

function githubToken() {
  return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
}

function githubHeaders(required = false) {
  const token = githubToken();
  if (required && !token) die("GITHUB_TOKEN is required to publish GitHub Pages files.");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hormachuelos-optimized-update-manifest",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function shaFromAsset(asset) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest || "").trim());
  return match ? match[1].toLowerCase() : "";
}

async function githubJson(pathname, init = {}) {
  const response = await fetch(`https://api.github.com/${pathname}`, {
    ...init,
    headers: {
      ...githubHeaders(),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(data.message || `GitHub API ${response.status} for ${pathname}`);
  }
  return data;
}

async function downloadReleaseAsset(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) die(`Could not download ${url} (${response.status}).`);
  writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
}

function installerUrls(version) {
  const tag = `v${version}`;
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  return {
    exeUrl: `${base}/Hormachuelos_Optimized_${version}_x64-setup.exe`,
    msiUrl: `${base}/Hormachuelos_Optimized_${version}_x64.msi`,
  };
}

function buildManifest({ version, notes, exeSha256, msiSha256, publishedAt }) {
  const urls = installerUrls(version);
  return {
    version,
    title: `Hormachuelos Optimized v${version}`,
    whatsNew: notes,
    msiUrl: urls.msiUrl,
    exeUrl: urls.exeUrl,
    msiSha256,
    exeSha256,
    forceUpdate: false,
    publishedAt,
  };
}

function patchDownloadPage(html, version) {
  const urls = installerUrls(version);
  let next = html.replace(
    /https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS-OPTIMIZED\/releases\/download\/v[^"/]+\/Hormachuelos_Optimized_[^"]+_x64-setup\.exe/g,
    urls.exeUrl,
  );
  next = next.replace(
    /https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS-OPTIMIZED\/releases\/download\/v[^"/]+\/Hormachuelos_Optimized_[^"]+_x64\.msi/g,
    urls.msiUrl,
  );
  next = next.replace(
    /https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS-OPTIMIZED\/releases\/latest\/download\/Hormachuelos_Optimized_[^"]+_x64-setup\.exe/g,
    `https://github.com/${REPO}/releases/tag/v${version}`,
  );
  next = next.replace(
    /OPTIMIZED BUILD \/\/ [0-9A-Za-z.+-]+(?: BETA)?/,
    `OPTIMIZED BUILD // ${version}`,
  );
  next = next.replace(/BETA CHANNEL[^<]*/i, `RELEASE CHANNEL · ASK MAX · PREVIEW OFF / AUTO / ON · DESKTOP MODE OPT-IN · CTRL+ALT+ESC EMERGENCY STOP · LIVE v${version}`);
  next = next.replace(/RELEASE CHANNEL[^<]*/i, `RELEASE CHANNEL · ASK MAX · PREVIEW OFF / AUTO / ON · DESKTOP MODE OPT-IN · CTRL+ALT+ESC EMERGENCY STOP · LIVE v${version}`);
  next = next.replace(/WINDOWS 10\/11 · X64 · [^<]+/, `WINDOWS 10/11 · X64 · v${version} · INDEPENDENT INSTALL ID`);
  next = next.replace(/Stable v[\d.]+(?:-[0-9A-Za-z.-]+)? \+ Desktop mode Beta v[\d.]+(?:-[0-9A-Za-z.-]+)?/, `Live desktop release v${version}`);
  next = next.replace(/Live desktop release v[\d.]+(?:-[0-9A-Za-z.-]+)?/, `Live desktop release v${version}`);
  next = next.replace(
    /https:\/\/github\.com\/chmoralla-code\/HORMACHUELOS-OPTIMIZED\/releases\/tag\/v[^"]+/g,
    `https://github.com/${REPO}/releases/tag/v${version}`,
  );
  next = next.replace(/>Beta release notes</, ">Release notes<");
  next = next.replace(/>Download Setup EXE Beta</, ">Download Setup EXE<");
  next = next.replace(/>Download MSI Beta</, ">Download MSI<");
  next = next.replace(/>Stable v[\d.]+(?:-[0-9A-Za-z.-]+)?</, ">Release notes<");
  next = next.replace(/>Current v[\d.]+(?:-[0-9A-Za-z.-]+)?</, ">Release notes<");
  return next;
}

async function putPagesFile(path, content, message) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let sha = "";
  try {
    const current = await githubJson(`repos/${REPO}/contents/${encodedPath}?ref=${PAGES_BRANCH}`);
    sha = current.sha || "";
  } catch (error) {
    if (!String(error.message || error).includes("Not Found")) throw error;
  }
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: PAGES_BRANCH,
  };
  if (sha) body.sha = sha;
  await githubJson(`repos/${REPO}/contents/${encodedPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...githubHeaders(true) },
    body: JSON.stringify(body),
  });
}

async function hashFromRelease(version) {
  const tag = `v${version}`;
  const release = await githubJson(`repos/${REPO}/releases/tags/${tag}`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const exe = assets.find((asset) => /x64-setup\.exe$/i.test(asset.name || ""));
  const msi = assets.find((asset) => /x64\.msi$/i.test(asset.name || ""));
  if (!exe || !msi) die(`Release ${tag} is missing the Windows installers.`);
  const publishedAt = release.published_at || new Date().toISOString();
  const exeSha256 = shaFromAsset(exe);
  const msiSha256 = shaFromAsset(msi);
  if (exeSha256 && msiSha256) {
    return { exeSha256, msiSha256, publishedAt };
  }
  const exeUrl = exe.browser_download_url || "";
  const msiUrl = msi.browser_download_url || "";
  if (!exeUrl || !msiUrl) die(`Release ${tag} is missing installer download URLs.`);
  const tmp = join(ROOT, "tmp-update-manifest");
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(tmp, { recursive: true });
  const exePath = join(tmp, exe.name);
  const msiPath = join(tmp, msi.name);
  try {
    await downloadReleaseAsset(exeUrl, exePath);
    await downloadReleaseAsset(msiUrl, msiPath);
    return {
      exeSha256: sha256File(exePath),
      msiSha256: sha256File(msiPath),
      publishedAt,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = argValue("--version") || String(pkg.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    die(`Refusing to publish an invalid version: ${version}`);
  }
  const notes = argValue("--notes")
    || process.env.UPDATE_WHATS_NEW
    || `Hormachuelos Optimized ${version} is ready to install from the in-app Update button.`;
  const fromRelease = argValue("--from-release").replace(/^v/i, "");
  let exeSha256 = "";
  let msiSha256 = "";
  let publishedAt = new Date().toISOString();

  if (fromRelease || hasFlag("--from-release")) {
    const hashed = await hashFromRelease(fromRelease || version);
    exeSha256 = hashed.exeSha256;
    msiSha256 = hashed.msiSha256;
    publishedAt = hashed.publishedAt;
  } else {
    const exePath = argValue("--exe") || findInstaller("nsis");
    const msiPath = argValue("--msi") || findInstaller("msi");
    if (!exePath || !existsSync(exePath) || !msiPath || !existsSync(msiPath)) {
      const hashed = await hashFromRelease(version);
      exeSha256 = hashed.exeSha256;
      msiSha256 = hashed.msiSha256;
      publishedAt = hashed.publishedAt;
    } else {
      exeSha256 = sha256File(exePath);
      msiSha256 = sha256File(msiPath);
    }
  }

  const manifest = buildManifest({ version, notes, exeSha256, msiSha256, publishedAt });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(ROOT, MANIFEST_PATH), manifestJson);
  const pagePath = join(ROOT, DOWNLOAD_PAGE_PATH);
  if (existsSync(pagePath)) {
    writeFileSync(pagePath, patchDownloadPage(readFileSync(pagePath, "utf8"), version));
  }
  console.log(`Wrote ${MANIFEST_PATH} for v${version}`);

  if (hasFlag("--push-pages")) {
    const message = `Publish Hormachuelos Optimized v${version} update manifest`;
    await putPagesFile(MANIFEST_PATH, manifestJson, message);
    if (existsSync(pagePath)) {
      await putPagesFile(DOWNLOAD_PAGE_PATH, readFileSync(pagePath, "utf8"), message);
    }
    console.log(`Updated GitHub Pages on ${PAGES_BRANCH} (${MANIFEST_PATH})`);
  }
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
