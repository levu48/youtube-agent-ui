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

**Tested engine:** `levu48/youtube-agent` `main` @ `d1325c4` (`ytagent 0.1.0`). This revision was pinned in [`ENGINE_REF`](../ENGINE_REF) for M1; it is now `573ebdd` (see Milestone 2 below). The pin is checked by `scripts/test-real-engine.sh` and CI. Python venv at `<engine>/.venv`, uv 0.13.6, macOS arm64. Ollama 11434 with `qwen3:8b` present.

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

**E1 status.** Merged: engine PR #12 (D-118), merge commit `8b1a766`. `ENGINE_REF` stays at `573ebdd` until UI-A, the first UI PR that uses E1, bumps it. Each UI PR pins the engine merge it needs.

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
