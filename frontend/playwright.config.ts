import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// One temp dir per run, shared by e2e/serve.mjs (projects + data) and the tests, which use it
// to simulate a change made outside the UI. Workers inherit it, so it is created only once.
process.env.E2E_TMP ??= mkdtempSync(join(tmpdir(), "yta-e2e-"));

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
