import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./website/tests",
  testMatch: "optimized-release.spec.js",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/optimized-website",
  webServer: {
    command: "npx --yes serve@14.2.4 website -l 5174",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    headless: true,
    actionTimeout: 12_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
