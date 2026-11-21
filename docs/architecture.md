# Architecture v0.1 — youtube-agent-ui

**Status:** proposed implementation design. **Deployment:** single-user local Mac (Apple Silicon). **Repositories:** independent `youtube-agent-ui` UI and `youtube-agent` engine.

## Goals
- Friendly browser UX for engine project creation, drafting and status in M1; future research, visuals, narration and production screens.
- Preserve engine checkpoints, cache, journal recovery, locks, approval gates, rights checks and CLI usability.
- Reliable long-running jobs with observable logs and safe recovery.

## M1 non-goals
Script editing, editorial approvals, research linking, visual selection, TTS, video rendering, upload/publishing, multiuser, cloud deployment, remote access, paid generation.

## Components and trust boundaries
```
Browser (Next.js/React/TypeScript; 127.0.0.1:3000)
    | HTTP JSON / SSE
FastAPI (Python 3.12+; 127.0.0.1:8000)
    |-- Project service: safe project roots and registration
    |-- Engine adapter: allowlisted argv, JSON parsing, exit classification
    |-- Job manager: subprocess groups, SQLite, logs, cancellation, SSE
    |-- Read-only artifact service: outline/script and status
    |-- SQLite: UI project metadata, job records, event log
    |
    +-- subprocess cwd=<engine repo>: uv run ytagent <approved args>
             |
             +-- youtube-agent (separate repo): Ollama, engine files, locks
```

### Ownership
- **Engine-owned:** `input.json`, `outline.json`, `outline.md`, `script.json`, `script.md`, `storyboard.draft.json`, `state.json`, approvals, caches, media, project logs and journals. Only engine CLI writes these.
- **UI-owned:** project registry, job records, event history, UI configuration and UI logs in application-support directory. Do not duplicate authoritative engine stage state.
- **Project directories:** `${YTA_PROJECTS_ROOT}/<validated-slug>` outside source repos.

## Stack
- Frontend: Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, accessible semantic controls; typed API client.
- Backend: FastAPI, Pydantic v2, Python 3.12+, `uv`, SQLite with migrations (Alembic or explicit versioned SQL), pytest and Ruff.
- Job execution: `asyncio.create_subprocess_exec`, separate process group, durable log files and job events; one mutating job per project and global concurrency default 1.
- Updates: SSE for status/logs, with persisted monotonic event IDs and polling fallback. No invented percentages.

## User journey
1. Open dashboard, inspect engine and Ollama availability.
2. Create project with slug, idea, language (`vi`/`en`), duration (60–3600 seconds), audience, tone, guidance. Backend runs `ytagent create --draft-provider none` and registers project only after success.
3. Start `ytagent draft --provider ollama --model ...` as asynchronous job; UI receives 202 and job ID.
4. Observe real logs and state. On completion, refresh `production-status --json` and `draft-check --json`.
5. View outline and script read-only; show engine next action and approval gate, not UI-invented state.

## Operational details
- Configured absolute engine repo and project root paths; validate on startup.
- Use `uv` from configured absolute path or securely resolved PATH, with `cwd=YTA_ENGINE_REPO`; environment allowlist and no shell.
- Canonicalize project root and reject traversal, symlinks escaping root, invalid slugs, and unmanaged paths. Avoid TOCTOU by validating immediately before operations.
- On create, handle pre-existing directories without overwriting; prevent duplicate registration and races.
- SQLite transactions for state transitions and concurrency locks. Use WAL and busy timeout. Only one backend worker/process in M1, or enforce cross-process locking if supporting more.
- Persist queued job before spawn, running PID/process group after spawn, logs/events continuously. On backend restart reconcile jobs; don't infer success from dead PID. Interrupted jobs may be retried through engine's supported recovery path.
- Cancel by signaling only the tracked process group, grace period, then forced termination. Avoid PID reuse hazards; check process identity where possible.
- JSON artifact reads: size limits, encoding validation, path confinement, safe schema validation; display generated Markdown as sanitized text/Markdown (no raw HTML execution).
- Local security: loopback binds, trusted Host and Origin, CSRF protection for mutations, narrow CORS, no arbitrary file or command endpoints. Restrict cross-origin SSE access as well.
- Network/paid operations disabled by default; Ollama uses local loopback endpoint.

## Frontend routes
- `/`: project dashboard and environment status
- `/projects/new`: create project form
- `/projects/[projectId]`: project details, status, jobs and next action
- `/projects/[projectId]/draft`: read-only outline and script, validation results

## Engine compatibility
See `engine-compatibility.md`. CLI interface is an integration boundary; verify help, version, JSON shapes and artifacts against local engine checkout before coding. Avoid assumptions based solely on old docs.

## Decisions / deferred questions
- For M1 project IDs equal validated immutable slugs; no project rename API.
- Existing projects can be registered through controlled discovery under configured root (not arbitrary paths).
- Store logs outside project folders to avoid altering engine-managed artifacts.
- Use an explicit local origin/token defense, despite no account login.
- Version the API under `/api/v1` and document any changed contract.

## Implementation notes (M1)

- **Layout:** `backend/app` holds `config`, `db` (+ `migrations/*.sql`), `engine/{commands,runner,errors,service}`, `projects`, `artifacts`, `jobs`, `security` and `api/routes`. `frontend/src` holds `app` routes, `views`, `components` (shared, per `ui-design.md` §5), `hooks/use-job-events` and `lib/{api,status,queries,validation,format}`.
- **Engine invocation:** `uv run --no-sync --quiet ytagent <allowlisted args>` with `cwd=YTA_ENGINE_REPO`, an env allowlist (`PATH`, `HOME`, locale, `OLLAMA_BASE_URL`, `PYTHONUNBUFFERED=1`) and `start_new_session=True`, so every engine run has its own process group.
- **Same origin:** the browser only talks to Next.js, which proxies `/api/*` to the backend (`compress: false` so SSE is not buffered). The backend still enforces loopback Host/Origin and a CSRF header itself.
- **Persistence:** explicit versioned SQL migrations (`schema_version` table), WAL and `busy_timeout`, one backend process. Jobs gained `process_started` (from `ps -o lstart`, a guard against PID reuse during restart reconciliation), `error_code`, `message` and `cancel_requested` beyond the milestone's minimum schema.
- **Cancellation:** SIGINT first, because the engine handles `KeyboardInterrupt` and exits 130. Then SIGTERM and SIGKILL after grace periods. While the asyncio `Process` object has not been reaped, its PID cannot be reused, so signalling it during the job's lifetime is safe.
- **Statuses:** the next action shown in the UI is derived only from `production-status` (for example `draft: blocked` → Generate a draft, `draft: needs_review` → Review the draft). When status is unavailable the UI says "Unable to determine".
- **Fixture provider:** hidden unless `YTA_ALLOW_FIXTURE_PROVIDER=true`, so a real project never gets placeholder text silently.
