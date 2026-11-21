# Milestone 2 — Verification Record (in progress)

**Status:** first part only, validation and G1 approval (`feat/m2-review-approve`). Browser editing of the outline and script is **not** implemented. It needs the engine edit command proposed in a separate engine PR, so M2 is not complete.

**Date:** 2026-11-21. **Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` @ `d1325c44ac04e0495f4bc42976d3058cd4d43467` (`ytagent 0.1.0`, unchanged `ENGINE_REF`), as a read-only clone. The engine repository was not modified by this PR.

## What this part delivers
- `POST /projects/{id}/draft/approve` runs `ytagent draft-approve --reviewer=<name> [--comment=…]` from the allowlist. It needs CSRF and explicit confirmation. It is refused while a job is active, and also refused when the reviewed files changed since the reviewer's last validation, using the review token. It responds with a fresh engine `draft-check` and `production-status`.
- `GET /projects/{id}/draft` (Validate Draft) adds the review token, the engine's `review.json` record (display only) and the active job.
- The draft page gains the G1 badge, Validate Draft, the approval panel and the confirmation dialog with the disclaimer and the list of review blockers. A stale approval is always shown as out of date.
- Workspace next actions: review/approve, review again when stale, and check the draft when it is invalid.

## Automated tests (offline)

| Suite | Command | Result |
|---|---|---|
| Backend lint | `cd backend && uv run ruff check . && uv run ruff format --check .` | pass |
| Backend unit + integration | `cd backend && uv run pytest` | 140 passed (M1: 115). Adds 23 approval API tests and 1 argv test; 4 real-engine integration tests. |
| Frontend lint, types, build | `cd frontend && npm run lint && npm run typecheck && npm run build` | pass |
| Frontend component/unit tests | `cd frontend && npm test` | 39 passed (M1: 27). Adds 10 approval panel tests and 2 status-mapping tests. |
| E2E, real engine | `E2E_ENGINE=real npm run test:e2e` | 11 passed, 1 skipped (the slow-job cancel test, by design) |
| E2E, fake engine | `E2E_ENGINE=fake npm run test:e2e` | 12 passed |
| Required real-engine script | `ENGINE_DIR=<clone at ENGINE_REF> scripts/test-real-engine.sh` | engine at `ENGINE_REF`; integration 4 tests, 0 skipped, 0 failed; E2E 11 passed, 1 allowed skip. The minimums were raised to 4 and 11 so the new tests must run. |

Coverage of the M2-02 and M2-04 test lists:
- **CSRF and origin.** A wrong token or a foreign origin gets 403, and the engine is not invoked.
- **Validation and confirmation.** These are rejected with 422 without running the engine: a missing, blank, multi-line, over-long or control-character reviewer name; an over-long comment; a missing or false `confirm`; a malformed token; unknown fields.
- **Path confinement.** An unknown project gets 404. Project paths come only from the validated slug, as in M1.
- **Stale revision.** If a reviewed file changes after validation, the request gets 409 `draft_changed`. Approving again with the new token works. This runs on the fake engine and on the **real engine**.
- **Approval invalidation.** After approval, an outside change to a bound file makes the engine report `stale` with the changed file. The UI shows "out of date" and never "approved" (unit, component, real-engine integration and both E2E modes).
- **Concurrent mutation.**
  - An active draft job gives 409 `job_conflict`.
  - A draft job can't start while an approval holds the project (409 `project_busy`).
  - The engine lock gives 409 `engine_conflict`.
  - A change that lands between the UI check and the engine's snapshot is reported as `approved_version_matches: false`, and the UI shows a warning.
- **Engine gate failure.** If the draft has errors, the engine refuses (exit 2) and the API returns 422 `approval_refused` with the engine's error list. This is checked against the real engine before drafting, and nothing is written.
- **Engine unavailable or timeout.** These return 503 or 504 without leaking paths. On timeout the process group is stopped and the project is released.
- **Successful approval.** The argv contains an explicit `--reviewer`, and Vietnamese reviewer names and comments are preserved. A repeat approval reports `already_approved`. The real engine's CLI `draft-check` then reports `approved`.
- **UI and accessibility.**
  - The reviewer field is required: focus moves to it and the error is described.
  - Nothing is sent before confirmation, and cancelling returns focus to the button.
  - The disabled button's description gives the reason.
  - Axe WCAG 2.2 AA runs with the dialog open and on the stale state.

**Found while testing:** axe flagged the dialog's scrollable list of blockers as not keyboard-reachable (`scrollable-region-focusable`). The list is now focusable and labelled.

## Not yet done (blocks M2 completion)
- **Editing** the outline and script: the M2-01 engine edit contract, then the M2-03 editor (unsaved state, save, conflict dialog). It needs the engine `draft-edit` command and `draft-approve --expect-revision`, proposed in a separate engine PR. Once that PR is merged, bump `ENGINE_REF`.
- **Tabs (Outline / Script / Validation)** in the draft workspace come with the editor. This part keeps the M1 layout and adds the validation and approval panels.
- **A small race when approving** remains until the engine supports `--expect-revision`. A file can change between the UI's check and the engine's snapshot. That case is detected afterwards and shown to the reviewer, not prevented.

## Definition of done (milestone-2.md), current state
- [ ] A verified safe engine edit interface exists and is documented. It is proposed in an engine PR and not yet merged.
- [ ] The browser can edit and save permitted fields without writing engine files directly.
- [ ] Edits preserve IDs, artifact consistency, human edit protection and optimistic concurrency.
- [x] Real draft-check output is visible, with actionable errors and warnings.
- [x] A named reviewer can explicitly approve G1 through the engine.
- [x] Approval becomes stale after changes to bound files and never appears falsely current.
- [x] M1 flows remain functional; all automated tests and the pinned real-engine script pass.
- [ ] PR reviewed, with no automatic merge. A draft PR is open.
