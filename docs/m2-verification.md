# Milestone 2 — Verification Record

**Status:** implemented and awaiting review. Two UI PRs and one engine PR:
1. Validation and G1 approval: UI PR #3, merged.
2. The engine edit command: `youtube-agent` PR #11, merged as `573ebdd`.
3. The browser editor: `feat/m2-draft-editor`, this PR.

**Dates:** 2026-11-21 (part 1) and 2026-11-22 (editor). **Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` @ `573ebddd8513f63c5afc5e73a0200b84cccdd9de` (`ytagent 0.1.0`), now pinned in `ENGINE_REF`, as a fresh clone. Part 1 was verified at `d1325c4`, the previous pin. The UI PRs do not modify the engine repository.

## The editor (this PR)
- `GET /projects/{id}/draft/editable` returns the draft view plus `editing`: the engine revision, whether an edit is allowed now (an engine dry run), the reason when it is not, and the field limits.
- `POST /projects/{id}/draft/edit` runs `ytagent draft-edit --expect-revision=<rev> --json [--dry-run]`, with the validated patch on stdin. It needs CSRF and is refused during jobs. A stale revision is 409 `revision_conflict` and nothing is written. Responses never include absolute paths.
- Draft page:
  - tabs Outline / Script / Validation, each with a section navigator and a form for the selected section;
  - unsaved markers, Save / Discard, and a warning before leaving the page; unsaved edits are kept for the tab across browser Back/Forward and restored;
  - a conflict dialog with Copy my edits / Reload latest;
  - approval disabled while edits are unsaved.
- `ENGINE_REF` is bumped to `573ebdd`. The required real-engine script now expects at least 5 integration tests and 14 E2E passes.

## Part 1: validation and approval
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
| Backend unit + integration | `cd backend && uv run pytest` | 206 passed (M1: 115). Adds 28 approval API tests, 23 report-verification tests, 34 edit API tests and 4 adapter tests (argv, stdin); 5 real-engine integration tests. |
| Frontend lint, types, build | `cd frontend && npm run lint && npm run typecheck && npm run build` | pass |
| Frontend component/unit tests | `cd frontend && npm test` | 66 passed (M1: 27). Adds 13 approval panel tests, 3 status-mapping tests, 8 editing-logic tests and 15 editor workspace tests. |
| E2E, real engine | `E2E_ENGINE=real npm run test:e2e` | 14 passed, 1 skipped (the slow-job cancel test, by design) |
| E2E, fake engine | `E2E_ENGINE=fake npm run test:e2e` | 15 passed |
| Required real-engine script | `ENGINE_SOURCE=https://github.com/levu48/youtube-agent.git scripts/test-real-engine.sh` (fresh clone at `ENGINE_REF`) | engine at `573ebdd`; integration 5 tests, 0 skipped, 0 failed; E2E 14 passed, 1 allowed skip. Minimums raised to 5 and 14. |
| Real-engine integration, engine PR #11 | `YTA_TEST_ENGINE_REPO=<clone of youtube-agent feat/draft-edit @ 67e2876> YTA_REQUIRE_ENGINE=1 uv run pytest tests/integration` | 4 passed; the G1 test runs in engine-revision mode (`review_mode: engine`, `--expect-revision`). Extra evidence only: `ENGINE_REF` is unchanged. |

Coverage of the M2-01, M2-02 and M2-03 editing tests:
- **Real engine** (`test_browser_edit_with_real_engine`, `573ebdd`):
  - a Vietnamese outline and script edit in one save (NFC round trip, `script.md` regenerated, storyboard re-split);
  - the CLI `draft-check` revision matches the UI;
  - a stale revision gets 409 with nothing written;
  - an unknown section ID gets 422 `invalid_edit` with its location;
  - a dry run writes nothing;
  - the approval becomes `stale` after the edit and is approved again via `--expect-revision`;
  - regeneration protection: a later Generate Draft job fails with exit 2, and the edits are untouched;
  - downstream work (`research-plan.json`) turns editing off, with the path shown.
- **Engine ordering (fake engine mirroring D-117):**
  - a change racing into the engine is refused (409, nothing written);
  - the engine lock gives 409 `engine_conflict`;
  - an active job gives 409, and a job cannot start during an edit;
  - an engine that has no revision reports `engine_unsupported`;
  - timeout gives 504 and releases the project; engine unavailable gives 503 without leaking paths.
- **Request safety:** 16 malformed requests get 422 without running the engine: null fields, unknown fields such as `project_root`, a traversal section ID, limits, control characters, wrong types and a bad revision. A patch over 1 MiB is rejected before the engine. Missing CSRF or a foreign origin gets 403. The patch travels only on stdin; the argv carries the root, the revision, `--json` and `--dry-run`, and never user text.
- **UI:**
  - Component tests: only the changed fields are sent; unsaved markers and tab counts; approval blocked while unsaved; Vietnamese narration with `lang="vi"`; field errors are described and block Save, with the reason as its description.
  - Component tests: the conflict dialog copies the edits, keeps them on "Keep editing", and drops them only on "Reload latest"; read-only with the engine's reason and paths; discard needs confirmation; engine error locations are listed; arrow keys move between tabs; `beforeunload` when dirty.
  - E2E (both engines): edit outline, edit Vietnamese script, save, reload, approve, edit again (stale), then an outside change produces the conflict dialog: Keep editing, then Reload latest. Axe runs on the editor, with unsaved edits, and with the conflict dialog open. The responsive and 200%-zoom checks include the editor.
- **Found while testing:**
  - Typing a space that briefly made a field equal to the saved text reset the raw input; the editor now keeps it.
  - The approved panel did not mention unsaved edits; it now says the approval covers only the saved draft.
  - First CI run of this PR: in the real-engine E2E, an approval clicked while "Load the latest draft" was still refetching sent the previous token, and the engine rightly refused it. Approval is now disabled while the draft is being validated again ("Validating the draft…").

Coverage of the M2-02 and M2-04 approval test lists:
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

## Second review of PR #4 (commit `62496bc`), addressed
**P2, recovery could fail silently when browser storage is unavailable.** Before, a failed `sessionStorage` write was ignored, so with storage blocked or full, browser Back could still lose the edits without any sign.
- **Smaller payload.** The backup holds only the edits, the base revision and the base outline and script data (`v: 2`). The Markdown, the draft-check, the approval record and the editing metadata are taken from the current view on restore.
- **Fallback.** Every write also keeps an in-memory copy for the tab's JavaScript session, which cannot fail. In-app navigation, including Back and Forward, keeps it, so the edits are restored even when storage refuses the write. `sessionStorage` remains the copy that survives a reload or a page crash.
- **Detected and visible.** `storeEdits` reports whether the durable write succeeded (`useBackupFailed`). While it fails, the draft page shows an alert: the browser is not keeping a backup, the edits survive moving around the app but not a reload, a crash or closing the tab, with a **Copy my edits** button. Closing and reloading still ask first. Save or Discard clears both copies and the alert.
- **Tests.**
  - Component: `sessionStorage.setItem` throws `QuotaExceededError`. The test checks the alert, that the copy button copies the edits, that the edits are restored after unmounting (Back), and that Discard clears them.
  - Component: the stored payload contains only the six expected keys and no Markdown. A third test restores from `sessionStorage` alone, the reload path.
  - Playwright (both engines): `Storage.prototype.setItem` is made to throw. The alert and the copy button show, axe passes, Back and Forward restore the title, and Discard removes the alert.
  - The first two component tests fail on `62496bc`.

## Review of PR #4 (commit `9194d6e`), addressed
Engine-owned saves and the optimistic revision check are unchanged: every save is still one `draft-edit --expect-revision` run, and nothing restored or kept is sent until the reviewer presses Save.

1. **P2, editing during an in-flight Save could lose changes.**
   - Before, a successful save cleared all edits, including ones typed while the request was pending.
   - Now Save fixes the patch, the revision and the raw input it was built from as the mutation's variables. When it returns, `editsAfterSave` drops only the fields whose input is unchanged since Save was pressed. Anything typed meanwhile stays unsaved, layered on the engine's newly saved draft, and a toast says so. The next save is checked against the new revision. Fields stay editable while saving; Discard stays disabled.
   - Tests: the component test "keeps edits typed while a save is pending…" holds the first `POST` open with a delayed response, types in the saved field and in another field, then releases it. Both edits remain, and the second save sends `expected_revision` = the new revision with both fields. A unit test covers `editsAfterSave`. The component test fails on `9194d6e`.
2. **P2, browser Back could discard unsaved changes.**
   - The App Router gives no reliable way to block a history navigation, so the fix is recoverable persistence rather than a prompt. While edits are unsaved, `lib/edit-recovery.ts` keeps them, and the draft version they are based on, in `sessionStorage` (per tab, keyed by project). When the draft page opens again, they are restored with the note "Your unsaved edits were restored". Saving or discarding clears them. Storage errors are ignored, and the reload/close/link guard is unchanged.
   - Restored edits on an older version keep that version as their base, so the "draft changed since you started editing" alert shows and the engine refuses the save (409, conflict dialog). Nothing is forced.
   - Tests: component tests restore after unmount (what Back does), clear on Discard, and restore stale edits so the save goes out with the old revision and gets the conflict dialog. The Playwright test "browser Back and Forward with unsaved edits…" (both engines) edits the title, goes Back and Forward, then Back and opens the draft from the workspace link; the edit is restored each time and axe passes. Discard and a reload show the saved title. On `9194d6e` it fails: after Forward the field shows the saved title.

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

## Known limitations
- **Browser Back/Forward** is not intercepted (App Router limitation): it leaves the page without asking, but the unsaved edits are kept for that browser tab and restored when the draft opens again. They do not follow you to another tab or survive closing the tab (closing asks first). If the browser refuses storage, an in-memory copy still covers Back and Forward within the tab, and the page warns that a reload or crash would lose the edits.
- **Crash recovery** of an interrupted engine publication is tested in the engine (D-117), not driven from the UI. The UI reports `unresolved_publication` and leaves it to the CLI.
- **Regenerating text after an edit** is deliberately not offered: the UI never passes `--replace-edits`.
- **Approval race with an older engine.** With the pinned engine, approval always uses `--expect-revision`, so the engine prevents the race. The UI-token fallback (409 `approval_unconfirmed`) remains only for engines older than D-117, where editing is also off.

## Definition of done (milestone-2.md), current state
- [x] A verified safe engine edit interface exists and is documented: `draft-edit` (D-117, engine PR #11, `573ebdd`), recorded in `engine-compatibility.md`.
- [x] The browser can edit and save permitted fields without writing engine files directly.
- [x] Edits preserve IDs, artifact consistency, human edit protection and optimistic concurrency. The engine enforces all of these, and the real-engine tests check them.
- [x] Real draft-check output is visible, with actionable errors and warnings.
- [x] A named reviewer can explicitly approve G1 through the engine.
- [x] Approval becomes stale after changes to bound files and never appears falsely current.
- [x] M1 flows remain functional; all automated tests and the pinned real-engine script pass.
- [ ] PR reviewed, with no automatic merge. A draft PR is open for the editor.
