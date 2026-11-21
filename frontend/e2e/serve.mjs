// Starts an isolated backend + production frontend for Playwright.
// E2E_ENGINE=real: the youtube-agent CLI with its offline fixture provider (needs the engine
//   checkout with a .venv next to this repo, or YTA_ENGINE_REPO).
// E2E_ENGINE=fake: backend/tests/fake_engine.py, which replays output captured from the real
//   engine; used in CI when the private engine repo is unavailable, and for slow-job tests.
// Default: real if the engine checkout exists, otherwise fake.
// Ollama is deliberately unreachable; projects/data live in a fresh temp directory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
const engineMode =
  process.env.E2E_ENGINE ?? (existsSync(join(engineRepo, ".venv")) ? "real" : "fake");
if (!["real", "fake"].includes(engineMode)) throw new Error(`E2E_ENGINE must be real or fake`);

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

console.log(`[e2e] temp dir ${tmp}; engine mode ${engineMode} (${engineRepo})`);
const appFactory = engineMode === "real" ? "app.main:factory" : "tests.e2e_app:factory";
const build = spawnSync("npx", ["next", "build"], { cwd: frontend, env: feEnv, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [
  spawn("uv", ["run", "--frozen", "uvicorn", "--factory", appFactory, "--host", "127.0.0.1", "--port", BACKEND_PORT],
    { cwd: backend, env: backendEnv, stdio: "inherit" }),
  spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", FRONTEND_PORT],
    { cwd: frontend, env: feEnv, stdio: "inherit" }),
];
const stop = () => { for (const c of children) c.kill("SIGINT"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { console.log(`[e2e] server exited ${code}`); stop(); });
