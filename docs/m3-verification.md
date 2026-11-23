# Milestone 3 — Verification Record

**Status:** in progress. The specification is [milestones/milestone-3.md](milestones/milestone-3.md).

| Step | Repository | State |
|---|---|---|
| UI-0, the specification | UI PR #6 | merged, `95b7523` |
| E1, the research CLI contract (D-118) | `youtube-agent` PR #12 | merged, `8b1a766` |
| E2, `research-edit` and policy `m5-research-3` (D-119) | `youtube-agent` PR #13 | merged, `de1e876` |
| E3, imported documents and narration lineage (D-120) | `youtube-agent` PR #14 | merged, `fb6bffc` |
| UI-A, research reads and collection jobs | UI PR #7 | merged, `3b6eb8f` |
| UI-B, decisions, evidence, documents, attestations | UI, branch `feat/m3-research-review` | in review (draft PR) |
| UI-C, G2 and apply | UI | not started |

**Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` @ `fb6bffc9b087bbf1782690ade9dc5e050d3d2c99` (`ytagent 0.1.0`), now pinned in `ENGINE_REF`, as a fresh clone. UI-A and UI-B do not modify the engine repository.

## UI-A (2026-11-22)

### What it adds
- **Backend:**
  - Allowlisted argument builders for `research-check`, `research-plan`, `research-collect` (including `--dry-run`) and `research-add-url`. Every writing command carries `--expect-revision` and `--json`.
  - Hosts must be DNS names (no IP literals, no single-label names). URLs must be https, with no credentials or control characters.
  - Read-only readers for sources, snapshots and evidence. Snapshot text is served only after its SHA-256 matches the engine's record.
  - The endpoints listed in [api-contract.md](api-contract.md#milestone-3-ui-a-research-reads-and-collection-jobs-implemented).
  - The `YTA_RESEARCH_NETWORK` and `YTA_RESEARCH_SEARCH_PROVIDER` settings.
- **Collect confirmation:**
  - The preview is the engine's own dry run.
  - The run needs `network: true`, the preview's `plan_sha256` and exactly its hosts.
  - The backend runs the preview again right before queueing the job, and any difference is `422 network_not_confirmed` with the new preview.
  - The engine then enforces the hosts on every request and redirect.
- **Frontend:**
  - A Research page per project with tabs Claims / Sources / Validation, linked from the sidebar and the project page.
  - The Search dialog (preview, host list, explicit confirmation), the Add URL dialog (queue, or fetch now confined to the confirmed host) and a plain-text snapshot reader.
  - Tool suggestions are labelled "not a verdict". Decisions and G2 are stated as not available yet.
- **Accessibility fixes found by the new scans:**
  - The job log's timestamps were below 4.5:1 contrast on the dark log, so they now use `slate-400`. This affects every job log.
  - A muted note in the host list also failed contrast and was fixed.
- **Display:** the engine stores percent-encoded URLs, so they are decoded for display (`displayUrl`) and Vietnamese paths read naturally.
- `ENGINE_REF` is bumped to `fb6bffc`. The required real-engine script now expects at least 6 integration tests and 15 E2E passes.

### Results
| Check | Result |
|---|---|
| Backend `ruff check`, `ruff format --check` | clean |
| Backend unit tests (fake engine) | 225 passed, including 24 research API tests |
| Real-engine integration (`scripts/test-real-engine.sh`, engine `fb6bffc`, fixture providers) | 6 passed, 0 skipped |
| Frontend lint, `tsc --noEmit` | clean |
| Frontend component and unit tests (Vitest) | 86 passed, including 19 for the research view and 1 for `displayUrl` |
| Production build | passes (built by the E2E web server) |
| Playwright, fake engine | 16 passed |
| Playwright, real engine | 15 passed, 1 allowed skip (slow-job cancel, covered by the fake run) |

### Covered by tests
- **Real-engine integration (`test_research_workspace_with_real_engine`):**
  - plan, then the collect preview, then a confirmed collect (the logs show the engine's `search vi …` progress lines);
  - a live add-URL of the engine's offline fixture page `https://archive.fixture.invalid/tuyen-ngon-1945`;
  - the hash-verified snapshot read;
  - a queued `vi.wikipedia.org` URL appearing in the next preview's hosts;
  - a stale revision refused with `409`;
  - the CLI's `research-check` exiting 14 with the same revision the UI reports.
- **Browser (both engines):**
  - G1 is approved again, then the claims are prepared;
  - the Search dialog stays disabled until the preview has run and its hosts are confirmed;
  - a URL is queued; a page is fetched after its host is confirmed;
  - the snapshot reader shows the fixture text and the "test data" warning;
  - the Validation tab renders;
  - axe scans the page and each open dialog.
- **Unit (fake engine):**
  - the argument builders: one `--allow-host` per host, and refusal of unknown providers and languages, flag-like claim IDs, out-of-range limits, IP and single-label hosts, and malformed revisions;
  - add-URL accepts only https URLs without credentials, whitespace or IP hosts;
  - `network_disabled`, and `network_not_confirmed` when the plan or the hosts differ from the preview;
  - live add-URL without exactly the URL's host;
  - a queued URL joining the next preview;
  - a stale revision mapped to `409 revision_conflict`;
  - a change made during the network phase records nothing;
  - the snapshot reader: a malformed ID (422), an unknown snapshot (404), and altered text (409 `snapshot_tampered`);
  - CSRF on every mutation, and the refusal while another job runs.
  - **Gap:** `nothing_to_collect` (an empty preview) has no test.

### Review revision (PR #7)
- **Research refresh after jobs.** A finished job invalidates `qk.research(projectId)` explicitly, not only through the project-key prefix. The Research page reloads the engine's report, sources, snapshots and revision when a plan, collect or add-URL job completes. Tests cover a live completion in the research view and the invalidated key in the job card.
- **Stale search confirmations.** A collect preview counts only while its `revision` equals the page's current revision, and the checkbox counts only for the `plan_sha256` that was ticked. A revision change while the dialog is open hides the host list and the confirmation, explains why, and needs a new check. A preview still in flight when the revision changed is also discarded. After `network_not_confirmed`, the dialog reloads the research view so the server's new preview can count.
- **Cancel wording.** The cancel dialog names the job type: "Stop preparing claims?", "Stop this source search?", "Stop adding this source?". Draft jobs keep their wording, and unknown types fall back to "Stop this job?". Research job cards no longer show the draft-only "Ollama · model" line.
- Each new test was checked to fail without its fix.

### Second review revision (PR #7)
- **Collect previews follow the current parameters.**
  - Each check is numbered and keyed by the revision and the exact parameters it was sent with (languages, claims, limits). Only the latest check's answer is kept, and it is shown and confirmable only while its key matches the current revision and parameters.
  - Changing a parameter, checking again or closing the dialog drops any answer still in flight, including overlapping answers that arrive out of order.
  - The search runs with the parameters stored alongside the preview it confirms.
  - The backend's `network_not_confirmed` check is unchanged.
- **Add URL confirmation does not carry over.**
  - It is bound to one host and one research revision.
  - Every close (Cancel, Escape, the close button, an outside click, or the parent closing the dialog) clears it and resets the fetch mode to queue. The typed URL is kept.
  - Editing the URL still clears it.
- **Tests.** Seven new component tests: a languages change, a page-limit change and reverse-order answers for the preview; Cancel, Escape, a revision change and a URL edit for Add URL. All but the URL-edit test fail against the previous dialogs; the URL-edit test pins behaviour that already worked.

## UI-B (2026-11-22)

### What it adds
- **Backend:**
  - Allowlisted argv builders:
    - `research-edit`: the patch on stdin, with `--dry-run`;
    - `research-add-document`: each provenance field as a single `--x=value` element, the text on stdin;
    - `narration-attest`: one `--segment` per segment;
    - `narration-provenance-init`.
  - Every one of these commands carries `--expect-revision` and `--json`.
  - Strict request models mirror the engine's patch (D-119/D-120): every operation, enum and limit; no nulls, no unknown fields, no control characters; NFC text.
  - Endpoints: `POST /research/edit`, `POST /research/documents`, `GET /research/history`, `GET /draft/narration`, `POST /draft/narration/attest` and `POST /draft/narration/provenance-init`. Every write holds the project and returns the refreshed view.
  - The research view now includes:
    - the full claims, each anchor split into before, excerpt and after at the engine's code-point offsets, in Python, and only while the excerpt still matches the narration;
    - the review file (decisions, completeness, rechecks and attestations, with the schema version);
    - the scenes;
    - the editing state, including `migration_required` and legacy IDs.
  - History `chain_ok` is the engine's own `history_tampered` check at the same revision.
  - A lineage segment's text is shown only when a current sentence has exactly the recorded SHA-256. Otherwise only the normalised form is shown.
- **Frontend:**
  - **Claims:**
    - each claim has a review panel: its narration context, edits and removal, and evidence grouped by role, with acquisition labels and attested primary sources;
    - evidence links can be edited or removed, and translations traced to their original ("not traced" → Trace to original);
    - Add claim works from an uncovered sentence, or from an excerpt that a dry run locates.
  - **Decisions:**
    - no status is preselected, and the tool suggestion is never used;
    - conditional fields appear only for the statuses that need them, and the engine's minimums are shown;
    - `verified` opens a confirmation listing the engine's rules;
    - outdated decisions are never shown as current, and offer Confirm again;
    - decisions can be cleared, and each claim's history opens on request.
  - **Snapshot reader:**
    - a selected passage gives "Link to claim…", with the dry-run occurrences;
    - imported editions show their provenance and links between editions;
    - an edition can be attested as a primary source, or the attestation revoked;
    - a new edition can be imported from here.
  - **Documents:** an import form (no URL field; a declared URL is data only), and new editions pre-filled from the previous one.
  - **Validation:**
    - the upgrade banner for `m5-review-0.1` records and legacy IDs;
    - completeness, with its stale reason;
    - source rechecks grouped by (source, cited snapshot, current snapshot), with add, correct and remove;
    - the full history.
  - **Draft page:** the Fixture text panel. It lists fixture and unattested sentences by scene, attests rewrites, shows the engine's refusal reasons, and initialises provenance for legacy projects.
  - **Conflicts:** the user's input is kept, and the page offers "Reload latest". Nothing is retried automatically.
- **Fixes found along the way:**
  - The draft page's "Editing is not available" note was below 4.5:1 contrast.
  - The jobs "busy" message no longer says "draft job" for research jobs.
- **Real-engine script:** it now requires at least 7 integration tests and 16 E2E passes.

### Engine facts found while building it (fb6bffc)
- **Statement minimum.** `narration-attest` refuses a statement under 5 words or 25 characters (`invalid_input`). The other text minimums (rationale 6/30, explanation 5/25 and so on) are applied by `research-check`, not at save time, so the UI shows them as guidance.
- **No sentence text in lineage.** Lineage segments store only `text_sha256` and a normalised form. SHA-256 matching recovered every sentence of the real fixture draft.
- **Refusal codes.** A refused edit is `invalid_patch`, with `details[{loc, msg, code}]` where `code` is the operation's own code (`unknown_claim`, `ambiguous_quote`, `invalid_reviewer`, `recheck_exists`, …). A broken history is `invalid_patch` with the code `history_tampered`.

### Results
| Check | Result |
|---|---|
| Backend `ruff check`, `ruff format --check` | clean |
| Backend unit tests (fake engine) | 267 passed, including 42 UI-B tests |
| Real-engine integration (`scripts/test-real-engine.sh`, engine `fb6bffc`) | 7 passed, 0 skipped |
| Frontend lint, `tsc --noEmit` | clean |
| Vitest | 95 passed, including 9 UI-B tests |
| Playwright, fake engine | 17 passed |
| Playwright, real engine | 16 passed, 1 allowed skip (slow-job cancel) |

### Covered by tests
- **Real-engine integration (`test_research_review_with_real_engine`).** It runs one project from a fixture draft to an attested primary source:
  1. Every fixture segment is listed with its text.
  2. An attestation of unchanged fixture text is refused with `lineage_refused`.
  3. A section is rewritten, and the new sentence is `fixture_derived`; attesting it makes it `human`.
  4. G1 is approved, then the claims are prepared; each claim's anchor carries its narration context.
  5. A document is imported, and its edition is `imported`, with provenance.
  6. A passage is linked after a dry run lists its occurrences.
  7. A decision is recorded. A flag change makes it outdated (`claim`), and confirming it again writes a `replaced` history entry with `chain_ok`.
  8. A placeholder reviewer is refused with `invalid_reviewer`.
  9. Completeness and a primary attestation are recorded.
  10. The CLI's `research-check` reports the same revision.
- **Browser (fake and real engine):**
  - import a document;
  - link a passage from the reader;
  - record a decision with no preselected status;
  - edit the claim, see "Needs a new decision", and confirm it again; the history shows the replaced entry;
  - attest completeness;
  - check the draft's Fixture text panel;
  - axe scans the page and every dialog.
- **Unit (backend):**
  - the argv builders and their refusals;
  - malformed edits rejected before the engine runs;
  - NFC;
  - claim add, update and remove, in one generation;
  - a stale revision refused, with nothing written;
  - engine refusal codes;
  - the job conflict;
  - evidence occurrences and `ambiguous_quote`;
  - an outdated decision and Confirm again;
  - history paging, its filters and tampering;
  - completeness going stale;
  - the legacy upgrade (`migration_required` → migrate → `basis_missing`);
  - document import, editions, `document_exists` and request limits;
  - primary attestation and revocation;
  - recheck add, update and remove, and `recheck_exists`;
  - the narration view, attestation, refusal and initialisation (once).
- **Component (frontend):**
  - no preselected status, the suggestion never used, and the `verified` confirmation;
  - outdated decisions never shown as current, and Confirm again;
  - history rendering;
  - conflicts keep the input and reload;
  - acquisition and primary labels, and "not traced";
  - occurrences chosen in the Link dialog;
  - document import validation, with no URL sent;
  - the upgrade confirmation;
  - the Fixture text panel: only rewrites can be attested, and the refusal reason is shown.

### Not covered (manual or later)
- **Live Wikipedia:** a real search with `YTA_RESEARCH_SEARCH_PROVIDER=wikipedia`, using the network, is left for the manual M3 smoke test. Automated tests never use the network.
- **UI-C:** validation as the gate, G2 approval, apply, export and G1 re-approval, plus the required real-engine G2 success test with a genuinely sourced document.

## UI-C (2026-11-23)

### What it adds
- **Backend:**
  - Allowlisted argv builders for `research-approve` (`--reviewer`, optional `--comment`), `research-apply` and `research-export`, each with `--expect-revision` and `--json`. Export never passes `--replace-output`.
  - Endpoints: `POST /research/approve` (`confirm: true`), `POST /research/apply` (`confirm: true`) and `POST /research/export`. Each holds the project and returns the refreshed research view.
  - The research view adds `gates {g1, g2}`: the states production-status reports in the stage details (`G1 editorial: …`, `G2 research: …`), parsed, never inferred.
  - Error mapping: `not_approvable` → `422` with the engine's blocking items; `human_edit_conflict` → `409` with the edited paths, and the message never suggests the replace flag.
- **Frontend:** the Validation tab's **Research approval (G2), apply and export** panel.
  - **Validate research** runs the engine's check. **Approve research (G2)** is enabled only for the revision that was validated and reported approvable. If the research changes afterwards, the page asks to validate again.
  - The approval dialog shows what the approval means and needs a reviewer and an explicit "I reviewed every claim…" tick. A refusal lists the engine's blocking items.
  - An out-of-date approval is shown as out of date, never as approved.
  - **Apply claim IDs to scenes** warns first that G1 goes out of date, then links to the G1 re-approval on the Draft page.
  - **Export research records** after apply lists the written files; a hand-edited export is refused with the engine's reason.
  - The project's next step after apply reads "Approve the draft again" (`stale_after_apply` was previously not recognised).
- **The genuinely sourced documents** (`backend/tests/fixtures/research/`, see `SOURCE.md`):
  - the 1945 *Tuyên ngôn Độc lập* as printed in *Cứu Quốc* no. 36, from Vietnamese Wikisource revision 85294 (public domain);
  - the opening of the 1776 United States Declaration of Independence, engrossed copy, from English Wikisource revision 16143344 (public domain).

  `g2-journey.json` holds the human-written narration, the evidence and the decisions, and is shared by the integration and E2E tests.
- **Fake engine:** approve, apply and export, approvability, approval binding and `stale_after_apply`, and G1/G2 in production-status once research has started.
- **Fixed along the way:** the outline-editing E2E test's axe scan now waits for the conflict dialog's animation, which caused the flaky contrast failure in PR #8's CI.
- **Real-engine script:** it now requires at least 8 integration tests and 17 E2E passes.

### Engine facts found while building it (fb6bffc)
- **Export after apply needs no new G1.** After `research-apply`, production-status reports `G1 editorial: stale_after_apply` and `G2 research: approved`. `research-check` reports only a non-blocking `editorial_storyboard_changed` note, and `research-export` succeeds. G1 still needs approving again before later stages; the UI leads there.
- **`not_approvable` has two meanings.** It is the code both for blocking items at approval (exit 14, one `  - [code] detail` line each) and for "export before apply". The UI shows the engine's message rather than assuming.
- **A hand-edited export** (`output/sources.md` and so on) is `human_edit_conflict` (exit 2), whose message suggests `--replace-output`. The UI never offers that flag.
- **Imported documents can carry a full G2.** A non-contested factual claim is verified with one real supporting passage. A quotation needs a primary passage, which for an imported document means an attested edition, or a translation traced to a primary original that is also linked to the claim.

### Results
| Check | Result |
|---|---|
| Backend `ruff check`, `ruff format --check` | clean |
| Backend unit tests (fake engine) | 286 passed, including 19 UI-C tests |
| Real-engine integration (`scripts/test-real-engine.sh`, engine `fb6bffc`) | 8 passed, 0 skipped |
| Frontend lint, `tsc --noEmit` | clean |
| Vitest | 112 passed, including 7 UI-C tests |
| Playwright, fake engine | 18 passed |
| Playwright, real engine | 17 passed, 1 allowed skip (slow-job cancel) |

### Covered by tests
- **Real-engine integration (`test_g2_success_with_a_genuinely_sourced_document`):** the required G2 success, offline, with no fixture evidence.
  1. A fixture draft's four scenes are rewritten (`draft-edit`) and every rewritten sentence is attested (`narration-attest`).
  2. G1, then the claim inventory (8 claims).
  3. Both documents are imported with their provenance, and both editions are attested as primary sources.
  4. Evidence for every claim, including the translated quotation traced to its English original.
  5. Verified decisions and completeness; the engine reports the research approvable with no blocking item.
  6. An approval with an earlier revision is refused (`revision_conflict`) and records nothing.
  7. G2, apply (G1 `stale_after_apply`), G1 again, export (four files).
  8. The CLI reports G2 approved and applied, `G1 editorial: approved` and `G2 research: approved`.
  9. A hand-edited `output/sources.md` is never overwritten.
- **Browser (fake and real engine):** the same journey, prepared through the API, then validate, approve the validated revision, apply with its warning, approve G1 again from the link, and export, with axe on the page and every dialog.
- **Unit (backend):** the argv builders and their refusals; strict requests (`confirm`, no nulls); the whole journey on the fake engine, including `already_approved`, export before apply and `human_edit_conflict`; a stale revision and a change during approval; `not_approvable` items; G1 not current; a generic reviewer; G2 going stale after an edit, with apply refused; the project busy.
- **Component (frontend):** approval only after validation and an explicit tick, with the validated revision; validate again after a change; an out-of-date approval never shown as approved; apply's G1 warning and the re-approval link; export and the hand-edit refusal; the engine's blocking items; the gate labels and the next step after apply.

### Not covered (manual)
- **Live Wikipedia and Ollama:** the M3 smoke test with a real search and a real model is recorded by hand, not in CI.
