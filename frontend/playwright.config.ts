import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_FRONTEND_PORT ?? "3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
