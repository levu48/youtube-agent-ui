# Milestone 1 — Verification Record

**Date:** 2026-11-20. **Branch:** `feat/m1-foundation`. **Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` `main` @ `d1325c4` (`ytagent 0.1.0`). The engine repository was not modified.

## Automated tests (offline: no Ollama, network or paid services)

Latest run: 2026-11-20, after the PR #1 review fixes.

| Suite | Command | Result |
|---|---|---|
| Backend lint | `cd backend && uv run ruff check . && uv run ruff format --check .` | pass |
| Backend unit + integration | `cd backend && uv run pytest` | 115 passed. Includes 3 integration tests that drive the **real engine** with the fixture provider. |
| Frontend lint + types | `cd frontend && npm run lint && npm run typecheck` | pass |
| Frontend component/hook tests | `cd frontend && npm test` | 27 passed |
| Frontend build | `cd frontend && npm run build` | pass |
| E2E, real engine | `cd frontend && E2E_ENGINE=real npm run test:e2e` | 10 passed, 1 skipped by design. The cancel test needs a slow job; real fixture drafts finish in about 0.2 s. |
| E2E, fake engine (replays captured engine output) | `cd frontend && E2E_ENGINE=fake npm run test:e2e` | 11 passed, including browser cancellation |

The E2E runs include axe WCAG 2.2 AA checks (after network idle), viewports of 1440, 768 and 375 px, a 200% zoom equivalent and reduced motion.

Coverage highlights:
- **Backend:** argv injection resistance, exit-code mapping, malformed JSON, missing engine, duplicate/unsafe slugs, symlink escape, existing empty folder, engine failure registers nothing, persistence across restarts, discovery, a long job not blocking requests, event ordering, SSE replay, duplicate start, global queue, cancel (graceful and escalated), safe retry, restart reconciliation, log redaction, Host/Origin/CSRF guards.
- **Frontend:** slug suggestion with Vietnamese diacritics, minutes-to-seconds conversion, field-level errors with focus management, server conflicts mapped to fields, text status labels, a log region that doesn't announce every line, dialog focus trap and restore, safe Markdown (no script, img or `javascript:` links), validation panel categories, Vietnamese rendering.

## PR #1 review fixes (`docs/reviews/pr-1-chatgpt-review.md`)

Every regression test below was also run against the code **before** its fix; the "before" column shows that result.

| Finding | Fix | Regression tests | Before the fix |
|---|---|---|---|
| **P1:** an engine timeout killed only the `uv` launcher | New `app/engine/process.py` signals the whole process group and waits until the **group** is empty, not just the launcher. It escalates SIGINT/SIGTERM → SIGKILL and reaps the launcher. It watches `returncode` because `Process.wait()` blocks while a descendant holds the pipes. The short-command runner uses it on timeout and when the caller is cancelled. Background jobs use it for cancellation and to clean up descendants left behind after the launcher exits. | `tests/unit/test_process_groups.py` (7 tests, using a launcher/child tree in `tests/spawn_tree.py`): timeout with a waiting, orphaned and signal-ignoring child (no survivors, no write after the timeout is reported), a cancelled caller, `terminate_group`, job cancel with a child that ignores SIGINT, and a job whose launcher exits leaving a child | 6 of 7 failed. The `terminate_group` test is new, so it has no "before". |
| **P2:** event gaps after a long SSE disconnect | New `GET /jobs/{id}/events/page?after=&limit=`. The hook seeds and polls by cursor, page by page until `has_more` is false, merging by event id. SSE replay is unchanged: it already resumes from `Last-Event-ID` in pages of 1000. A display cap of 6000 events is documented separately from delivery and is above the backend's 5000-line per-job limit. | Backend: `test_event_page_cursor_has_no_gaps` (2500+ events), `test_sse_replay_after_long_disconnect_is_complete` (2200 missed events). Frontend: `use-job-events.test.tsx` covers recovery of more than 1000 missed events (complete, ordered, no duplicates, cursor requests 5 → 1005 → 2005), seeding a 2300-event history, and the race where the terminal status is visible before its `completed` event. | The frontend tests fail. The backend endpoint is new. |
| **P2:** draft endpoint failures leaked `str(exc)` and were inconsistent | New `app/engine/public_errors.py` maps failures to stable codes (`engine_unavailable` 503, `engine_timeout` 504, `engine_bad_json` 502, engine codes 502 with the engine's redacted `error:` line, `internal_error` 500) and logs diagnostics server-side. `/draft-check` returns the error envelope with no diagnostics; `/draft` returns the same `{code, message}` as `draft_check_error`. The status summary gains `error_code`. | `tests/unit/test_engine_errors_public.py` (7 tests): unavailable, timeout, malformed and unexpected errors, both mocked and through real subprocesses. Asserts identical code and message on both endpoints and that no path, token, traceback or exception type leaks. | n/a (new behaviour) |
| **P2:** a job already terminal at load did not refresh related queries | One idempotent completion path: the hook calls `onCompleted({live, status})` exactly once per mount, whether the job was already terminal (`live: false`) or finished while watched (`live: true`). `JobCard.refreshAfterJob` refetches the job and invalidates project, status, draft and job-list queries once. Only live completions are announced to screen readers. | `use-job-events.test.tsx`: already-terminal job (one callback, no EventSource opened), live completion with a duplicate `completed` event (one callback), and `JobCard` refreshing once in both cases (announced only when live) | The already-terminal tests fail; the live-completion `JobCard` test passed before too |

**Found while fixing:** axe flagged contrast of 4.42–4.43:1 for `#64748B` text on tinted backgrounds: the "Coming later" stage cards and the "Engine suggests" hint. Before, the scans could run before the stage stepper had loaded. Both are fixed, and axe now waits for network idle.

**CI:** `.github/workflows/ci.yml` has four jobs:
- `backend`: real-engine tests deselected with `-m "not engine"`, so they are not reported as skipped.
- `frontend`.
- `e2e`: Playwright against the fake engine, on every run.
- `engine`: the required real-engine tests.

## Second review: real-engine tests can no longer pass without running

The second review found that the `engine` job reported success when `ENGINE_REPO_TOKEN` was missing, although every real-engine test was skipped. Changes:

- **Fail closed in CI.** The `engine` job now fails with an error annotation when the secret is missing. It checks out the engine at the revision in [`ENGINE_REF`](../ENGINE_REF) and runs `scripts/test-real-engine.sh`.
- **One script for CI and local runs.** `scripts/test-real-engine.sh` checks that the engine `HEAD` equals `ENGINE_REF`. It then runs the backend integration tests with `YTA_REQUIRE_ENGINE=1`, where a missing engine is a failure rather than a skip, and checks the JUnit report for at least one test, 0 skipped and 0 failures. Finally it runs real-engine Playwright and checks the JSON report: no failures, at least 10 passed, and no skips except the slow-job cancel test, which the `e2e` job covers.
- **No silent fallback in Playwright.** `e2e/serve.mjs` refuses `E2E_ENGINE=real` when there is no engine checkout with a `.venv`.
- **Secret documented.** The README's CI section explains how to create a fine-grained token with *Contents: read-only* on `levu48/youtube-agent` and add it as `ENGINE_REPO_TOKEN`.

**Real-engine run at the pinned revision** (local, 2026-11-20). `scripts/test-real-engine.sh` made a read-only clone of `youtube-agent` at `d1325c44ac04e0495f4bc42976d3058cd4d43467` into a temp directory and ran `uv sync --frozen`; it reported `ytagent 0.1.0`.

| Check | Result |
|---|---|
| Engine revision guard | `HEAD == ENGINE_REF` (d1325c4) |
| Backend real-engine integration (`-m engine`, `YTA_REQUIRE_ENGINE=1`) | 3 tests, 0 skipped, 0 failed |
| Playwright, real engine | 10 passed, 1 skipped (allowed: slow-job cancel), 0 failed |

**The guards were tested by forcing failures:**
- engine checkout at `HEAD~1` (202a81c): the script exited 1 with `engine at 202a81c…, expected pinned d1325c4…`;
- `E2E_ENGINE=real` with no engine: `serve.mjs` threw `no engine checkout with .venv`;
- `YTA_REQUIRE_ENGINE=1` with a missing engine: 3 failures instead of skips.

**Status in GitHub CI:** `ENGINE_REPO_TOKEN` has not been added yet (only the repository owner can create it). Until it is added, the `engine` job **fails on purpose**, and PR #1 shows that job as failing. The real-engine evidence above comes from the identical script run locally.

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

- **Browser cancel test runs on the fake engine only.** The real fixture provider finishes in about 0.2 s, too fast to cancel. Real-engine cancellation was checked manually with Ollama (above).
- **Real-engine CI needs a secret.** The `engine` job fails until the owner adds `ENGINE_REPO_TOKEN`, because the engine repository is private. See the README.
- **Status cache.** `GET /projects` caches the engine status per project for 20 s. Changes made from the CLI (for example `draft-approve`) can take up to 20 s to show on the dashboard. The project page always asks the engine afresh.
- **Single process.** The backend runs one process. A second backend pointed at the same `YTA_DATA_DIR` is not supported.
- **Restart behaviour.** Jobs that were still queued when the backend restarted are marked `interrupted`, not resumed, by design. Start them again.
- **Approval stays in the CLI.** The engine's next-action hint (for example `ytagent draft-approve …`) is shown as text because approval belongs to Milestone 2.
