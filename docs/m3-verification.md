# Milestone 3 — Verification Record

**Status:** in progress. The specification is [milestones/milestone-3.md](milestones/milestone-3.md).

| Step | Repository | State |
|---|---|---|
| UI-0, the specification | UI PR #6 | merged, `95b7523` |
| E1, the research CLI contract (D-118) | `youtube-agent` PR #12 | merged, `8b1a766` |
| E2, `research-edit` and policy `m5-research-3` (D-119) | `youtube-agent` PR #13 | merged, `de1e876` |
| E3, imported documents and narration lineage (D-120) | `youtube-agent` PR #14 | merged, `fb6bffc` |
| UI-A, research reads and collection jobs | UI, branch `feat/m3-research-workspace` | in review (draft PR) |
| UI-B, decisions, evidence, documents, attestations | UI | not started |
| UI-C, G2 and apply | UI | not started |

**Machine:** macOS on Apple Silicon, uv 0.13.6, Node 26.13, Python 3.12.16.
**Engine tested:** `youtube-agent` @ `fb6bffc9b087bbf1782690ade9dc5e050d3d2c99` (`ytagent 0.1.0`), now pinned in `ENGINE_REF`, as a fresh clone. UI-A does not modify the engine repository.

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

### Not covered (manual or later)
- **Live Wikipedia:** a real search with `YTA_RESEARCH_SEARCH_PROVIDER=wikipedia`, using the network, is left for the manual M3 smoke test. Automated tests never use the network.
- **Later UI PRs:** claim decisions, evidence links, documents, attestations, history and G2 come in UI-B and UI-C.
