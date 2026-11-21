# Milestone 1 — Local UI Foundation, Projects and Draft Generation

**Status:** ready for Claude Code implementation. **Goal:** from a browser, create a valid engine project, run an Ollama draft asynchronously, observe progress, view generated outline/script and engine-reported next action.

## Scope
Four screens: `/`, `/projects/new`, `/projects/[projectId]`, `/projects/[projectId]/draft`. FastAPI `/api/v1` backend, SQLite UI metadata, background jobs, SSE and local engine CLI adapter. Read-only draft viewer; no approvals, editor, media, paid/cloud or publishing.

## Work packages and acceptance

### M1-01 — Foundation
- Scaffold Next.js App Router with strict TypeScript, Tailwind and shadcn/ui; FastAPI Python >=3.12 with `uv`.
- Add `.env.example`, safe configuration, SQLite migrations, health endpoint, development script and offline CI.
- Bind frontend/backend to `127.0.0.1`; use one documented startup command `./scripts/dev.sh`.
- Tests: health, configuration validation, frontend build, lint and backend pytest.

### M1-02 — Engine adapter
- Verify CLI against sibling repo and document tested commit and JSON schemas.
- Implement allowlisted argv for `--version`, `create`, `draft`, `production-status --json`, `draft-check --json`.
- Run subprocesses with explicit cwd, no shell; capture stdout/stderr and exit code, redact sensitive data.
- Classify engine conflicts, missing Ollama/model, expected gates, cancellation and unexpected failures.
- Tests: argument injection resistance, exit mapping, JSON parse errors, missing engine and CLI compatibility.

### M1-03 — Project management
- SQLite `projects` registry with immutable safe slug, canonical root, display name and timestamps.
- Create via engine `create --draft-provider none`; register only on success; reject existing paths, traversal, symlink escape and concurrent creation.
- List and detail projects; discover/register existing valid engine projects only under allowed root.
- Tests: duplicates, malicious slug, symlink, engine failure, persistence after restart, project usable by CLI.

### M1-04 — Background job manager
- SQLite `jobs` and `job_events` tables; durable logs in app support directory.
- Async draft execution; queue, running, succeeded, failed, cancelled, interrupted statuses.
- One mutating job per project; global limit 1 initially; explicit queue semantics.
- SSE with persisted event IDs, replay and polling fallback; no fake progress percentages.
- Graceful process-group cancellation and bounded termination; startup reconciliation of orphaned jobs without assuming success.
- Tests: long job nonblocking, events ordering, cancel, duplicate start, backend restart, safe retry, log redaction.

### M1-05 — Dashboard and project details
- Project list cards: title, language, duration, status, last activity; empty/error/loading states.
- Details: engine status, active/recent jobs, next action, live logs, clear engine error messages.
- Tests: API error states, accessibility, route navigation and refresh persistence.

### M1-06 — Create and draft UX
- Form: slug, idea, en/vi, 60–3600 seconds, audience, tone, guidance; defaults; validate client and server.
- Show local Ollama health/model availability; start draft job with selected model.
- Disable duplicate submit; show queue/running/terminal states, cancel action and logs.
- Tests: form validation, successful create, Ollama unavailable, fixture-provider draft, retries.

### M1-07 — Draft viewer, tests and docs
- Read-only outline and script, using verified engine artifact paths; safe Markdown rendering.
- Display draft-check results and next action; handle missing/partial/malformed artifacts.
- Offline fixture integration tests with real engine, no Ollama/Piper/network/paid APIs.
- Manual smoke: Ollama qwen3:8b Vietnamese draft on Apple Silicon; same project works via CLI.
- Document setup, troubleshooting, architecture and test commands.

## Database (UI-owned only)
`projects(id TEXT PRIMARY KEY, slug TEXT UNIQUE, root_path TEXT UNIQUE, display_name TEXT, created_at TEXT, updated_at TEXT)`

`jobs(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), job_type TEXT, status TEXT, command_args_json TEXT, pid INTEGER, started_at TEXT, finished_at TEXT, exit_code INTEGER, error_message TEXT, log_path TEXT)`

`job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT REFERENCES jobs(id), event_type TEXT, payload_json TEXT, created_at TEXT)`

Use migrations, indexes on project/job/time and WAL. Persist actual event IDs; do not treat PID alone as authoritative after restart.

## API
Implement endpoints and payloads in `../api-contract.md`, with typed Pydantic schemas and generated OpenAPI.

## Suggested phases
1. Foundation + CLI verification + adapter.
2. SQLite + project APIs + dashboard.
3. Durable job manager + SSE + draft execution.
4. Draft viewer + security hardening + automated and manual tests.

## Definition of done
- [ ] One command starts frontend/backend locally.
- [ ] Engine version and Ollama availability shown accurately.
- [ ] Browser creates valid project; engine CLI independently recognizes it.
- [ ] Draft generation does not block requests and streams real logs.
- [ ] Refresh preserves project/job history and can replay SSE events.
- [ ] Cancellation and restart recovery do not corrupt engine state.
- [ ] User can view outline/script and draft-check result read-only.
- [ ] Engine human gates, locks, caches and files remain authoritative.
- [ ] Project paths, origins, host and subprocess inputs are restricted.
- [ ] Offline backend/frontend/integration tests and lint pass.
- [ ] Manual Vietnamese Ollama smoke test recorded (if environment available).
- [ ] Docs and a draft PR completed; no automatic merge.

## Handoff prompt
> Read CLAUDE.md, docs/architecture.md, docs/engine-compatibility.md, docs/api-contract.md, and docs/milestones/milestone-1.md. Verify the sibling youtube-agent CLI before coding. Implement M1-01 through M1-07 incrementally, with tests. Do not modify youtube-agent, do not bypass gates, and do not merge automatically. Report tested engine commit, commands run, and remaining limitations.
