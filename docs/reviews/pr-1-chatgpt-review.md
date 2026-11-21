# ChatGPT Code Review — youtube-agent-ui PR #1

- **Pull request:** https://github.com/levu48/youtube-agent-ui/pull/1
- **Reviewed commit:** `abd14cb237ef766e2ee1363e57c110585b9831dd`
- **Branch:** `feat/m1-foundation`
- **Recommendation:** Request changes before merge
- **Scope:** Static source inspection and GitHub CI inspection; no local execution or code changes performed as part of this review.

## Summary

Milestone 1 is substantially aligned with the architecture and UI design: Next.js frontend, FastAPI backend, an allowlisted CLI adapter to the separate `youtube-agent` engine, SQLite job/event persistence, project management, draft generation, live logs, and a read-only draft viewer. The implementation also includes local-only protections, including loopback/origin checks and CSRF handling.

The findings below should be resolved or explicitly dispositioned before merging.

## Findings

### P1 — Terminate the entire subprocess group on engine command timeout

**File:** [`backend/app/engine/runner.py`](https://github.com/levu48/youtube-agent-ui/blob/abd14cb237ef766e2ee1363e57c110585b9831dd/backend/app/engine/runner.py#L88-L112)

**Observation:** The short-command runner starts engine commands in a new process session, but its timeout path calls `proc.kill()` on the immediate launcher. Since the command is launched through `uv run ... ytagent`, a descendant Python process could survive the launcher and continue writing artifacts after the API reports a timeout.

**Requested fix:** Terminate the process group, wait for exit, escalate to forceful termination if necessary, and reap the launcher. Use a shared, tested termination utility where appropriate.

**Regression test:** Start a launcher that spawns a child process, trigger a timeout, and verify that neither launcher nor child remains active and no delayed writes occur.

### P2 — Recover missing events after a long SSE disconnect

**File:** [`frontend/src/hooks/use-job-events.ts`](https://github.com/levu48/youtube-agent-ui/blob/abd14cb237ef766e2ee1363e57c110585b9831dd/frontend/src/hooks/use-job-events.ts#L80-L91)

**Observation:** Polling fallback requests the latest 1,000 job events and filters them against the last seen event ID. If more than 1,000 events accumulate during disconnection, intermediate events may be permanently skipped.

**Requested fix:** Provide cursor-based event pagination (`after=<last_seen_id>`) for polling or reliably resume from the persisted SSE event cursor. Preserve order and deduplicate by event ID.

**Regression test:** Simulate disconnection and generation of more than 1,000 events; verify no missing or duplicated events after recovery. Document any intentional UI log-retention cap separately from event delivery.

### P2 — Normalize and sanitize draft endpoint failures

**File:** [`backend/app/api/routes.py`](https://github.com/levu48/youtube-agent-ui/blob/abd14cb237ef766e2ee1363e57c110585b9831dd/backend/app/api/routes.py#L172-L196)

**Observation:** The draft viewer catches a broad exception and returns `str(exc)` as `draft_check_error`, potentially exposing internal exception details. The standalone draft-check endpoint handles `EngineReadError` but may handle other engine-launch failures inconsistently.

**Requested fix:** Translate known engine errors to stable, sanitized public error codes/messages; log internal diagnostics server-side. Ensure `/draft` and `/draft-check` communicate equivalent failures consistently without leaking raw exception strings.

**Regression tests:** Simulate engine unavailability, timeout, malformed output, and unexpected exception. Confirm consistent API behavior and sanitized messages.

### P2 — Refresh related UI state for jobs already completed at initial load

**Files:**
- [`frontend/src/hooks/use-job-events.ts`](https://github.com/levu48/youtube-agent-ui/blob/abd14cb237ef766e2ee1363e57c110585b9831dd/frontend/src/hooks/use-job-events.ts#L134-L142)
- [`frontend/src/components/job-card.tsx`](https://github.com/levu48/youtube-agent-ui/blob/abd14cb237ef766e2ee1363e57c110585b9831dd/frontend/src/components/job-card.tsx)

**Observation:** When the initial job fetch already reports a terminal state, the hook closes without calling `onCompleted`. The live-completion path invokes `onCompleted`, which refreshes project and job queries. This asymmetry can leave related UI data stale after revisiting or refreshing a completed job.

**Requested fix:** Use a single idempotent completion handler for both initially terminal and live-terminal states. Invalidate/refetch relevant project, status, and job queries once.

**Regression tests:** Mount the job component with an already completed job and with a running job that completes; verify equivalent refresh behavior and no duplicate callbacks.

## CI and test coverage

At the reviewed commit, the GitHub Actions workflow completed successfully for backend and frontend checks:

- Backend: `uv sync --frozen`, Ruff lint/format, `pytest` — passed.
- Frontend: `npm ci`, lint, TypeScript check, unit tests, Next.js build — passed.
- Real-engine fixture integration tests exist but skip when the engine checkout and virtual environment are absent; the inspected CI workflow does not provide that engine checkout.
- Playwright E2E tests are present but are not executed in the inspected GitHub Actions jobs.
- The PR reports a successful manual Vietnamese Ollama test; this review did not independently reproduce it.

**Recommended CI improvement:** Add a job that checks out a pinned `youtube-agent` revision, prepares its virtual environment, and runs offline real-engine fixture integration tests. Add Playwright E2E to CI where practical. Keep tests offline and avoid requiring Ollama or paid providers in CI.

## What is working well

- Separate engine repository remains authoritative; UI uses the existing CLI rather than duplicating production logic.
- Background job/event persistence supports refresh and reconnect flows.
- Explicit human review gates are preserved.
- UI uses reusable components and typed API contracts.
- Local-only restrictions, command allowlisting, path validation, and shell-free subprocess invocation provide a strong baseline.

## Acceptance checklist for Claude Code

- [ ] P1 process-group timeout fix implemented and regression tested.
- [ ] P2 event gap recovery implemented and tested with >1,000 missed events.
- [ ] P2 draft endpoint errors normalized, sanitized, and tested.
- [ ] P2 initially-terminal job refresh behavior fixed and tested.
- [ ] Backend and frontend tests, lint, typecheck, and build pass.
- [ ] Offline real-engine integration and Playwright CI coverage added or limitations documented.
- [ ] `docs/m1-verification.md` updated with evidence and test results.
- [ ] Changes pushed to existing PR #1 branch; **do not merge**.

## Suggested Claude Code prompt

> Read `docs/reviews/pr-1-chatgpt-review.md` and address all P1 and P2 findings in PR #1. Add regression tests for each fix, run the complete test suite, and update `docs/m1-verification.md`. Add offline engine integration and Playwright checks to CI where practical. Push fixes to the existing PR branch; do not merge.
