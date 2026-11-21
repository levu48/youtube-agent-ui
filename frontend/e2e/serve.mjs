// Starts an isolated backend + production frontend for Playwright.
// Real engine CLI with the offline fixture provider; Ollama deliberately unreachable;
// projects/data in a fresh temp directory. No network, no paid services.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "..");
const backend = resolve(frontend, "../backend");
const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? "8100";
const FRONTEND_PORT = process.env.E2E_FRONTEND_PORT ?? "3100";
const tmp = mkdtempSync(join(tmpdir(), "yta-e2e-"));
const engineRepo = process.env.YTA_ENGINE_REPO ?? resolve(frontend, "../../youtube-agent");

const backendEnv = {
  ...process.env,
  YTA_ENGINE_REPO: engineRepo,
  YTA_PROJECTS_ROOT: join(tmp, "projects"),
  YTA_DATA_DIR: join(tmp, "data"),
  YTA_ALLOW_FIXTURE_PROVIDER: "true",
  YTA_OLLAMA_BASE_URL: "http://127.0.0.1:9",
  YTA_UI_ORIGINS: JSON.stringify([`http://127.0.0.1:${FRONTEND_PORT}`, `http://localhost:${FRONTEND_PORT}`]),
};
const feEnv = {
  ...process.env,
  NEXT_DIST_DIR: ".next-e2e",
  YTA_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

console.log(`[e2e] temp dir ${tmp}; engine ${engineRepo}`);
const build = spawnSync("npx", ["next", "build"], { cwd: frontend, env: feEnv, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [
  spawn("uv", ["run", "--frozen", "uvicorn", "--factory", "app.main:factory", "--host", "127.0.0.1", "--port", BACKEND_PORT],
    { cwd: backend, env: backendEnv, stdio: "inherit" }),
  spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", FRONTEND_PORT],
    { cwd: frontend, env: feEnv, stdio: "inherit" }),
];
const stop = () => { for (const c of children) c.kill("SIGINT"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { console.log(`[e2e] server exited ${code}`); stop(); });
