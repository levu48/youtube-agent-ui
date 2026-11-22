# Milestone 2 — Verification Record (in progress)

**Status:** first part only, validation and G1 approval (`feat/m2-review-approve`). Browser editing of the outline and script is **not** implemented. It needs the engine edit command proposed in a separate engine PR, so M2 is not complete.

**Date:** 2026-11-21. **Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` @ `d1325c44ac04e0495f4bc42976d3058cd4d43467` (`ytagent 0.1.0`, unchanged `ENGINE_REF`), as a read-only clone. The engine repository was not modified by this PR.

## What this part delivers
- `POST /projects/{id}/draft/approve` runs `ytagent draft-approve --reviewer=<name> [--comment=…]` from the allowlist, adding `--expect-revision=<rev> --json` when the engine supports a draft revision.
  - It needs CSRF and explicit confirmation.
  - It is refused while a job is active, and also refused when the reviewed files changed since the reviewer's last validation, using the review token.
  - It responds with a fresh engine `draft-check` and `production-status`.
- `GET /projects/{id}/draft` (Validate Draft) adds:
  - the review token, with its mode (`engine` or `ui`) and, when there is no token, the reason;
  - the engine's `review.json` record, for display only;
  - `approval_confirmed`;
  - the active job.
- The draft page gains the G1 badge, Validate Draft, the approval panel and the confirmation dialog with the disclaimer and the list of review blockers. A stale approval is always shown as out of date.
- Workspace next actions: review/approve, review again when stale, and check the draft when it is invalid.

## Automated tests (offline)

| Suite | Command | Result |
|---|---|---|
| Backend lint | `cd backend && uv run ruff check . && uv run ruff format --check .` | pass |
| Backend unit + integration | `cd backend && uv run pytest` | 169 passed (M1: 115). Adds 28 approval API tests, 23 report-verification tests and 2 argv tests; 4 real-engine integration tests. |
| Frontend lint, types, build | `cd frontend && npm run lint && npm run typecheck && npm run build` | pass |
| Frontend component/unit tests | `cd frontend && npm test` | 42 passed (M1: 27). Adds 12 approval panel tests and 3 status-mapping tests. |
| E2E, real engine | `E2E_ENGINE=real npm run test:e2e` | 11 passed, 1 skipped (the slow-job cancel test, by design) |
| E2E, fake engine | `E2E_ENGINE=fake npm run test:e2e` | 12 passed |
| Required real-engine script | `ENGINE_DIR=<clone at ENGINE_REF> scripts/test-real-engine.sh` | engine at `ENGINE_REF`; integration 4 tests, 0 skipped, 0 failed; E2E 11 passed, 1 allowed skip. The minimums were raised to 4 and 11 so the new tests must run. |
| Real-engine integration, engine PR #11 | `YTA_TEST_ENGINE_REPO=<clone of youtube-agent feat/draft-edit @ 67e2876> YTA_REQUIRE_ENGINE=1 uv run pytest tests/integration` | 4 passed; the G1 test runs in engine-revision mode (`review_mode: engine`, `--expect-revision`). Extra evidence only: `ENGINE_REF` is unchanged. |

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
  - A change that lands between the UI check and the engine's snapshot:
    - Engine-revision mode: the engine refuses it under its lock (409 `draft_changed`, no `review.json`).
    - UI-token mode: it answers 409 `approval_unconfirmed`, is remembered in SQLite, and shows as "G1 approval unconfirmed" until the reviewer validates and approves the current version.
- **Engine gate failure.** If the draft has errors, the engine refuses (exit 2) and the API returns 422 `approval_refused` with the engine's error list. This is checked against the real engine before drafting, and nothing is written.
- **Engine unavailable or timeout.** These return 503 or 504 without leaking paths. On timeout the process group is stopped and the project is released.
- **Successful approval.** The argv contains an explicit `--reviewer`, and Vietnamese reviewer names and comments are preserved. A repeat approval reports `already_approved`. The real engine's CLI `draft-check` then reports `approved`.
- **UI and accessibility.**
  - The reviewer field is required: focus moves to it and the error is described.
  - Nothing is sent before confirmation, and cancelling returns focus to the button.
  - The disabled button's description gives the reason.
  - Axe WCAG 2.2 AA runs with the dialog open and on the stale state.

## Review of PR #3 (findings 1–4), addressed
1. **P1, race between the UI check and the engine snapshot.**
   - Approval now coordinates with the engine: when `draft-check` reports a `revision`, the UI passes it to `draft-approve --expect-revision --json`. The engine checks it on the locked snapshot it approves, so a racing change is refused and nothing is written. The engine side is engine PR #11, not yet merged.
   - Until `ENGINE_REF` has that command, a mismatched approval is never treated as success. The API answers 409 `approval_unconfirmed`, not 200, and records the engine's `review.json` record as unconfirmed (migration 0002). `GET /draft` reports `approval_confirmed: false`, the badge reads "G1 approval unconfirmed", and the form stays available. Validating and approving the current version confirms it.
   - Tests: `test_change_racing_into_engine_snapshot_is_not_treated_as_success` and `test_engine_refuses_a_race_under_its_lock`.
2. **P2, token issued for an empty or incomplete report.**
   - `verify_report` now requires:
     - an ok check with a known approval status;
     - a list of well-formed artifact entries (string path, 64-hex lowercase sha, no duplicates);
     - entries for `outline.json`, `script.json` and `storyboard.draft.json`, each matching the bytes on disk;
     - every listed reviewed file to match;
     - `input.json` to exist.
   - Otherwise there is no token, and `review_token_reason` gives the cause, which becomes the disabled button's description. Approval then returns 422 `draft_unverifiable` without running the engine. A failing check gets no token either.
   - Tests: 23 tests in `test_review_report.py` cover malformed and incomplete reports, plus `test_incomplete_engine_report_issues_no_token`, which uses the fake engine's `approve_garbled` mode.
3. **P2, success toast despite a mismatch.**
   - The panel computes the mismatch first. A response with `approved_version_matches !== true` or `approval_confirmed === false` shows a warning toast and alert, never the success toast. A 409 `approval_unconfirmed` is shown as an error with `Load the latest draft`.
   - Tests: two component tests assert that `toast.success` is never called in these cases.
4. **P2, engine-authoritative revision.**
   - The engine's `revision` is preferred whenever the engine reports one: the review token *is* the revision, and the UI hash is only the fallback for engines without it.
   - Verified against the real engine PR #11 (integration tests in engine mode) and the fake engine (`FAKE_REVISION=1`, which mirrors D-117's revision scheme and JSON errors).

**Behaviour change found while testing:** after an outline edit, the script's hash link is stale, so the draft has errors. An approval request for that draft now goes to the engine, which refuses it with its own error list (422 `approval_refused`). Before, the UI answered 409 from its token alone. The real-engine test now uses a storyboard change to cover a stale approval of a still-valid draft (409 `draft_changed`), and checks that the outline edit is refused without changing `review.json`.

**Found while testing:** axe flagged the dialog's scrollable list of blockers as not keyboard-reachable (`scrollable-region-focusable`). The list is now focusable and labelled.

## Not yet done (blocks M2 completion)
- **Editing** the outline and script: the M2-01 engine edit contract, then the M2-03 editor (unsaved state, save, conflict dialog). It needs the engine `draft-edit` command and `draft-approve --expect-revision`, proposed in a separate engine PR. Once that PR is merged, bump `ENGINE_REF`.
- **Tabs (Outline / Script / Validation)** in the draft workspace come with the editor. This part keeps the M1 layout and adds the validation and approval panels.
- **Closing the approval race needs the engine PR.** With `ENGINE_REF` at `d1325c4`, a file can still change between the UI's check and the engine's snapshot. The engine then records an approval the UI did not confirm. The UI no longer treats that as success: it answers 409, shows "unconfirmed", and keeps the form. It cannot undo the engine's record, and the engine's own stage status (workspace stepper) still says completed. Bumping `ENGINE_REF` to an engine with D-117 prevents the case; the UI already uses `--expect-revision` when it is available.

## Definition of done (milestone-2.md), current state
- [ ] A verified safe engine edit interface exists and is documented. It is proposed in an engine PR and not yet merged.
- [ ] The browser can edit and save permitted fields without writing engine files directly.
- [ ] Edits preserve IDs, artifact consistency, human edit protection and optimistic concurrency.
- [x] Real draft-check output is visible, with actionable errors and warnings.
- [x] A named reviewer can explicitly approve G1 through the engine.
- [x] Approval becomes stale after changes to bound files and never appears falsely current.
- [x] M1 flows remain functional; all automated tests and the pinned real-engine script pass.
- [ ] PR reviewed, with no automatic merge. A draft PR is open.
