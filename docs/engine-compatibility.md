# Engine Integration Contract and Verification Checklist

**Engine:** separate `levu48/youtube-agent` repository. **Preferred CLI:** `ytagent`; alias `youtube-agent`. Python >=3.12, `uv`. **Important:** verify current local checkout before implementing; branches/PRs may differ.

## Commands needed in M1
```bash
cd "$YTA_ENGINE_REPO"
uv run ytagent --version
uv run ytagent create --help
uv run ytagent draft --help
uv run ytagent production-status --help
uv run ytagent draft-check --help
```

Target operations:
```bash
uv run ytagent create --project-root "$PROJECT" --idea "$IDEA" --language vi --duration 180 --draft-provider none
uv run ytagent draft --project-root "$PROJECT" --provider ollama --model qwen3:8b
uv run ytagent production-status --project-root "$PROJECT" --json
uv run ytagent draft-check --project-root "$PROJECT" --json
```
Do not use a shell to substitute variables; build argv in Python. Use `--provider fixture` for offline draft integration tests.

## Exit code mapping from engine CLI documentation
| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected failure |
| 2 | Invalid input or protected human edits |
| 7 | Provider/model unavailable |
| 9 | Concurrent-run conflict |
| 10 | LLM generation failure |
| 11 | Needs visuals |
| 12 | Approval missing/stale |
| 14 | Research not ready |
| 16 | Human gate or release requirements unmet |
| 130 | Interrupted |

Other engine codes exist (3–6, 8, 13, 15); preserve raw code and stderr in safe diagnostics. For M1, exit 16 is an expected workflow blocker where applicable, not necessarily an application error.

## Verification before implementation
- [ ] Check exact `create` and `draft` flags and behavior; create without draft then draft separately.
- [ ] Capture real JSON output schemas for `production-status --json` and `draft-check --json` using fixture projects; document them here with examples.
- [ ] Inspect exact file names/locations of outline and script (e.g. `outline.md`, `script.md`, JSON counterparts) and their availability during incomplete jobs.
- [ ] Check whether CLI prints JSON to stdout cleanly or mixes logs on stderr; parse accordingly.
- [ ] Confirm `create` collision behavior and project root canonicalization.
- [ ] Confirm draft cancellation/retry/journal recovery semantics and project locking.
- [ ] Record engine version/commit tested and the minimum compatible capabilities.
- [ ] Add fixture integration tests using the real engine, not mocks only.

## Adapter behavior
- Explicit allowlist: version, create, draft, production-status, draft-check. No arbitrary CLI subcommands.
- Use absolute `cwd` engine repo; `asyncio.create_subprocess_exec`, no shell; bounded output and timeouts for read-only commands.
- Return typed results with stdout, stderr, exit code, elapsed time and redacted error classification.
- Do not write directly to engine-owned JSON, draft, approval or state files.
- No `--force`, `--replace-edits`, paid generation or publication in M1.
- If CLI interface mismatches, report incompatibility and document required engine revision rather than silently altering engine repo.

---

## Verified findings (2026-11-20)

**Tested engine:** `levu48/youtube-agent` `main` @ `d1325c4` (`ytagent 0.1.0`). This revision was pinned in [`ENGINE_REF`](../ENGINE_REF) for M1. The pin moved to `573ebdd` for Milestone 2, `fb6bffc` for Milestone 3, and is now `65c5f52` (see Milestone 4 below). The pin is checked by `scripts/test-real-engine.sh` and CI. Python venv at `<engine>/.venv`, uv 0.13.6, macOS arm64. Ollama 11434 with `qwen3:8b` present.

**Invocation.** The UI runs `uv run --no-sync ytagent …` with `cwd=YTA_ENGINE_REPO`. `--no-sync` guarantees the UI never re-syncs/modifies the engine's virtualenv. `PYTHONUNBUFFERED=1` is set so output streams line by line.

### Checklist
- [x] **create**: `create --project-root P --idea I --language vi|en [--duration N] [--tone] [--audience] [--guidance] --draft-provider none`. Exit 0. Writes `input.json`, `state.json`, `render/`. Stdout is a human summary (`created P`, stage lines, `BLOCKER [draft_provider_needed]`). Creates missing parent directories.
  - Existing project → exit 2, stderr `error: P is already a project; use ytagent resume …`.
  - **Existing *empty* directory is accepted** (exit 0). The UI therefore enforces "path must not exist" itself before calling `create`.
  - Idea shorter than 5 characters → exit 2 (`idea: String should have at least 5 characters`). UI validates `idea` length 5–2000.
- [x] **draft**: `draft --project-root P --provider ollama|fixture [--model M] [--from-stage outline|script|storyboard]`. `--provider` defaults to `$LLM_PROVIDER`, so the UI always passes it. Fixture draft completes in ~0.2 s and writes `outline.json/.md`, `script.json/.md`, `storyboard.draft.json`. A second run reports `draft already up to date … (nothing was written)` with exit 0 (cache).
  - Ollama unreachable → exit 7 with `error: cannot reach Ollama at …`.
  - Excluded flags: `--force`, `--replace-edits`, `--section`, `--think`, `--seed`, `--temperature`, `--max-repairs`, `--timeout`, `--idea`/`--language`/… (input overrides).
- [x] **Output streams**: commands write their result to **stdout**; errors as `error: …` to **stderr**; Python `logging` at INFO goes to **stderr** (`%(asctime)s LEVEL name: msg`). With the fixture provider a draft prints nothing until its final summary. With Ollama, the provider logs one INFO line per LLM request (`ollama qwen3:8b section_script: N tokens in, M out, 6.7s`), which the UI streams live. Nothing is synthesized and there is no percentage.
- [x] **production-status --json** (exit 0) — clean JSON on stdout:
  ```json
  {"project_id": "prj-…", "stages": [
    {"stage": "intake", "mode": null, "status": "completed", "detail": "input.json present", "next_action": null},
    {"stage": "draft", "mode": null, "status": "needs_review", "detail": "G1 editorial: not_approved",
     "next_action": "read outline.md/script.md, then ytagent draft-approve --reviewer 'Your name'"}]}
  ```
  Observed draft statuses: `blocked` (before drafting, detail `G1 editorial: missing`) and `needs_review`. Later milestones add stages; the UI renders whatever stages are returned.
- [x] **draft-check --json** — clean JSON on stdout. **Exit 2 when `ok` is false** (artifacts missing), 0 when ok. Keys: `ok`, `artifacts[{path, sha256, state: missing|generated|…}]`, `errors[]`, `warnings[]`, `review_blockers[]`, `approval_status`, `approval_changed[]`, `needs_visuals[]`, `flag_counts{}`, `timing{…, sections[]}|null`, `scenes`. Full examples in `backend/tests/fixtures/engine/`.
- [x] **Artifacts** (fixed names at the project root): `outline.json` (`schema_version: m3-outline-0.1`, `title`, `thesis_or_question`, `language`, `target_duration_seconds`, `sections[{id, role, heading, purpose, key_points[], claims_to_investigate[], estimated_duration_seconds}]`), `script.json` (`m3-script-0.1`, `sections[{outline_section_id, heading, narration, summary, review_flags[], …}]`), `outline.md`, `script.md` (start with an HTML comment; rendered with raw HTML disabled). Drafts are published atomically through the engine's journal, so partial files are not expected; the UI still handles missing/malformed files.
- [x] **Locking/recovery**: the engine takes an exclusive `flock` around short transactions (`storage/locking.py`); contention surfaces as `ConcurrencyError`, exit 9. Every `draft` recovers the publication journal at start (`storage/draft_cache.py`), so an interrupted draft is retried simply by running `draft` again.
- [x] **Cancellation**: `KeyboardInterrupt` is handled in `main()` → prints `interrupted`, exit 130. The UI cancels with **SIGINT** to the process group, then SIGTERM, then SIGKILL after grace periods.
- [x] Exit codes in `src/youtube_agent/errors.py` match the table above.
- [x] Fixture integration tests use the real engine (`backend/tests/integration/`), skipped with a reason when the engine checkout is absent.

### Minimum compatible capabilities
`ytagent --version`; `create … --draft-provider none`; `draft --provider {ollama,fixture} --model --from-stage`; `production-status --json`; `draft-check --json`. The backend checks `--version` at startup and reports `available: false` with a reason if the CLI cannot run.

## Milestone 3: research (engine M5), verified at `573ebdd`

**Status:** verified, read-only, 2026-11-22. This covers the CLI help, the source and the decision log at `573ebdd` (`ytagent 0.1.0`). The engine calls this stage M5 (`docs/milestone-5-research-evidence.md`, D-76…D-87, D-90). The UI calls it M3. The browser workflow needs the engine additions E1–E3 listed at the end of this section; the full contract is in [milestone-3.md](milestones/milestone-3.md).

### Commands at `573ebdd`

| Command | Flags (relevant) | Output | Network | Writes | Job? |
|---|---|---|---|---|---|
| `research-plan` | `--replace-plan`, `--claim-provider {none,ollama,fixture}` (default none), `--model` | text: `research plan {written\|already_current\|kept_edited}: …` | none, unless `ollama` (localhost) | `research-plan.json`; creates the `evidence.json` and `research-review.json` templates | short (≤ the 60 s lock wait); with an LLM, long |
| `research-collect` | `--search-provider {none,fixture,wikipedia}` (default none), `--fetch {auto,none,live,fixture}`, `--languages`, `--claim`, `--max-queries` 0–50, `--max-results-per-query` 0–20, `--max-pages` 0–100, `--concurrency` 1–3, `--timeout`, `--max-seconds`, `--force` | text summary only | wikipedia or live fetch | `research.json`, `snapshots.json`, `pages/*.txt` | long |
| `research-add-url` | `--url`, `--claim`, `--fetch {live,fixture,queue}` (**default live**), `--timeout` | text: `<source_id> <url>: <outcome>[ -> <snapshot_id>]` | live by default | `research.json`, `snapshots.json`, page | short to medium |
| `research-link` | `--claim`, `--snapshot`, `--quote`, `--role`, `--explanation`, `--occurrence`, `--source-type`, `--evidence-root`, translation flags | text: `linked <claim> <role> <snapshot>[start:end]` | none | appends to `evidence.json` | short |
| `research-check` | `--json`, `--write-report` | **JSON** `ResearchReport` (no `revision`) | none | takes the lock, may recover, rewrites both manifests; reports only with `--write-report` | short |
| `research-approve` | `--reviewer`, `--comment` | text | none | `research-approval.json` | short |
| `research-apply` | (none) | text | none | `scenes[].claim_ids` in `storyboard.draft.json` (draft journal) | short |
| `research-export` | `--replace-output` | text | none | `output/sources.md`, `render/research/citation-plan.json`, reports | short |

**Shared behaviour**
- **Errors and stdin.** Every error is `error: <message>` on stderr with an exit code; no research command uses the JSON error envelope. No command reads stdin.
- **Locking and publishing.**
  - All commands take the shared project lock `render/llm/manifest.lock` (60 s timeout, then exit 9). They recover both journals (`render/llm`, `render/research`).
  - They publish through `_publish_research`, which checks hashes taken when the command started and refuses on change (exit 9).
  - No command accepts an expected revision.
- **Exit codes:**
  - 2: invalid input, **and also** a human-edit conflict (`HumanEditConflictError`);
  - 7: provider unavailable; 9: concurrency or recovery; 10: LLM; 12: approval stale or G1 not current;
  - 14: not approvable (`research-check` still prints JSON); 15: partial search failure (results saved);
  - 130: interrupted.
- **Progress.** `research-collect` logs nothing per request; there is only the final summary.

### Files and ownership (D-77)
- **Human-edited:** `research-plan.json` (claims, anchors, leads), `evidence.json` (links), `research-review.json` (per-claim reviews, the completeness attestation, source rechecks). Today they are edited by hand. Only `research-link`, which appends, and `research-plan --replace-plan` write them through the CLI.
- **Tool-owned:** `research.json`, `render/research/snapshots.json`, `render/research/pages/<sha256>.txt` (immutable, content-addressed, NFC), `research-approval.json`, the reports, and `output/sources.md`. A hand-edited tool file is untrusted (`invalid_file`).
- **Schemas** (`research/models.py`, policy `m5-research-2`):

  | Item | Format |
  |---|---|
  | Claim IDs | `^clm-[a-z0-9-]{3,40}$` |
  | Claim kinds | factual, quotation, quantitative, interpretation, editorial |
  | Statuses | unverified, supported_pending_review, verified, disputed, insufficient, editorial_nonfactual |
  | Roles | supports, contradicts, context, mentions_only |
  | Anchors | NFC code-point offsets, plus `excerpt` and `narration_sha256` |
  | Evidence links | `claim_id`, `snapshot_id`, `start`, `end`, `quote`, `role`, `explanation`, `source_type`, `evidence_root`, translation fields. **Links have no ID.** |
  | Snapshots | no licence or permission field |

### Verification, G2 and G1
- **Status is human-only.**
  - No code writes a `ClaimReview`. A missing review means `unverified`, and `suggested_status` is report-only.
  - `verified` requires:
    - a `real_person` reviewer, a timezone-aware time, and a rationale of ≥30 characters and 6 words;
    - a non-fixture `supports` passage;
    - a contradiction resolution;
    - for contested or interpretive claims, two independent roots (encyclopedia, user_supplied and unknown do not count) or an exceptional primary basis, plus a counter-search and a counterargument;
    - for quotations, a verbatim primary passage or a traced translation (D-83).
- **Fixture data.** `fixture_evidence` blocks. So does `fixture_narration`: it blocks when the storyboard's `generated_by` starts with `fixture:`. `draft-edit` does not change that, so a fixture-drafted project can never pass G2 today.
- **Evidence check.**
  - `text[start:end] == nfc(quote)` exactly; snapshot text is re-hashed before use (`snapshot_tampered`).
  - `research-link` finds the quote itself and requires `--occurrence` when it appears more than once.
- **What G2 binds.** The sha256 of input, outline and script; the exact bytes of the three human files; the narration fingerprint; the used snapshot records; the source versions; and `policy_version`.
  - Any change makes G2 `stale`, a non-blocking item.
  - `research-apply` and `research-export` then refuse (exit 12).
  - `storyboard.draft.json` is not bound.
- **G1.** `research-plan`, `research-approve`, `research-apply` and `research-export` need a current G1 (`review.json` hashes of input, outline and script).
  - `research-apply` changes the storyboard, so G1 becomes `stale_after_apply`.
  - `draft-edit` refuses once any research file exists (`downstream_artifacts`, D-117).

### Network (D-80, D-82, D-87)
- **Search.** Wikipedia via the MediaWiki Action API on `vi.`/`en.wikipedia.org`: ≥0.5 s between requests, `maxlag`, retries. No key and no payment.
- **Fetcher.** Any public https URL:
  - all resolved IPs public and pinned; ≤5 redirects;
  - robots.txt checked for every redirect destination;
  - size caps (2 MiB on the wire, 8 MiB decompressed, 400k characters);
  - HTML and plain text only, PDFs metadata-only;
  - 401/403/429 and paywalls recorded, never bypassed.
- **Which URLs `research-collect` fetches.** It fetches every unfetched source relevant to the selected claims (`agents/research.py:682-692`). That includes queued `research-add-url` sources on **any host**, not only Wikipedia results. There is no per-host control.
- **`YTA_HTTP_CONTACT`** adds a contact to the User-Agent. The UI never sets it.
- **`production-status --json`** shows a research row only once G1 is approved: `completed`, `pending` or `needs_review`, with `detail` `G2 research: <gate>`. The gate (`production/gates.py`) is `recovery_required`, `pending`, `needs_review`, `approved_not_applied` or `approved`.

### Gaps for a browser workflow, and the required engine additions
1. **Edits.** There is no structured way to record decisions, edit claims, or edit or remove links. **E2 `research-edit`** brings:
   - the persistent IDs `ev-…` and `rc-…`, `migrate_ids`, and translation operations;
   - recheck update and remove, with rechecks keyed by (source, **cited** snapshot, current snapshot), as the engine already matches them (`checks.py:425`);
   - an explicit `migrate_review_file` upgrade from `m5-review-0.1`, keeping every decision, outdated until confirmed again.
2. **Revisions.** No expected revision; no revision reported. **E1:** `revision` in `research-check --json`, over the G2-bound files, the tool records and the storyboard's narration fingerprint (not the storyboard's bytes, so claim IDs from `research-apply` and shots do not change it). `--expect-revision` on every mutating command; collect and add-url re-check it after the network phase, and the dry-run preview checks it too.
3. **JSON.** Only `research-check` prints it, and exit 2 is ambiguous. **E1:** `--json` everywhere and the error envelope with distinct codes.
4. **Network control.** `research-collect` reaches any queued host, and the Wikipedia client accepts both language wikis, so an API redirect between them would be followed. **E1:** a `--dry-run` fetch-plan preview with `plan_sha256` (hosts as a conservative permission scope), and `--allow-host` enforced on every request and redirect, including Wikipedia API and `robots.txt` redirects (`host_not_allowed`).
5. **Review invalidation.** A review survives changes to its claim and evidence. **E2:**
   - a component review `basis` (claim including flags, anchors, per-link content, snapshots) and blocking `review_outdated`;
   - completeness bound to both the narration and the claim inventory;
   - append-only, hash-chained, retained review history;
   - policy `m5-research-3`.
6. **No offline source; fixture narration is all-or-nothing.** `Source.url` is required and is the identity, and snapshots require `requested_url`/`final_url`. **E3:**
   - **Imported documents.** `research-add-document` creates `doc-` sources without a URL (schemas `m5-research-0.2` and `m5-snapshots-0.2`, with `acquisition: imported`). Provenance is immutable per edition (`document_provenance` on each snapshot; corrected editions via `--new-version-of`), and cited provenance is bound by G2. These sources are excluded from every network path. Imported evidence never counts as an independent root, and counts as primary only with an attestation.
   - **Narration lineage.** Sentence-level lineage with replacement ancestry and tombstones. Nothing in a fixture-drafted project becomes human without `narration-attest`. Lineage is preserved across scene restructuring, fails closed, and is bound by the revision and G2.
   - **Legacy fixture projects.** `narration-provenance-init` initialises fail-closed lineage for projects drafted before E3.
7. **Progress.** Collect is silent. **E1:** a stderr line per search and fetch.
8. **Read contract.** **E1** documents `snapshots.json` and `pages/<sha256>.txt` as stable reads with hash verification.

**Engine status.** All three additions are merged: E1 is engine PR #12 (D-118, `8b1a766`), E2 is PR #13 (D-119, `de1e876`), and E3 is PR #14 (D-120, `fb6bffc`). UI-A pins `ENGINE_REF` to `fb6bffc9b087bbf1782690ade9dc5e050d3d2c99`, the E3 merge, so that UI-B can build on the same engine. UI-A itself uses only E1.

### Verified at `fb6bffc` (UI-A, 2026-11-22)

These facts were checked against the CLI and by the real-engine integration test `test_research_workspace_with_real_engine`.

- **`research-check --json`** prints the report plus `revision`, with no `ok` field. It exits 0 when the research is approvable and 14 when it is not; the report is printed either way. An engine without `revision` predates D-118, and the UI reports `engine_unsupported`.
- **`research-plan --claim-provider=none --expect-revision=R --json`** prints `{"ok": true, "status", "claims", "uncovered", "leads", "revision"}`. It needs a current G1: otherwise the report has the blocking item `editorial_not_current`.
- **`research-collect --dry-run --json`** contacts nothing and prints `{revision, search_hosts, provider_result_hosts, known_targets, hosts, plan_sha256}`. `hosts` is the permission scope: every host the run may contact. URLs queued with `research-add-url --fetch=queue` appear in `known_targets` and in `hosts`.
- **`research-collect` live** needs one `--allow-host=H` per host; without one it exits 2 before contacting anything. Every request and redirect, including `robots.txt`, is checked against the list, and refusals are recorded as `host_not_allowed`. It writes one progress line per search and fetch to stderr (for example `search vi …`). Exit 15 is `partial_search_failure`: some searches failed and the rest was saved.
- **`research-add-url --fetch=queue|live`**: live needs `--allow-host` equal to the URL's host. With the fixture search provider, the UI passes `--fetch=fixture` instead, which serves the engine's `.fixture.invalid` pages offline.
- **Errors** under `--json` are `{"ok": false, "error": {"code", "message", ...}}`. The UI maps `revision_mismatch` (exit 9, with `current_revision`) to `409 revision_conflict`; it also handles `invalid_input`, `concurrency`, `g1_not_current`, `provider_unavailable` and `partial_search_failure`.
- **Reads.** `research.json` (sources), `render/research/snapshots.json` and `render/research/pages/<sha256>.txt`, and `evidence.json` are read only. Snapshot text is served only when its SHA-256 matches the record.
- **CLI interoperability.** After UI jobs, the CLI's `research-check` reports the same revision as the UI.

### Verified at `fb6bffc` (UI-B, 2026-11-22)

These facts were checked against the CLI, the source and the real-engine integration test `test_research_review_with_real_engine`.

- **`research-edit --project-root=P --expect-revision=R --json [--dry-run]`.** The patch `{"operations": [...]}` goes on stdin (≤1 MiB, ≤200 operations, strict: no nulls, no unknown fields).
  - The result is `{"ok": true, status, dry_run, previous_revision, revision, changed_files, created[{op_index, kind, id}], occurrences[{op_index, field, occurrences[{n, start, end, context}]}], check, approval_status}`.
  - A dry run lists every occurrence of a quote, an original quote or an excerpt, and an ambiguous quote is not an error. A real run needs `occurrence` when a quote occurs more than once (`ambiguous_quote`).
- **Refusals** are `invalid_patch` (exit 2), with `details[{loc: "operations.i", msg, code}]`.
  - `code` is the operation's own: `unknown_claim`, `unknown_link`, `unknown_snapshot`, `quote_not_found`, `ambiguous_quote`, `bad_occurrence`, `invalid_reviewer`, `claim_exists`, `duplicate_link`, `recheck_exists`, `not_imported`, `unknown_attestation`, …
  - A broken history is `invalid_patch` with the code `history_tampered`.
  - A `m5-review-0.1` file is `migration_required` for every operation except `migrate_review_file` and `migrate_ids`.
- **`research-check` per claim** reports `status` (an outdated review counts as `unverified`), `review_outdated` (components such as `claim`, `evidence.changed:ev-…`, `basis_missing`) and `outdated_review {status, reviewer, reviewed_at}`.
  - Link references carry `acquisition`, but no link ID, quote or explanation. The UI joins them with `evidence.json`.
  - Items may carry `refs`: `components` for `review_outdated`, and `source_id`, `cited_snapshot_id` and `current_snapshot_id` for rechecks.
- **Text minimums** (`substantive`):
  - a rationale, a contradiction resolution, an exceptional primary basis, an equivalence note and a recheck rationale need 6 words and 30 characters;
  - an explanation, a counterargument, a completeness statement and an attestation statement need 5 words and 25 characters.

  They are applied by `research-check`, not at save time. `narration-attest` alone refuses a statement below 5/25 (`invalid_input`).
- **`research-add-document`** (provenance as flags, text on stdin) prints `{"ok": true, source_id, snapshot_id, supersedes_snapshot_id, chars, revision}`. A duplicate is `document_exists`, with `details {source_id, snapshot_id}`.
- **Narration lineage.** `render/llm/narration-provenance.json` (`m3-narration-provenance-1`) is written by every fixture `draft` and updated by `draft-edit`.
  - Segments store `text_sha256` and a normalised form, not the sentence. The UI recovers the text by splitting the script narration with the engine's sentence pattern and matching SHA-256.
  - `narration-attest` and `narration-provenance-init` print `{"ok": true, status, segments, remaining, recovered, revision}`.
  - Refusals are `lineage_refused` with `details.reason` (`unchanged_fixture_text`, `still_close`, `not_fixture_derived`, `unknown_segment`, `already_initialized`, `not_fixture_project`, `narration_provenance_invalid`).
- **History.** The engine chains entries by `sha256` of its own model dump (`ensure_ascii` JSON). The UI does not re-implement this: `chain_ok` is the absence of the engine's `history_tampered` item.

### Verified at `fb6bffc` (UI-C, 2026-11-23)

Checked against the CLI, the source (`agents/research.py`, `research/checks.py`, `production/gates.py`) and the real-engine integration test `test_g2_success_with_a_genuinely_sourced_document`. `fb6bffc` is still the engine's `main`, so `ENGINE_REF` is unchanged.

- **`research-approve --project-root=P --reviewer=NAME [--comment=…] --expect-revision=R --json`** prints `{"ok": true, status: approved | already_approved, approval {schema_version m5-approval-0.1, reviewer, approved_at, comment, policy_version m5-research-3, bound, snapshot_hashes, claim_statuses, scene_claims, meaning}, revision}`.
  - The revision is checked on the same locked snapshot that is approved. A file changing during the approval is a `concurrency` refusal (exit 9).
  - A placeholder reviewer is `invalid_input` (exit 2), from the engine's `real_person` check.
  - A non-current G1 is `g1_not_current` (exit 12).
  - Blocking items are `not_approvable` (exit 14); the message has one `  - [code] detail` line per item, at most 25.
- **`research-apply --expect-revision=R --json`** prints `{"ok": true, status: published | already_current, scenes_changed, written: ["storyboard.draft.json"], revision}`. Only the scenes' `claim_ids` change, so the research revision is unchanged. Without a current approval it is `approval_stale` (exit 12).
- **`research-export --expect-revision=R --json`** prints `{"ok": true, written, unchanged, revision}`. The paths are `output/sources.md`, `render/research/citation-plan.json`, `render/research/research-report.json` and `render/research/research-report.md`.
  - Before apply it is `not_approvable` (exit 14, "claim IDs are not applied to the scenes").
  - A hand-edited output is `human_edit_conflict` (exit 2), unless `--replace-output` is passed, which the UI never does.
- **After apply:**
  - `production-status` reports the draft stage `needs_review` with `G1 editorial: stale_after_apply`, and the research stage `completed` with `G2 research: approved`.
  - `draft-check` reports `approval_status: stale` and still passes, so `draft-approve` records G1 again.
  - `research-check` adds only the non-blocking note `editorial_storyboard_changed`, and export already succeeds before the G1 re-approval.
- **Before apply,** the research stage is `needs_review` with `G2 research: approved_not_applied`.
- **A G2 from imported documents alone works.** A non-contested factual claim is verified with one real supporting passage; imported documents never count as independent roots, so a contested claim cannot rely on them. A quotation needs a supporting primary passage containing the quoted words or a translation traced to a primary original that is also linked to the claim; for an imported document "primary" needs an attestation of that edition.

## Milestone 4: visuals V1 (engine D-122), verified at `65c5f52` (2026-11-24)

**Pinned engine:** `ENGINE_REF` is now `65c5f52b4428ead00fa01b104ebb69816036d033`, the merge of `youtube-agent` PR #16 (D-122, the visuals CLI contract, with its three review rounds). This is the minimum engine for the M4 UI-A work. V2 (`visuals-edit`, the clearance history and the decision-5 G3 change) is not started. The full contract is in [milestone-4.md](milestones/milestone-4.md) (V1); this section records what was checked against the merged engine.

**Required real-engine script.** `ENGINE_SOURCE=https://github.com/levu48/youtube-agent.git scripts/test-real-engine.sh` against a fresh clone at `65c5f52`: integration 8 tests, 0 skipped, 0 failed; E2E 17 passed, 1 allowed skip. Nothing in the UI uses the visuals commands yet, so this shows that M1–M3 still work at the new pin.

**Offline CLI probe** (fresh clone at `65c5f52`, `ytagent 0.1.0`, a fixture-drafted English project, fixture search provider, no network):
- **`visuals-state --project-root=P --json`** exits 0 and prints `{ok, scheme: m4-visuals-state-1, revision, revision_scheme: m4-visuals-revision-1, inputs, evidence_inputs, pending_journals, recovery_required, catalog_trusted, catalog_problems, plan, candidates, selection, clearance_history, applied, integrity, scenes, assets, report, gates: {g1, g3}}`. It writes nothing. Before a plan, G1 is `approved` and G3 `pending`; `evidence_inputs` is `{}` and `recovery_required` false.
- **`visuals-plan --expect-revision=R --json`** prints `{ok, status: written, scenes, by_kind, requires_manual, revision}`. Repeating it with the old revision gives `{ok: false, error: {code: revision_mismatch, exit_code: 9, message}}` (exit 9). The text form of the message is also written to stderr.
- **`visuals-acquire --search-provider=fixture --image-provider=none --dry-run --expect-revision=R --json`** contacts nothing and prints `{ok, dry_run: true, preview, preview_sha256}`, with `preview` = `{scheme, project_id, revision, search_provider, image_provider, scene_ids, queries, generate, max_candidates_per_scene, timeout, concurrency, force, hosts}`. With the fixture provider, `hosts` is `["commons.fixture.invalid", "upload.fixture.invalid"]`.
- **`visuals-acquire … --expect-preview=H`** without `--allow-host` for each previewed host is `invalid_input` (exit 2). With both hosts and the right hash it runs (`ok: true`, per-scene `candidates_available`; 28 candidates, `catalog_trusted` true). A wrong hash is `preview_mismatch` (exit 9).
- **After acquire,** every scene is `apply_state: none` and G3 is `needs_review`.
- **`visuals-import --stdin --title=T --kind=K --provenance=… --expect-revision=R --json`** with bytes that are not an image is refused with the generic code `error` (exit 3, "unrecognised image data (not JPEG, PNG, WebP or TIFF)"), not `invalid_input`. `--kind` is one of `archival`, `document`, `chart`, `generated`.

**From the merged source and the engine's contract tests** (`tests/test_visuals_cli_contract.py`, 133 tests; the full engine suite was 1534 passed, 14 deselected, offline). GitHub CI did not run on the engine PR (account billing block), so this rests on local runs:
- **Recovery.** `recovery_required` is true when the `render/llm` or `render/research` journal is pending (`VISUALS_RECOVERY_JOURNALS`, `agents/visuals.py:174`). With `--expect-revision`, plan, acquire (before and after its network phase), import and apply refuse under the lock **before** recovering (`_recovery_guard`, `agents/visuals.py:194`): `recovery_required`, exit 9, `details.journals`, nothing written. Without `--expect-revision`, commands recover first as before.
- **Snapshot.** `visuals-state` and the dry run read through `_inspect` (`agents/visuals.py:355`), retrying up to 3 times (`SNAPSHOT_ATTEMPTS`) before `concurrency`.
- **Evidence documents.** Read once per snapshot per reference (`_State.evidence_sha`, `agents/visuals.py:275`), reported in `evidence_inputs`, not in the revision. The hash recorded at apply is **not** compared with the current document: a V1 limitation, deferred to V2.
- **Applied assets.** `applied.json` has `asset_candidates` (`visuals/models.py:306`). Per asset, `candidate_ids`, `candidate_binding` (`recorded | inferred | ambiguous | missing`) and `candidate_id` (only when exactly one); `rights_reason` adds `candidate_ambiguous` (`agents/visuals_state.py:47-71`).
- **Shared bytes.** Apply refuses with `not_ready` (exit 2) when one asset would get two different rights records, including against an asset still shown by a scene it leaves unselected (`_retained_conflicts`, `agents/visuals.py:1791`). `--replace-assets` does not bypass it.
- **Decision numbers.** Narrate-text is D-121 and the visuals contract is D-122 (`docs/decisions.md` in the engine).

### Verified at `65c5f52` (UI-A, 2026-11-24)

Checked by the real-engine integration test `test_visuals_workspace_with_real_engine` (fixture search provider, offline) and the real-engine E2E journey.

- **Snapshot inputs.** `visuals-state` `inputs` lists the draft files (`input.json`, `outline.json`, `outline.md`, `script.json`, `script.md`, `storyboard.draft.json`, `review.json`, `assets.json`, `research-plan.json`), the visuals files and the three journal manifests, each with its SHA-256 or `null`. The backend re-hashes exactly these, plus `evidence_inputs`, to decide whether its kept snapshot is current.
- **Fixture search.** `--search-provider=fixture` returns placeholder Commons candidates (`placeholder: true`, `rights.status: accepted`) whose stored images are JPEG (1600×900) or PNG, under `render/visuals/candidates/<sha256>.<jpg|png>`. The backend serves them after hashing the bytes and reading the JPEG SOF or PNG IHDR header.
- **Plan.** A chart scene has search off (`search_enabled: false`) and `requires_manual_asset: true`, so the preview has no query for it.
- **Import.**
  - The engine needs at least **480×270** pixels ("image is 320x180; at least 480x270 is required", `invalid_input`, exit 2).
  - Bytes with a PNG signature that do not decode are refused (exit 2 or 3); the backend maps both to `422 visuals_refused` with the engine's message.
  - A valid import is a `manual_review` candidate `<scene>-imp-<10 hex>`, stored re-encoded, and served like any candidate.
- **Recovery.** A `pending` entry in `render/llm/manifest.json` makes `visuals-state` report `recovery_required: true` and a `recovery_required` finding (stage `draft`), and the backend refuses the preview with `checked_by: backend` before running the engine.
- **CLI interoperability.** After the UI's plan, search and import, `ytagent visuals-state --json` from the CLI reports the same revision as the UI.

## Milestone 2, editing: `draft-edit` (2026-11-22, engine `573ebdd`)

**Pinned engine:** `ENGINE_REF` is now `573ebddd8513f63c5afc5e73a0200b84cccdd9de`, the merge of `youtube-agent` PR #11 (decision D-117 plus the review fix `d3e2e5f`). This is the **minimum engine for editing and engine-checked approval**. Older engines still work for everything else, with editing off and the UI-token approval fallback described further down.

Verified against a fresh clone at that commit (`ytagent 0.1.0`), fixture provider, Vietnamese project. All results below were captured from the real CLI.

**`draft-check --json`** adds `revision`: a 64-hex SHA-256 over every reviewed and draft file (scheme `m3-draft-revision-1`). The UI uses it as the only revision token, for both editing and approval.

**`draft-edit --project-root=<root> --expect-revision=<rev> --json [--dry-run]`**
- **Input:** the JSON patch is read from **stdin** (UTF-8, at most 1 MiB), never from a path or argument. The UI writes it to the process's stdin, then closes stdin.
- **Patch:** strict. Unknown fields, wrong types and explicit `null` are rejected (omit a field to keep it). Fields and limits:
  - `outline`: `title` (≤300), `thesis_or_question` (≤2000), and `sections[]`, each with `id` plus any of `heading` (≤300), `purpose` (≤2000), `key_points` (1–50 items, ≤1000 each), `claims_to_investigate` (≤50 items).
  - `script.sections[]`: `outline_section_id` plus any of `heading`, `narration` (≤50,000, must contain words), `summary` (≤2000, may be empty), `editorial_notes` (≤50 items, ≤2000 each).
  - Section IDs match `^[a-z0-9][a-z0-9-]{0,39}$` and must exist.
- **Success (exit 0):** a JSON report `{ok, status, dry_run, project_root, run_id, previous_revision, revision, changed_files, files, human_edited, storyboard{resplit_sections, scenes_added, scenes_removed, briefs_need_review}, check{ok, errors, warnings, review_blockers}, approval_status, approval_changed}`.
  - `status` is `published`, `already_current` (nothing to change) or `would_publish` (dry run).
  - A title edit also changes `script.json`, `outline.md`, `script.md` and `storyboard.draft.json`. A narration edit re-splits that section's storyboard scenes. A kept visual brief whose scene text changed gets a `visual_brief_needed` flag.
- **Errors:** JSON `{"ok": false, "error": {code, exit_code, message, …}}` on stdout, plus an `error:` line on stderr.

| Engine `code` | Exit | Extra fields | UI response |
|---|---|---|---|
| `invalid_patch` | 2 | `details[{loc, msg}]` | 422 `invalid_edit` (`details.errors`) |
| `invalid_input` | 2 | (errors as `  - …` lines in `message`) | 422 `edit_refused`: the draft already had errors |
| `human_edit_conflict` | 2 | | 422 `edit_refused`: a hand-edited `.md` view would be regenerated |
| `revision_mismatch` | 9 | `current_revision` | 409 `revision_conflict` (`details.current_revision`) |
| `downstream_artifacts` | 9 | `paths` (relative names) | 409 `downstream_artifacts` (`details.paths`) |
| `concurrency` | 9 | | 409 `engine_conflict` |
| `unresolved_publication` | 9 | `conflicts` | 409 `unresolved_publication` |

- **Order inside the engine:** parse the patch, then, under the draft lock: recover any interrupted publication, check the revision, check for downstream work (`research-plan.json`, visuals, export and so on), check the draft has no errors, apply the edit, validate, and publish everything as one journalled generation. So a stale revision never writes anything, and a dry run tells the UI whether an edit is currently allowed.
- **Editability probe:** the UI runs `--dry-run` with the current title, a no-op that reports `already_current`. An error means editing is not possible now, with the engine's reason. Probed values:
  - `downstream_artifacts` (`paths: ["research-plan.json"]`);
  - `invalid_input` (the draft has errors);
  - a revision change made in between.
- **Regeneration protection:**
  - Edited `outline.json` and `script.json` are recorded as human edits (`human_edited`). Afterwards, `ytagent draft` exits 2: "these files were edited after generation … would be overwritten: outline.json, script.json … Pass --replace-edits". The UI's Generate Draft job therefore fails with exit 2 and that message, and the UI never passes `--replace-edits`. This was verified through the UI with the real engine.
  - To get new text from the model, use the CLI (`--from-stage`, or `--replace-edits` deliberately).
- **Approval:**
  - `review.json` is never touched. An edit changes the bound hashes, so the engine reports `approval_status: stale` with the changed files.
  - `draft-approve --expect-revision=<rev> --json` approves only if the locked snapshot is still at `<rev>`. Otherwise it refuses with `revision_mismatch`, exit 9, and writes nothing. Its JSON is the `review.json` record plus `ok`, `already_approved` and `revision`. With this engine the UI always uses that path (`review_mode: engine`).
- **Not driven from the UI:** crash recovery of an interrupted publication. It is covered by the engine's own tests (D-117, `tests/test_draft_edit.py`). The UI reports `unresolved_publication` and leaves resolution to the CLI.

### Before D-117 (engine `d1325c4`): no edit command

The engine has no CLI for editing drafts. Its docs describe `outline.json` and `script.json` as human-editable by hand, but hand edits cannot be made safely from the UI:
- **Hash links make dependents stale.** `script.json` records `outline_sha256` and `input_sha256`, and `storyboard.draft.json` records `script_sha256` and `outline_sha256`. Changing the outline makes the script and storyboard stale; that is an error, and approval is refused.
- **Narration is stored twice.** It lives in `script.json` sections and again, split into scenes, in `storyboard.draft.json`. `spoken_units` and `estimated_duration_seconds` are derived from it, and `outline.md`/`script.md` are generated views.
- **Edit protection is based on bytes.** A file whose bytes differ from the engine's manifest counts as `edited` and is protected from regeneration (see the `state` of each entry in `draft-check --json` `artifacts`).

Browser editing therefore needed an engine `draft-edit` command; it was added in engine PR #11 (above). The UI does not write any engine file.

### `draft-approve` (G1) at `d1325c4`
```
usage: ytagent draft-approve [-h] --project-root PROJECT_ROOT
                             [--reviewer REVIEWER] [--comment COMMENT]
  --reviewer REVIEWER   reviewer name (default: $YTA_REVIEWER or the OS user)
  --comment COMMENT     optional review comment
```
- **Under the draft lock:** it runs the same check as `draft-check`. If the report is not `ok`, it prints `error: cannot approve: the draft has errors:` followed by one `  - <error>` line per error to stderr and exits **2**. Nothing is written.
- **On success:** it writes `review.json` atomically. The file holds `reviewer`, `approved_at`, `comment`, the SHA-256 of every file in `REVIEWED`, `unresolved_blockers` (the check's `review_blockers`) and `meaning`. Each reviewed file is hashed again immediately before the rename, so a concurrent edit is never approved. Output is **text only**, `approved by <name>; recorded in …`, and the exit code is 0.
- **Review blockers do not prevent approval.** They are recorded with it, so the UI lists them in the confirmation dialog.
- **Repeat approval:** if the current approval still matches, it prints `already approved by <name> at <time>Z` and exits 0 without writing anything.
- **Lock contention** exits 9. A missing project root exits 2.
- **Reviewed files** (`REVIEWED`): `input.json`, `outline.json`, `script.json`, `storyboard.draft.json`, and `assets.json` if present.
- **Approval status** comes from `draft-check --json` `approval_status`:
  - `not_approved`;
  - `approved`;
  - `stale`, with the changed files in `approval_changed`; an unreadable `review.json` also counts as `stale`.
  
  `draft-check` doesn't report the reviewer or time, so the UI reads `review.json` for display only.
- **`production-status` for the draft stage:**

  | Situation | `status` | `detail` |
  |---|---|---|
  | Not drafted | `blocked` | `G1 editorial: missing` |
  | Drafted, not approved | `needs_review` | `G1 editorial: not_approved` |
  | Approved | `completed` | `G1 editorial: approved` |
  | Draft invalid (for example after an outside change made the script stale) | `blocked` | `G1 editorial: invalid` |

**How the UI uses it.** The UI always passes `--reviewer` explicitly.

**Two modes**, chosen per check from the engine's own output:
- **Engine-revision mode.** If `draft-check --json` reports a 64-hex `revision` (engine D-117, `youtube-agent` PR #11), that revision is the review token. Approval runs `draft-approve --expect-revision=<rev> --json`, and the engine compares the revision on the same locked snapshot it approves. A concurrent change is refused (`revision_mismatch`, exit 9) and nothing is written. Verified against PR #11 @ `67e2876`: the 4 backend real-engine integration tests pass in this mode.
- **UI-token mode** (this revision, `d1325c4`, which has no revision or `--expect-revision`).
  - The UI issues its own token only when the report verifiably covers the reviewed bytes: a well-formed `artifacts` list that includes outline, script and storyboard, each matching the bytes on disk. `draft-check` does not list `input.json` or `assets.json`; the UI hashes those itself before and after the check.
  - A window remains between the UI's check and the engine's snapshot. The UI detects a change in that window afterwards by comparing `review.json` with the validated hashes. It then answers `409 approval_unconfirmed` and remembers that record as unconfirmed, so it is never presented as the reviewer's approval.
  - The UI cannot undo the engine's record, and must not write `review.json`. The engine's `production-status` therefore still reports the draft stage as completed, and the workspace stepper shows that genuine engine status.

  Bumping `ENGINE_REF` to an engine with D-117 removes this mode in practice.

Minimum compatible capabilities for M2 (review and approve): the M1 set plus `draft-approve --project-root --reviewer [--comment]`.
