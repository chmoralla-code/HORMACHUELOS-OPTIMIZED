import { test, expect } from "@playwright/test";

const VERSION = "1.3.0";
const RELEASE_BASE =
  `https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v${VERSION}`;
const BASE_URL = process.env.HORMACHUELOS_WEBSITE_TEST_URL || "http://127.0.0.1:5174";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Optimized ${VERSION} release card is clean on ${viewport.name}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/api/update", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updateAvailable: false, latest: null }),
      }),
    );

    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/#/download`);
    await page.waitForLoadState("networkidle");

    const card = page.locator("#optimized-download");
    await expect(card).toBeVisible();
    await expect(card.locator("h3")).toHaveText(`Hormachuelos Optimized v${VERSION}`);
    await expect(card.locator("li")).toHaveCount(5);
    await expect(card).toContainText("AGENTIC Director");
    await expect(card).toContainText("Real read-only workers");
    await expect(card).toContainText("Execution Workbench");
    await expect(card).toContainText("Evidence-backed Delivery Board");
    await expect(card).toContainText("Clearline answers and safety");

    await expect(page.locator("#optimized-exe")).toHaveAttribute(
      "href",
      `${RELEASE_BASE}/Hormachuelos_Optimized_${VERSION}_x64-setup.exe`,
    );
    await expect(page.locator("#optimized-msi")).toHaveAttribute(
      "href",
      `${RELEASE_BASE}/Hormachuelos_Optimized_${VERSION}_x64.msi`,
    );

    const metrics = await page.evaluate(() => {
      const cardRect = document.querySelector("#optimized-download").getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
      };
    });
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.cardLeft).toBeGreaterThanOrEqual(-1);
    expect(metrics.cardRight).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(errors).toEqual([]);
  });
}
