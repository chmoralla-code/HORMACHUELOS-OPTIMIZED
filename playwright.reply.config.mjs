import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "reply-layout.spec.mjs",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/reply-layout-report.json" }]],
  outputDir: "test-results/reply-layout",
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 1420",
    url: "http://127.0.0.1:1420/reply-layout-harness.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:1420",
    browserName: "chromium",
    headless: true,
    actionTimeout: 12_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
