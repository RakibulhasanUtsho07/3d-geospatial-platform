import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.MAP_E2E_BASE_URL ?? "http://127.0.0.1:3000",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: [
        "--use-gl=swiftshader",
        "--enable-unsafe-swiftshader",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  },
});
