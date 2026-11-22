# youtube-agent-ui

Local-only web studio for the separate [`youtube-agent`](https://github.com/levu48/youtube-agent) documentary engine. It lets you create engine projects, generate drafts with your local Ollama model in the background, watch the engine's real output, and read the outline and script. The engine stays the source of truth: the UI only runs its CLI and reads documented artifacts.

**Milestone 1 scope:** a dashboard, project creation, a project workspace (engine stages, next action, draft jobs, live logs, cancel), and a read-only draft viewer.

**Milestone 2 so far:** validate the draft and record editorial approval (G1) in the browser, through the engine's `draft-approve`. Editing the outline and script is not available yet; it needs an engine edit command first (see [milestone-2.md](docs/milestones/milestone-2.md)). Research, visuals, narration, rendering and publishing are not included.

```
Browser ──► Next.js (127.0.0.1:3000) ──/api proxy──► FastAPI (127.0.0.1:8000) ──► uv run --no-sync ytagent …
                                                    │                               (separate youtube-agent repo)
                                                    └─ SQLite + job logs (UI-owned, ~/Library/Application Support/youtube-agent-ui)
```

## Requirements

- macOS (Apple Silicon), [uv](https://docs.astral.sh/uv/) and Node.js 22+ (tested with Node 26).
- A local checkout of `youtube-agent`, with `uv sync` already run in it.
- Optional for drafting: [Ollama](https://ollama.com) with `qwen3:8b` (`ollama pull qwen3:8b`).

## Setup and run

```bash
cp .env.example .env        # set YTA_ENGINE_REPO to your youtube-agent checkout
./scripts/dev.sh            # installs dependencies on first run, starts both servers
open http://127.0.0.1:3000
```

Both servers bind to `127.0.0.1` only. Press Ctrl-C to stop both.

| Setting | Default | Meaning |
|---|---|---|
| `YTA_ENGINE_REPO` | `~/dev/youtube-agent` | Engine checkout. Commands run with this as their working directory. |
| `YTA_PROJECTS_ROOT` | `~/Documents/YouTubeAgent/projects` | Where engine projects are created. Must be outside source repositories. |
| `YTA_DATA_DIR` | `~/Library/Application Support/youtube-agent-ui` | UI SQLite database (`ui.sqlite3`) and job logs (`logs/<job>.log`). |
| `YTA_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama. Only loopback addresses are accepted. |
| `YTA_DEFAULT_MODEL` | `qwen3:8b` | Model preselected in the UI. |
| `YTA_ALLOW_FIXTURE_PROVIDER` | `false` | Shows the offline fixture provider, which writes placeholder text. For tests and demos only. |

Projects created in the UI are ordinary engine projects. You can keep using them from the CLI, and approvals made in either place are the same engine record:

```bash
cd ~/dev/youtube-agent
uv run ytagent production-status --project-root ~/Documents/YouTubeAgent/projects/<slug>
uv run ytagent draft-approve --project-root ~/Documents/YouTubeAgent/projects/<slug> --reviewer "Your name"
```

Existing engine projects that sit directly under `YTA_PROJECTS_ROOT` are listed on the dashboard and can be added to the studio with one click.

## Tests

```bash
# Backend: lint, plus unit tests (fake engine) and integration tests (real engine, fixture provider)
cd backend && uv run ruff check . && uv run ruff format --check . && uv run pytest

# Frontend: lint, types, component tests, production build
cd frontend && npm run lint && npm run typecheck && npm test && npm run build

# End-to-end: builds the frontend and starts an isolated backend on ports 8100/3100 with a
# temp projects folder and an unreachable Ollama.
#   E2E_ENGINE=real  the real engine CLI with its offline fixture provider (default if found)
#   E2E_ENGINE=fake  backend/tests/fake_engine.py, which replays captured engine output and
#                    also runs the browser cancel test (slow jobs)
cd frontend && npx playwright install chromium && E2E_ENGINE=real npm run test:e2e && E2E_ENGINE=fake npm run test:e2e
```

None of the automated tests need Ollama, network access or paid services. If the sibling engine checkout is missing, the real-engine tests are skipped and say why. Set `YTA_REQUIRE_ENGINE=1` to make them fail instead. Set `YTA_TEST_ENGINE_REPO`, or `YTA_ENGINE_REPO` for the E2E tests, to point at the engine elsewhere.

**CI** (`.github/workflows/ci.yml`) has four jobs:
- `backend`: lint and unit tests. The real-engine tests are deselected here.
- `frontend`: lint, types, tests and build.
- `e2e`: Playwright against the fake engine.
- `engine`: the **required** real-engine tests.

**Real-engine tests (required).** The pinned engine revision lives in [`ENGINE_REF`](ENGINE_REF). Both CI and you run the same script:

```bash
scripts/test-real-engine.sh                    # clones ../youtube-agent at ENGINE_REF into a temp dir
ENGINE_DIR=/path/to/checkout scripts/test-real-engine.sh   # or verify an existing checkout
```

The script fails in any of these cases:
- the engine is not at `ENGINE_REF`;
- any backend integration test is skipped, fails or is missing;
- real-engine Playwright fails, or skips anything other than the slow-job cancel test, which the fake-engine job covers.

To bump the pinned engine, update `ENGINE_REF`, run the script locally, and record the result in `docs/engine-compatibility.md`.

**Required GitHub secret.** `levu48/youtube-agent` is private, so the `engine` job checks it out with a repository secret named **`ENGINE_REPO_TOKEN`**. Without the secret the job **fails**, so real-engine tests can never pass without running. To create it:
1. On GitHub, go to *Settings → Developer settings → Fine-grained personal access tokens → Generate new token*.
2. Set *Repository access* to *Only select repositories* and choose `levu48/youtube-agent`.
3. Under *Permissions*, set *Repository → Contents* to *Read-only*. No other permissions are needed.
4. In `levu48/youtube-agent-ui`, go to *Settings → Secrets and variables → Actions → New repository secret* and name it `ENGINE_REPO_TOKEN`. Or run `gh secret set ENGINE_REPO_TOKEN -R levu48/youtube-agent-ui` and paste the token.

The checkout uses `persist-credentials: false`, so the token is not left on the runner. Pull requests from forks don't receive secrets, so the job fails for them by design.

## How it behaves

- **Jobs.** A draft request returns `202` with a job ID. Only one job can be queued or running per project. At most one job runs at a time across the studio; any others wait with the status `queued`. The engine's output lines are stored as numbered events and streamed over SSE. The page resumes with `Last-Event-ID` after a disconnect, and falls back to polling if streaming keeps failing. The UI never shows a progress percentage. With Ollama, the engine logs one line per model request, so you see real progress lines followed by the final summary.
- **Cancel and timeouts.** Cancelling asks for confirmation. The backend signals the engine's whole process group: SIGINT (the engine exits cleanly with code 130), then SIGTERM, then SIGKILL after grace periods. The job shows `cancelled` only once every process in the group has exited, including descendants of the `uv` launcher. Short read-only commands that time out are stopped the same way, so nothing keeps writing after the UI reports the timeout.
- **Restart.** If the backend restarts, any job it was running is marked `interrupted`; success is never assumed. If the engine process is still alive and its identity checks out, it is interrupted. Running a new draft lets the engine recover through its own journal.
- **Approval (G1).** The draft page's **Approve Editorial Draft (G1)** runs `ytagent draft-approve --reviewer=<name>`. The backend refuses it while a job is active, or if the reviewed files changed since you last validated. Afterwards the page shows the engine's own state. Approval is editorial acceptance only: it does not verify claims, rights or release readiness, and it starts nothing. Any later change to the input, outline, script or storyboard makes the approval out of date, and the page says so.
- **Statuses.** Engine stages (for example `Draft · Awaiting review`) and job statuses (`Succeeded`) are shown separately. Exit code 16 is treated as an expected human-review gate, not a crash.

## Security model

- Loopback-only binding. The backend rejects any `Host` that isn't loopback and any `Origin` other than the UI.
- Every state-changing request needs a per-process CSRF token from `/api/v1/session`. CORS is restricted to the UI origin.
- Engine commands are built as argument lists from an allowlist of six operations: `--version`, `create`, `draft`, `production-status`, `draft-check` and `draft-approve`. Every value is passed as a single `--option=value` element, and no shell is ever used. Force, replace and paid options can't be expressed.
- The browser never supplies a filesystem path. Project folders are `<projects root>/<validated slug>` and are re-checked (no symlinks, still inside the root) right before each use. Artifacts are read only under fixed file names, with size limits and UTF-8 checks. Markdown is rendered without raw HTML.
- Diagnostics are redacted (credentials, home directory) and truncated before they are stored or shown.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Engine unavailable" | Check `YTA_ENGINE_REPO` and run `uv sync` once in the engine repository. The UI uses `uv run --no-sync`, so it never changes the engine's virtualenv. |
| "Ollama is not reachable" | Start the Ollama app or run `ollama serve`. Check `YTA_OLLAMA_BASE_URL`. |
| "The model … is not installed" | `ollama pull qwen3:8b` |
| "A folder with this name already exists" | The engine would reuse an empty folder, so the UI refuses it. Choose another slug, or add the existing engine project from the dashboard. |
| A job stays `interrupted` after a restart | Start the draft again. The engine resumes from its cache and journal. |
| `csrf_failed` | Reload the page. The backend issues a new token each time it starts. |

## Documentation

- [docs/architecture.md](docs/architecture.md): architecture and decisions
- [docs/engine-compatibility.md](docs/engine-compatibility.md): verified engine CLI contract (tested commit, JSON shapes, exit codes)
- [docs/api-contract.md](docs/api-contract.md): HTTP API. The OpenAPI document is served at `/api/openapi.json` (interactive docs at `/api/docs`).
- [docs/ui-design.md](docs/ui-design.md): visual and interaction contract
- [docs/milestones/](docs/milestones/): roadmap and Milestone 1 backlog
- [docs/m1-verification.md](docs/m1-verification.md): Milestone 1 test record and known limitations
- [docs/m2-verification.md](docs/m2-verification.md): Milestone 2 test record (validation and G1 approval so far)
