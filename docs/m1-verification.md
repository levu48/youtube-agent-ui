# Milestone 1 — Verification Record

**Date:** 2026-11-20. **Branch:** `feat/m1-foundation`. **Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` `main` @ `d1325c4` (`ytagent 0.1.0`). The engine repository was not modified.

## Automated tests (offline: no Ollama, network or paid services)

| Suite | Command | Result |
|---|---|---|
| Backend lint | `cd backend && uv run ruff check . && uv run ruff format --check .` | pass |
| Backend unit + integration | `cd backend && uv run pytest` | 99 passed. The integration tests drive the **real engine** with the fixture provider. |
| Frontend lint + types | `cd frontend && npm run lint && npm run typecheck` | pass |
| Frontend component tests | `cd frontend && npm test` | 20 passed |
| Frontend build | `cd frontend && npm run build` | pass |
| End-to-end (Playwright, Chromium) | `cd frontend && npm run test:e2e` | 10 passed. Real engine with the fixture provider and Ollama deliberately unreachable. Axe WCAG 2.2 AA checks, 1440/768/375 px, 200% zoom equivalent, reduced motion. |

Coverage highlights:
- **Backend:** argv injection resistance, exit-code mapping, malformed JSON, missing engine, duplicate/unsafe slugs, symlink escape, existing empty folder, engine failure registers nothing, persistence across restarts, discovery, a long job not blocking requests, event ordering, SSE replay, duplicate start, global queue, cancel (graceful and escalated), safe retry, restart reconciliation, log redaction, Host/Origin/CSRF guards.
- **Frontend:** slug suggestion with Vietnamese diacritics, minutes-to-seconds conversion, field-level errors with focus management, server conflicts mapped to fields, text status labels, a log region that doesn't announce every line, dialog focus trap and restore, safe Markdown (no script, img or `javascript:` links), validation panel categories, Vietnamese rendering.

## Manual smoke tests with the real engine and Ollama (`qwen3:8b`, Vietnamese)

Run through the dev servers (`./scripts/dev.sh`) with a scratch projects folder:

1. **Create and draft.** Created `smoke-vi` (vi, 120 s) through the API and UI, then started an Ollama draft. 12 real progress lines streamed (one per LLM request) and then the summary. Result: **succeeded**, exit 0, 9 items in 81 s, estimated 112 s for the 120 s target. The viewer showed the Vietnamese outline and script with review flags. `draft-check`: OK, `not_approved`.
2. **CLI interop.** `uv run ytagent production-status --project-root …/smoke-vi` from the engine repo printed `draft: needs_review`, and `draft-check` printed OK.
3. **Cancel during generation.** Cancelled after the first LLM request. The engine printed `interrupted` and exited 130, and the job ended `cancelled`. No engine process was left running and no partial artifacts were published (`draft-check` listed all files as missing). Retrying succeeded and reused the cached outline (`8 generated, 1 cached`); the project reached `needs_review`.
4. **Backend crash during a job.** SIGKILLed the backend while an Ollama draft was running. After a restart, the job was `interrupted` (outcome not assumed). The still-running engine process passed the identity check (pid, process-group leader, start time) and was interrupted.

## Definition of done (milestone-1.md)

- [x] One command starts frontend/backend locally (`./scripts/dev.sh`).
- [x] Engine version and Ollama availability shown accurately.
- [x] Browser creates a valid project; the engine CLI independently recognises it.
- [x] Draft generation does not block requests and streams real logs.
- [x] Refresh preserves project/job history and can replay SSE events.
- [x] Cancellation and restart recovery do not corrupt engine state.
- [x] User can view outline/script and the draft-check result, read-only.
- [x] Engine human gates, locks, caches and files remain authoritative.
- [x] Project paths, origins, host and subprocess inputs are restricted.
- [x] Offline backend/frontend/integration tests and lint pass.
- [x] Manual Vietnamese Ollama smoke test recorded (above).
- [x] Docs and a draft PR; no automatic merge.

## Known limitations / follow-ups

- **Cancel is not tested end to end in the browser.** The fixture provider finishes in about 0.2 s, too fast to cancel. Cancellation is covered by backend tests (fake slow engine), the component test of the confirm dialog, and the manual Ollama test above.
- **CI does not check out the engine.** The CI workflow runs backend tests without the engine, so the real-engine integration tests skip there. E2E runs locally only, because it needs the engine checkout.
- **Status cache.** `GET /projects` caches the engine status per project for 20 s. Changes made from the CLI (for example `draft-approve`) can take up to 20 s to show on the dashboard. The project page always asks the engine afresh.
- **Single process.** The backend runs one process. A second backend pointed at the same `YTA_DATA_DIR` is not supported.
- **Restart behaviour.** Jobs that were still queued when the backend restarted are marked `interrupted`, not resumed, by design. Start them again.
- **Approval stays in the CLI.** The engine's next-action hint (for example `ytagent draft-approve …`) is shown as text because approval belongs to Milestone 2.
