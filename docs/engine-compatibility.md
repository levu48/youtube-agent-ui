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
