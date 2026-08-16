/**
 * Playwright check: serve dist/, open UI, assert the left sandwich control
 * and unified workspace menu are visible, click them, screenshot.
 */
import { createServer } from "http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "test_screenshots");
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveDist(port = 4177) {
  const server = createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const file = join(DIST, urlPath.replace(/^\//, ""));
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found: " + urlPath);
      return;
    }
    const ext = extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port }));
  });
}

const tauriMock = `
(() => {
  const callbacks = new Map();
  const settings = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    base_url: "https://api.deepseek.com",
    max_iterations: 25,
    command_timeout_secs: 120,
    permission_mode: "adaptive",
    capability_mode: "balanced",
    auto_approve: true,
  };
  const invoke = async (cmd) => {
    if (cmd === "list_recent_projects") return [];
    if (cmd === "app_version") return "0.1.5";
    if (cmd === "get_settings") return settings;
    if (cmd === "get_website_session") return "drawer-test-session";
    if (cmd === "has_api_key") return false;
    if (cmd === "get_project_root") return null;
    if (cmd === "list_project_files") return { nodes: [], truncated: false };
    if (cmd === "active_agent_sessions") return [];
    return null;
  };
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback, once = false) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0];
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return callback && callback(data);
      });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, data) {
      const cb = callbacks.get(id);
      if (cb) cb(data);
    },
    convertFileSrc(path) { return path; },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_e, id) { callbacks.delete(id); },
  };
})();
`;

function box(el) {
  return el.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return {
      text: (n.textContent || "").trim().slice(0, 40),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      color: s.color,
      bg: s.backgroundColor,
      z: s.zIndex,
      inDom: document.body.contains(n),
    };
  });
}

async function main() {
  const report = { ok: false, checks: [], errors: [] };
  const { server, port } = await serveDist(4177);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  page.on("pageerror", (e) => report.errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") report.errors.push("console: " + msg.text());
  });

  await page.addInitScript(tauriMock);
  await page.route("https://chmoralla-code.github.io/HORMACHUELOS-OPTIMIZED/latest.json?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "0.1.5",
        forceUpdate: false,
      }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        user: { email: "drawer-test@example.com", plan: "free" },
      }),
    }),
  );

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(800);

    const left = page.locator("#drawer-left-btn");
    const workspaceMenu = page.locator("#workspace-menu-btn");
    const header = page.locator("#header");
    const modeChip = page.locator(".chip-btn.chip-mode");

    const leftCount = await left.count();
    const workspaceMenuCount = await workspaceMenu.count();
    report.checks.push({ name: "left btn in DOM", pass: leftCount === 1, detail: String(leftCount) });
    report.checks.push({ name: "workspace menu in DOM", pass: workspaceMenuCount === 1, detail: String(workspaceMenuCount) });

    const modeChipCount = await modeChip.count();
    report.checks.push({ name: "Adaptive mode chip in DOM", pass: modeChipCount === 1, detail: String(modeChipCount) });
    if (modeChipCount) {
      const initialMode = (await modeChip.locator(".chip-label").textContent() || "").trim();
      report.checks.push({ name: "Adaptive is the default mode", pass: initialMode === "auto", detail: initialMode });
      await modeChip.click();
      const choices = await page.locator('[role="listbox"][aria-label="Permission mode"] .chip-menu-item').allTextContents();
      const normalizedChoices = choices.map((value) => value.replace(/\s+/g, " ").trim());
      report.checks.push({
        name: "all six workflow modes are available",
        pass: normalizedChoices.length === 6 &&
          normalizedChoices.some((value) => value.includes("Adaptive Director")) &&
          normalizedChoices.some((value) => value.startsWith("ask")) &&
          normalizedChoices.some((value) => value.startsWith("research")) &&
          normalizedChoices.some((value) => value.startsWith("plan")) &&
          normalizedChoices.some((value) => value.startsWith("build")) &&
          normalizedChoices.some((value) => value.includes("Multi-Agent")),
        detail: JSON.stringify(normalizedChoices),
      });
      await page.keyboard.press("Escape");

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("horma:run-permission-mode", {
          detail: {
            mode: "research",
            reason: "deep read-only investigation requested",
            complexity: "high",
            risk: "low",
          },
        }));
      });
      await page.waitForTimeout(100);
      const routedMode = (await page.locator(".chip-btn.chip-mode .chip-label").textContent() || "").trim();
      report.checks.push({
        name: "Adaptive exposes its effective per-turn route",
        pass: routedMode === "auto → research",
        detail: routedMode,
      });
    }

    if (leftCount) {
      const b = await box(left);
      report.checks.push({
        name: "left btn visible box",
        pass: b.w > 20 && b.h > 20 && b.opacity !== "0" && b.visibility !== "hidden" && b.display !== "none",
        detail: JSON.stringify(b),
      });
      report.checks.push({
        name: "left btn on screen",
        pass: b.x >= 0 && b.y >= 0 && b.x < 1280,
        detail: `x=${b.x} y=${b.y}`,
      });
    }
    if (workspaceMenuCount) {
      const b = await box(workspaceMenu);
      report.checks.push({
        name: "workspace menu button visible box",
        pass: b.w > 20 && b.h > 20 && b.opacity !== "0" && b.visibility !== "hidden" && b.display !== "none",
        detail: JSON.stringify(b),
      });
    }

    // Header HTML snapshot
    const headerHtml = await header.innerHTML().catch(() => "(missing)");
    report.headerHtml = headerHtml.slice(0, 800);

    await page.screenshot({ path: join(SHOTS, "drawer_initial.png"), fullPage: true });

    if (leftCount) {
      await left.click();
      await page.waitForTimeout(400);
      const closedLeft = await page.locator("#app.left-drawer-closed").count();
      report.checks.push({ name: "left click toggles closed", pass: closedLeft === 1, detail: String(closedLeft) });
      await page.screenshot({ path: join(SHOTS, "drawer_left_closed.png"), fullPage: true });
      await left.click();
      await page.waitForTimeout(400);
    }
    if (workspaceMenuCount) {
      await workspaceMenu.click();
      await page.waitForTimeout(400);
      const openMenu = page.locator("#workspace-menu:not([hidden])");
      const menuCount = await openMenu.count();
      report.checks.push({ name: "workspace menu opens", pass: menuCount === 1, detail: String(menuCount) });
      await page.screenshot({ path: join(SHOTS, "workspace_menu_open.png"), fullPage: true });
      const inspectorAction = page.locator('[data-workspace-action="inspector"]');
      const inspectorActionCount = await inspectorAction.count();
      report.checks.push({ name: "inspector action in menu", pass: inspectorActionCount === 1, detail: String(inspectorActionCount) });
      if (inspectorActionCount) await inspectorAction.click();
      await page.waitForTimeout(400);
      const closedRight = await page.locator("#app.right-drawer-closed").count();
      report.checks.push({ name: "menu inspector action toggles closed", pass: closedRight === 1, detail: String(closedRight) });
      await page.screenshot({ path: join(SHOTS, "drawer_right_closed.png"), fullPage: true });
    }

    report.ok = report.checks.every((c) => c.pass);
  } catch (e) {
    report.errors.push(String(e));
    report.ok = false;
    try {
      await page.screenshot({ path: join(SHOTS, "drawer_error.png"), fullPage: true });
    } catch { /* ignore */ }
  } finally {
    await browser.close();
    server.close();
  }

  const out = join(SHOTS, "drawer_report.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
