import { test, expect } from "@playwright/test";

async function openComposer(page, query = "") {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(`/agentic-mode-harness.html${query}`);
  await expect(page.getByRole("toolbar", { name: "Chat controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mode: Ask" })).toBeVisible();
}

async function selectAgentic(page) {
  await page.getByRole("button", { name: "Mode: Ask" }).click();
  const option = page.getByRole("option", { name: /AGENTIC Workbench/i });
  await option.waitFor();
  await option.evaluate((node) => node.click());
}

test("selecting AGENTIC from the composer persists agentic and shows no save error", async ({ page }) => {
  await openComposer(page);
  await selectAgentic(page);

  const modeChip = page.locator(".chip-mode");
  await expect(modeChip).toHaveClass(/chip-mode-agentic/);
  await expect(page.getByRole("button", { name: "Mode: AGENTIC" })).toBeVisible();

  const saved = await page.evaluate(() => window.__savedSettings);
  expect(saved?.permission_mode).toBe("agentic");
  expect(saved?.capability_mode).toBe("orchestrated");

  const status = page.locator(".mode-status");
  await expect(status).not.toHaveClass(/error/);
  await expect(status).not.toContainText("Could not save mode");
});

test("a failed AGENTIC save restores the previous mode and capability and shows the backend reason", async ({ page }) => {
  await openComposer(page, "?fail=1");
  await selectAgentic(page);

  await expect(page.getByRole("button", { name: "Mode: Ask" })).toBeVisible();
  await expect(page.locator(".chip-mode")).not.toHaveClass(/chip-mode-agentic/);

  const restored = await page.evaluate(() => window.__agenticModeHarness.getSaved());
  expect(restored.permission_mode).toBe("ask");
  expect(restored.capability_mode).toBe("answer_max");

  const status = page.locator(".mode-status.error");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Could not save mode");
  await expect(status).toContainText("Permission mode must be");
});
