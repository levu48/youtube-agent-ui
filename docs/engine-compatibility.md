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

**Tested engine:** `levu48/youtube-agent` `main` @ `d1325c4` (`ytagent 0.1.0`). This revision is pinned in [`ENGINE_REF`](../ENGINE_REF) and checked by `scripts/test-real-engine.sh` and CI, Python venv at `<engine>/.venv`, uv 0.13.6, macOS arm64. Ollama 11434 with `qwen3:8b` present.

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

## Milestone 2 findings (2026-11-21, engine `d1325c4`)

Verified against a read-only clone of `youtube-agent` at `d1325c44ac04e0495f4bc42976d3058cd4d43467` (`ytagent 0.1.0`). `origin/main` had no newer commits.

### Editing: no supported command at this revision
The engine has no CLI for editing drafts. Its docs describe `outline.json` and `script.json` as human-editable by hand, but hand edits cannot be made safely from the UI:
- **Hash links make dependents stale.** `script.json` records `outline_sha256` and `input_sha256`, and `storyboard.draft.json` records `script_sha256` and `outline_sha256`. Changing the outline makes the script and storyboard stale; that is an error, and approval is refused.
- **Narration is stored twice.** It lives in `script.json` sections and again, split into scenes, in `storyboard.draft.json`. `spoken_units` and `estimated_duration_seconds` are derived from it, and `outline.md`/`script.md` are generated views.
- **Edit protection is based on bytes.** A file whose bytes differ from the engine's manifest counts as `edited` and is protected from regeneration (see the `state` of each entry in `draft-check --json` `artifacts`).

Browser editing therefore waits for an engine `draft-edit` command (a separate engine PR). The UI does not write any engine file.

### `draft-approve` (G1)
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
