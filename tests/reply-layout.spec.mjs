import { test, expect } from "@playwright/test";

const scenarios = [
  { name: "desktop-dark", width: 1440, height: 1000, theme: "dark" },
  { name: "narrow-dark", width: 720, height: 960, theme: "dark" },
  { name: "mobile-light", width: 390, height: 844, theme: "light" },
];

for (const scenario of scenarios) {
  test("AI reply remains clean on " + scenario.name, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto("/reply-layout-harness.html?theme=" + scenario.theme, {
      waitUntil: "networkidle",
    });

    const reply = page.locator(".msg.assistant");
    await expect(reply).toBeVisible();
    await expect(reply.getByRole("document", { name: "AI response" })).toBeVisible();
    await expect(reply.locator("h2")).toHaveCount(2);
    await expect(reply.locator("hr.md-divider")).toHaveCount(1);
    await expect(reply.locator("ol.md-list > li")).toHaveCount(2);
    await expect(reply.locator(".md-list-depth-1")).toHaveCount(2);
    await expect(reply.locator("strong.md-lead")).toHaveCount(2);
    await expect(reply.locator(".md-file")).toHaveCount(3);
    await expect(reply.locator("blockquote.md-callout")).toBeVisible();
    await expect(reply.locator("pre.md-code[data-language='ts']")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const response = document.querySelector(".msg-body.md");
      const section = response.querySelector("h2");
      const strong = response.querySelector("strong");
      const parentItem = response.querySelector("ol.md-list > li");
      const nestedItem = response.querySelector(".md-list-depth-1 > li");
      const file = response.querySelector(".md-file");
      const copy = document.querySelector("[data-reply-action='copy']");
      const sectionStyle = getComputedStyle(section);
      const strongStyle = getComputedStyle(strong);
      const fileStyle = getComputedStyle(file);
      const copyStyle = getComputedStyle(copy);
      const parentRect = parentItem.getBoundingClientRect();
      const nestedRect = nestedItem.getBoundingClientRect();
      const responseRect = response.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        responseRight: responseRect.right,
        sectionWidth: sectionRect.width,
        responseWidth: responseRect.width,
        sectionBorder: parseFloat(sectionStyle.borderTopWidth),
        strongWeight: Number.parseInt(strongStyle.fontWeight, 10),
        nestedIndent: nestedRect.left - parentRect.left,
        fileBorder: parseFloat(fileStyle.borderTopWidth),
        fileBackground: fileStyle.backgroundColor,
        copyDisplay: copyStyle.display,
        copyOpacity: Number.parseFloat(copyStyle.opacity),
      };
    });

    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.responseRight).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.sectionWidth).toBeGreaterThan(metrics.responseWidth * 0.9);
    expect(metrics.sectionBorder).toBeGreaterThanOrEqual(1);
    expect(metrics.strongWeight).toBeGreaterThanOrEqual(600);
    expect(metrics.nestedIndent).toBeGreaterThan(8);
    expect(metrics.fileBorder).toBeGreaterThanOrEqual(1);
    expect(metrics.fileBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(metrics.copyDisplay).toBe("inline-flex");
    expect(metrics.copyOpacity).toBeGreaterThan(0.5);

    const copy = page.getByRole("button", { name: "Copy reply" });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(copy).toContainText("Copied");

    await testInfo.attach(scenario.name + ".png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    const fatal = errors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
    expect(fatal, fatal.join("\n")).toEqual([]);
  });
}
