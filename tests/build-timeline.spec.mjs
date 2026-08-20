import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("test-results/build-timeline-evidence");

async function openScenario(page, scenario, viewport, options = {}) {
  await page.setViewportSize(viewport);
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/build-timeline-harness.html?scenario=${scenario}`);
  await expect(page.getByLabel("Build timeline preview")).toBeVisible();
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

function activityOrder(page) {
  return page.evaluate(() => {
    const chat = document.getElementById("chat");
    return [...chat.children]
      .filter((node) =>
        node.classList.contains("thinking-wrap")
        || node.classList.contains("tool-batch-wrap")
        || node.classList.contains("done-card")
        || (node.classList.contains("msg") && node.classList.contains("assistant"))
      )
      .map((node) => {
        if (node.classList.contains("is-build-summary")) return "summary";
        if (node.classList.contains("thinking-wrap")) return "thought";
        if (node.classList.contains("tool-batch-wrap")) return "tools";
        if (node.classList.contains("done-card")) return "delivery";
        return "answer";
      });
  });
}

test.beforeAll(async () => {
  await fs.mkdir(evidence, { recursive: true });
});

test("two Build rounds keep Thought, tools, Thought, tools, Summary, delivery", async ({ page }) => {
  await openScenario(page, "live", { width: 1180, height: 980 });
  await expect(page.locator("#chat")).toHaveClass(/chat-build-timeline/);
  await expect(page.locator(".thinking-wrap.is-build-progress")).toHaveCount(3);
  await expect(page.locator(".thinking-wrap.is-build-summary")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Ran 1 command|Ran 1 step|Done 1 step/ }).first()).toBeVisible();
  expect(await activityOrder(page)).toEqual([
    "thought",
    "tools",
    "thought",
    "tools",
    "answer",
    "summary",
    "delivery",
  ]);
  const summary = page.locator(".thinking-wrap.is-build-summary .thinking-simple-label");
  await expect(summary).toHaveText("Summary");
  const primary = page.locator("[data-summary-primary]");
  if (await primary.count()) {
    await expect(primary).not.toHaveText(/Updated the dashboard heading and verified the layout/i);
  }
  const streams = await page.locator(".thinking-stream").allTextContents();
  expect(streams.join("\n")).not.toMatch(/private chain/i);
  await expectNoHorizontalOverflow(page);
  await page.locator(".thinking-wrap.is-build-progress").first().locator(".thinking-toggle-row").focus();
  await page.keyboard.press("Enter");
  await page.screenshot({ path: path.join(evidence, "build-timeline-live.png"), fullPage: true });
});

test("Adaptive routed to Build uses the same timeline", async ({ page }) => {
  await openScenario(page, "adaptive", { width: 1180, height: 980 });
  expect(await activityOrder(page)).toEqual([
    "thought",
    "tools",
    "thought",
    "tools",
    "answer",
    "summary",
    "delivery",
  ]);
});

test("Plan Apply switches into the Build timeline", async ({ page }) => {
  await openScenario(page, "apply", { width: 1180, height: 980 });
  await expect(page.locator("#chat")).toHaveClass(/chat-build-timeline/);
  await expect(page.getByText("Implementing the confirmed plan.").first()).toBeVisible();
  await expect(page.locator(".thinking-wrap.is-build-summary")).toHaveCount(1);
  await expect(page.locator(".done-card")).toBeVisible();
});

test("restored Build sessions keep separate tool batches", async ({ page }) => {
  await openScenario(page, "restore", { width: 1180, height: 980 });
  expect(await activityOrder(page)).toEqual([
    "thought",
    "tools",
    "thought",
    "tools",
    "answer",
    "summary",
    "delivery",
  ]);
  await expect(page.locator(".tool-batch-wrap")).toHaveCount(2);
});

test("cancelled Build runs end with an honest summary", async ({ page }) => {
  await openScenario(page, "cancelled", { width: 1180, height: 980 });
  await expect(page.locator(".thinking-wrap.is-build-summary .thinking-stream")).toContainText("Run cancelled.");
});

test("failed Build tools end with an honest summary", async ({ page }) => {
  await openScenario(page, "failed", { width: 1180, height: 980 });
  await expect(page.locator(".thinking-wrap.is-build-summary .thinking-stream")).toContainText("Some checks need attention.");
  await expect(page.locator(".tool-card.err")).toHaveCount(1);
});

test("390px Build timeline stays readable without horizontal overflow", async ({ page }) => {
  await openScenario(page, "live", { width: 390, height: 844 });
  await expect(page.locator(".thinking-wrap.is-build-summary")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(evidence, "build-timeline-mobile.png"), fullPage: true });
});

test("reduced motion keeps Build thought rows visible without spawn animation", async ({ page }) => {
  await openScenario(page, "live", { width: 820, height: 960 }, { reducedMotion: true });
  const duration = await page.locator(".thinking-wrap.is-build-progress").first().evaluate((node) => {
    return Number.parseFloat(getComputedStyle(node).animationDuration || "0");
  });
  expect(duration).toBeLessThan(0.05);
  await expect(page.getByText("Inspecting package scripts.").first()).toBeVisible();
});
