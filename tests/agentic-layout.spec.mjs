import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("test-results/agentic-evidence");

async function openScenario(page, scenario, viewport, options = {}) {
  await page.setViewportSize(viewport);
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/agentic-layout-harness.html?scenario=${scenario}`);
  await expect(page.locator(".agentic-workbench")).toBeVisible();
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  await fs.mkdir(evidence, { recursive: true });
});

test("live three-agent Workbench shows simultaneous desktop lanes and filtering", async ({ page }) => {
  await openScenario(page, "live", { width: 1360, height: 980 });
  await expect(page.getByLabel("AGENTIC execution workbench")).toBeVisible();
  await expect(page.locator(".agentic-lane:visible")).toHaveCount(3);
  await expect(page.locator(".agentic-agent-card")).toHaveCount(4);
  await expect(page.locator(".agentic-tool-card")).toHaveCount(4);
  await page.getByRole("button", { name: "Worker 1", exact: true }).click();
  await expect(page.locator(".agentic-tool-card")).toHaveCount(1);
  await expect(page.locator(".agentic-tool-meta")).toContainText("Worker 1");
  await expect(page.getByRole("document", { name: "AI response" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-desktop-live.png"), fullPage: true });
});

test("narrow Workbench uses accessible tabs and arrow-key navigation", async ({ page }) => {
  await openScenario(page, "live", { width: 820, height: 960 });
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await expect(page.locator(".agentic-lane:visible")).toHaveCount(1);
  const progress = page.getByRole("tab", { name: "Progress" });
  await progress.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Tools" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Tools" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Agents" })).toBeFocused();
  await expect(page.locator(".agentic-lane-agents")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-narrow-live.png"), fullPage: true });
});

test("390px mobile layout has no clipping and keeps phase strip scoped", async ({ page }) => {
  await openScenario(page, "live", { width: 390, height: 844 });
  await expect(page.locator(".agentic-lane:visible")).toHaveCount(1);
  const strip = page.locator(".agentic-phase-strip");
  const dimensions = await strip.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflow: getComputedStyle(node).overflowX,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(["auto", "scroll"]).toContain(dimensions.overflow);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-mobile-live.png"), fullPage: true });
});

for (const scenario of ["simple", "partial", "cancelled", "unverified"]) {
  test(`${scenario} run renders an honest terminal Delivery Board`, async ({ page }) => {
    await openScenario(page, scenario, { width: 1180, height: 980 });
    await expect(page.getByRole("heading", { name: "Delivery Board" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect run" })).toBeVisible();
    await expect(page.locator(".agentic-lanes")).toHaveClass(/is-collapsed/);
    if (scenario === "simple") {
      await expect(page.locator('.agentic-phase[data-phase="multi_agent"]')).toHaveAttribute("data-state", "skipped");
      await expect(page.getByRole("heading", { name: "Changes" })).toHaveCount(0);
    }
    if (scenario === "partial") {
      await expect(page.locator('.agentic-outcome-status')).toContainText("Partial");
      await expect(page.locator('.agentic-verification-item[data-status="failed"]')).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Risks & Next Actions" })).toBeVisible();
    }
    if (scenario === "cancelled") {
      await expect(page.locator(".agentic-outcome-status")).toContainText("Cancelled");
    }
    if (scenario === "unverified") {
      await expect(page.locator('.agentic-verification-item[data-status="not_run"]')).toBeVisible();
      await expect(page.locator(".agentic-outcome-status")).toContainText("Needs Attention");
    }
    await expectNoHorizontalOverflow(page);
  });
}

test("Inspect run restores lanes, collapse restores focus, and reply copy remains available", async ({ page }) => {
  await openScenario(page, "success", { width: 1180, height: 980 });
  const inspect = page.locator(".agentic-inspect-button");
  await inspect.click();
  await expect(page.locator(".agentic-lanes")).not.toHaveClass(/is-collapsed/);
  const tool = page.locator(".agentic-tool-card summary").first();
  await tool.focus();
  await inspect.click();
  await expect(inspect).toBeFocused();
  const copy = page.getByRole("button", { name: "Copy reply" });
  await copy.click();
  await expect(copy).toContainText("Copied");
});

test("reduced-motion preference preserves the complete accessible state", async ({ page }) => {
  await openScenario(page, "success", { width: 820, height: 900 }, { reducedMotion: true });
  await expect(page.getByRole("heading", { name: "Delivery Board" })).toBeVisible();
  const duration = await page.locator(".agentic-workbench").evaluate((node) =>
    getComputedStyle(node).transitionDuration);
  expect(["0s", "0.00001s", "1e-05s"]).toContain(duration);
  await expectNoHorizontalOverflow(page);
});
