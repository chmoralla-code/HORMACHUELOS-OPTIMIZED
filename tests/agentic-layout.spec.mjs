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

test("live run renders one linear thought and tool feed", async ({ page }) => {
  await openScenario(page, "live", { width: 1360, height: 980 });
  await expect(page.getByLabel("AGENTIC execution workbench")).toBeVisible();
  const feed = page.locator(".agentic-feed");
  await expect(feed).toBeVisible();
  await expect(page.locator(".agentic-thought")).toHaveCount(2);
  await expect(page.locator(".agentic-agent-line")).toHaveCount(4);
  await expect(page.locator(".agentic-tool-card")).toHaveCount(4);
  await expect(page.getByRole("document", { name: "AI response" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-desktop-live.png"), fullPage: true });
  // Strict THOUGHT → TOOL → THOUGHT ordering: the closing thought follows the tools.
  const order = await feed.evaluate((node) =>
    [...node.children].map((child) => child.className.split(" ")[0]));
  expect(order.lastIndexOf("agentic-thought")).toBeGreaterThan(order.lastIndexOf("agentic-tool-card"));
  expect(order.indexOf("agentic-tool-card")).toBeGreaterThan(order.indexOf("agentic-agent-line"));
  const card = page.locator(".agentic-tool-card").first();
  await card.locator("summary").click();
  await expect(card.locator(".agentic-tool-meta")).toContainText("Worker 1");
});

test("narrow viewport keeps the feed single-column", async ({ page }) => {
  await openScenario(page, "live", { width: 820, height: 960 });
  const feed = page.locator(".agentic-feed");
  await expect(feed).toBeVisible();
  const dimensions = await feed.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-narrow-live.png"), fullPage: true });
});

test("390px mobile layout has no clipping and the feed stays readable", async ({ page }) => {
  await openScenario(page, "live", { width: 390, height: 844 });
  const feed = page.locator(".agentic-feed");
  const dimensions = await feed.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "agentic-mobile-live.png"), fullPage: true });
});

for (const scenario of ["simple", "partial", "cancelled", "unverified"]) {
  test(`${scenario} run renders an honest terminal SUMMARY`, async ({ page }) => {
    await openScenario(page, scenario, { width: 1180, height: 980 });
    await expect(page.getByRole("heading", { name: "SUMMARY" })).toBeVisible();
    if (scenario === "simple") {
      await expect(page.getByRole("heading", { name: "Changes" })).toHaveCount(0);
    }
    if (scenario === "partial") {
      await expect(page.locator(".agentic-outcome-status")).toContainText("Partial");
      await expect(page.locator('.agentic-verification-item[data-status="failed"]')).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Risks & Next Actions" })).toBeVisible();
    }
    if (scenario === "cancelled") {
      await expect(page.locator(".agentic-outcome-status")).toContainText("Cancelled");
      await page.screenshot({ path: path.join(evidence, "agentic-desktop-cancelled.png"), fullPage: true });
    }
    if (scenario !== "simple") {
      await expect(page.locator(".agentic-tool-card:visible")).toHaveCount(4);
    }
    if (scenario === "unverified") {
      await expect(page.locator('.agentic-verification-item[data-status="not_run"]')).toBeVisible();
      await expect(page.locator(".agentic-outcome-status")).toContainText("Needs Attention");
    }
    await expectNoHorizontalOverflow(page);
  });
}

test("SUMMARY closes the feed and reply copy remains available", async ({ page }) => {
  await openScenario(page, "success", { width: 1180, height: 980 });
  const feed = page.locator(".agentic-feed");
  await expect(page.getByRole("heading", { name: "SUMMARY" })).toBeVisible();
  const order = await page.evaluate(() => {
    const board = document.querySelector(".agentic-delivery-board");
    const feed = document.querySelector(".agentic-feed");
    return board && feed ? feed.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  expect(order).toBeTruthy();
  await expect(feed).toBeVisible();
  const copy = page.getByRole("button", { name: "Copy reply" });
  await copy.click();
  await expect(copy).toContainText("Copied");
});

test("reduced-motion preference preserves the complete accessible state", async ({ page }) => {
  await openScenario(page, "success", { width: 820, height: 900 }, { reducedMotion: true });
  await expect(page.getByRole("heading", { name: "SUMMARY" })).toBeVisible();
  const duration = await page.locator(".agentic-workbench").evaluate((node) =>
    getComputedStyle(node).transitionDuration);
  expect(["0s", "0.00001s", "1e-05s"]).toContain(duration);
  await expectNoHorizontalOverflow(page);
});
