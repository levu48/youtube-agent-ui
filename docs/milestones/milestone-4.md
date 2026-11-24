# Milestone 4 — Visuals: Plan, Candidate Gallery, Rights and Selection (G3)

**Status:** specification. The engine needs prerequisite PRs (V1, V2) before the UI can drive this stage; none is started. Engine facts below were verified read-only at engine `main` `fb6bffc` (the pinned `ENGINE_REF`), including an offline probe with the fixture and mock providers.

**Goal:** a reviewer can choose one or more images for every scene of an approved draft in the browser, see each image's licence evidence, record rights clearances where a licence cannot be verified automatically, and apply the selection to the draft, with the `youtube-agent` engine as the only authority. This covers:
- the visual plan (one planned visual per scene, with its kind and search query);
- explicit, host-confirmed image search on Wikimedia Commons;
- a candidate gallery with previews, licence evidence and the engine's warnings;
- importing an image the reviewer owns or has cleared;
- per-scene selection (shots), and human rights clearances bound to the exact image bytes;
- validation, apply (which makes G1 out of date), and G3 as the engine computes it.

**Numbering.** The engine also calls this stage **M4** (`docs/milestone-4-visuals.md`, decisions D-58…D-75). This document uses the UI numbering, which happens to match.

## Existing baseline

**Engine (`fb6bffc`).** Five commands. The parser is `cli.py:239-317`; the handlers are `cli.py:1260-1415`.
- `visuals-plan` writes `visual-plan.json` (`m4-visual-plan-0.1`, one entry per scene). It needs a current G1 (exit 12) and uses no network. `--replace-plan` regenerates a hand-edited plan.
- `visuals-acquire` searches and/or generates candidates.
  - `--search-provider {none,fixture,wikimedia}`: Wikimedia contacts `commons.wikimedia.org`, `upload.wikimedia.org` and `thumb.wikimedia.org`, behind an HTTPS host allowlist (`host_not_allowed`).
  - `--image-provider {none,mock,openai}`: openai is paid and needs `--allow-paid` and spend limits.
  - Also: `--scene`, `--force` (re-download; may pay again), `--max-candidates-per-scene`, `--concurrency`, `--timeout`.
  - It writes `render/visuals/candidates.json`, `provenance.json` and per-scene contact sheets, and an **empty** `visual-selection.json` template.
- `visuals-import --scene --file PATH --kind --provenance [--source-url --creator --license-name --license-url --attribution]` copies a still image (JPEG, PNG, WebP or TIFF) into the project. Imports are always `rights: manual_review`.
- `visuals-check [--json]` validates the plan and selection and **writes** `render/visuals/visual-report.{json,md}`. Exit codes: 0 ready, 11 not ready, 2 errors, 12 approval problem.
- `visuals-apply --reviewer` publishes `storyboard.draft.json` (only `scenes[].shots`), `assets.json` (with `assets/images/<sha256>.<ext>`) and `render/visuals/applied.json` as one generation.
  - It refuses to overwrite human-authored shots or assets without `--replace-shots` / `--replace-assets`.
  - Afterwards G1 is `stale_after_apply` and the draft `revision` changes.

**Rights policy (D-61, D-62, D-72, D-73).**
- Each candidate has `rights` evidence: `status` `accepted`, `manual_review`, `rejected` or `not_applicable`, plus licence, creator, credit line, restrictions, reasons and field findings.
- A licence is verified by complete metadata (`licence_metadata`), or by a human clearance of a `manual_review` image (`human_attestation`).
  - A clearance is bound to the candidate's `sha256` and a rights fingerprint, and needs an exact acknowledgement text.
- Placeholder, mock and fixture images are never publishable.
- Chart scenes are import only. Archival and document scenes are never generated.

**G3.** `production-status` reports `G3 visuals: pending | needs_review | ready`, computed live by `gates.visuals()`. **Nothing approves G3 explicitly.** It is `ready` once every scene is render-ready, there are no errors and nothing is unpublishable. Its findings are `visuals_not_started`, `visuals_invalid`, `visuals_selection_needed` and `image_rights_not_cleared`. It goes stale when the draft content changes after planning (D-59).

**UI.** M1–M3 are merged (UI `main`, `ENGINE_REF` `fb6bffc`). M4 reuses:
- the job runner, SSE and cancellation;
- `_engine_write` (project held, refusals mapped);
- the preview-and-confirm-hosts pattern from research collection;
- the snapshot-reader pattern for engine-owned files, read only and hash-verified;
- M2's G1 re-approval flow.

## Critical dependency — engine capabilities (V1, V2)
The UI never writes, moves or deletes engine-owned files, never passes a user-supplied path, and never passes force, replace or paid options. At `fb6bffc` a browser cannot drive visuals safely:
- **No selection command.** Selection and rights clearances can only be recorded by hand-editing `visual-selection.json` (`visuals/models.py:273-283`); so can narrowing the plan (D-61).
- **No JSON or revisions.** Only `visuals-check` prints JSON, and its failures do not use the JSON error envelope. No visuals command takes an expected revision or reports one.
- **The check writes files.** `visuals-check` writes the report under the lock, and there is no read-only visuals CLI.
- **No network control.** `visuals-acquire --search-provider wikimedia` contacts the network with no host confirmation and no preview of what it would contact.
- **Import takes a path.** `visuals-import --file` takes an arbitrary filesystem path.

Two engine PRs in `youtube-agent`, each with a decision entry, README update and tests, are reviewed and merged before the UI PR that needs them. If one cannot land, the UI ships only what the merged capabilities allow and does not claim M4 complete.

### V1 — visuals CLI contract (no policy change)
- **Visuals revision.** A read-only `visuals-check --json --no-write` (or an equivalent read command) reports the engine's evaluation plus `revision`.
  - `revision` is sha256 over the visuals-bound files: `visual-plan.json`, `visual-selection.json`, `render/visuals/candidates.json`, `provenance.json`, `applied.json`, and the draft revision the plan was made from.
  - It prints no report file and takes no lock beyond a consistent read.
- **`--json` and the JSON error envelope** (`{ok:false, error:{code, exit_code, message, details?}}`) on `visuals-plan`, `visuals-acquire`, `visuals-import`, `visuals-check` and `visuals-apply`, with stable codes: `revision_mismatch`, `g1_not_current`, `human_edit_conflict`, `host_not_allowed`, `invalid_input`, `not_ready`.
- **`--expect-revision`** on every visuals mutation. `visuals-acquire` re-checks it after the network phase, as research collect does (D-118).
- **Network control for acquire.**
  - `visuals-acquire --dry-run --json` lists the exact hosts a run may contact and the scenes and queries it would search, without contacting anything.
  - `--allow-host` (repeatable) is required for any network provider; any other host, or a redirect to one, is refused.
- **Import from stdin.** `visuals-import --stdin` reads the image bytes from standard input (size-limited, decoded and hashed like any download), so no filesystem path crosses the boundary. The other flags are unchanged.
- **Progress.** One line per scene searched, downloaded or rejected on a progress logger, as research collection does.

### V2 — `visuals-edit`: selection, clearances and plan narrowing
- `visuals-edit --expect-revision=R --json [--dry-run]`, with a strict patch `{"operations": [...]}` on stdin (no nulls, no unknown fields, at most 1 MiB). All operations are applied and published atomically, or none are.
- **Operations:**
  - `shots.set {scene_id, shots: [{candidate_id, motion?, fit?, duration_seconds?}]}` and `shots.clear {scene_id}`;
  - `clearance.set {candidate_id, reviewer, basis, justification, evidence, acknowledgement}`, bound by the engine to the candidate's current `sha256` and rights fingerprint, and `clearance.revoke {candidate_id, reviewer, reason}`;
  - `plan.update {scene_id, search_query?, search_enabled?, generation_enabled?, notes?}`, narrowing only (D-61).
- **Validation.** The engine applies the same validation as `visuals-check` and `visuals-apply` (selectable candidate, intact bytes, destination-scene policy, placeholder clearances, exact acknowledgement). Refusals are `invalid_patch` with `details[{loc, msg, code}]`.
- **History.** Replaced or revoked clearances are kept in an append-only, hash-chained history (as research reviews are, D-119), because a clearance is a legal attestation.

## User journeys
1. **Plan visuals.** With a current G1, the Visuals page offers **Plan visuals** (`visuals-plan`), a job with no network. The page lists every scene with its kind, search query, and whether it needs a human-provided image.
2. **Narrow the plan** (optional). Edit a scene's search query, or turn search or generation off. Generation is shown as unavailable: no paid provider in M4.
3. **Search Wikimedia Commons.** The backend asks the engine for the acquire preview at the loaded revision. The dialog lists exactly those hosts. After the reviewer confirms them, acquisition runs as a job with live logs. Nothing is contacted before confirmation, and `YTA_VISUALS_NETWORK=false` refuses it.
4. **Review candidates.** A gallery per scene shows previews (served read-only by the backend), title, source page, creator, licence, credit line, restrictions, the engine's rights status and reasons, and labels for placeholder or mock images ("Test image: never publishable").
5. **Import an image.** Upload a still image with its provenance (kind, provenance statement, source URL, creator, licence and attribution). The engine adds it as a `manual_review` candidate.
6. **Select.** Choose one or more candidates per scene, optionally with motion, fit and duration. Each save runs `visuals-edit` under the loaded revision.
7. **Clear rights.** For a `manual_review` candidate, record a clearance: basis, justification, evidence, the reviewer's name, and the exact acknowledgement text shown verbatim. It can be revoked later.
8. **Validate and apply.**
   - **Validate visuals** shows the engine's report: per-scene readiness, errors, warnings, unpublishable images and publication blockers.
   - **Apply selection** runs `visuals-apply --reviewer` with the validated revision. It warns first that G1 will go out of date, then links to the G1 re-approval.
9. **G3.** The page shows G3 exactly as `production-status` reports it. There is no G3 approve button, because the engine has no G3 approval.
10. **Use the CLI** at any step. A change made there appears as a revision conflict or a new state, never as a silent overwrite.

## M4-01 — Compatibility and engine contract
- V1 and V2 are separate engine PRs, reviewed and merged in that order. Each UI PR pins its minimum engine in `ENGINE_REF`.
- `docs/engine-compatibility.md` records every flag, JSON shape, exit code and error code against the merged engine, with a real-engine probe.
- The UI's capability list grows only with commands the pinned engine actually has. An older engine shows a truthful "not supported by this engine" state.

## M4-02 — Backend API (`/api/v1`; CSRF and origin on every mutation)
Every write holds the project (`409 job_conflict` / `project_busy`), carries `expected_revision`, and returns the refreshed visuals view. Refusals map as in M3.
- `GET /projects/{id}/visuals`: the engine's read-only evaluation (with `revision`), the plan, candidates (with rights evidence, previews and labels), the selection, clearances, `gates {g1, g3}` from production-status, `network`, `editing` and `active_job_id`.
- `GET /projects/{id}/visuals/images/{kind}/{name}`:
  - serves candidate images and contact sheets read only;
  - `kind` is one of `candidates`, `previews` or `assets`, and `name` matches `^[a-z0-9-]{1,80}\.(jpg|jpeg|png|webp)$` (TIFF is served as its engine-made preview);
  - the file is confined to the project, hash-checked against the catalogue, and sent with `Content-Type` from the decoded format, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`. SVG is never served.
- `POST /projects/{id}/visuals/plan {expected_revision}` → a job.
- `POST /projects/{id}/visuals/acquire/preview {expected_revision, scene_ids?, max_candidates_per_scene}` → hosts, scenes and queries.
- `POST /projects/{id}/visuals/acquire {…, network: true, preview_sha256, allow_hosts}` → a job. `allow_hosts` must equal the preview's hosts, and is re-checked immediately before the run.
- `POST /projects/{id}/visuals/import`, multipart:
  - the image (≤ 25 MB; JPEG, PNG, WebP or TIFF, checked by magic bytes), `scene_id`, `kind`, `provenance`, and optional `source_url` (https), `creator`, `license_name`, `license_url` (https) and `attribution`;
  - the bytes go to `visuals-import --stdin` and are never written by the UI.
- `POST /projects/{id}/visuals/edit {expected_revision, operations, dry_run?}` → `visuals-edit`.
- `POST /projects/{id}/visuals/apply {expected_revision, reviewer, confirm: true}` → `visuals-apply --expect-revision`. Never `--replace-shots` or `--replace-assets`: a human-edit conflict is shown and left for the CLI.

## M4-03 — Visuals workspace UI (`/projects/[projectId]/visuals`)
- **Navigation.** The sidebar's **Visuals** entry becomes live. The project page's next step leads here once G2 is applied and G1 is current, or straight after G1 when research is not used.
- **Layout.**
  - **Scenes:** one card per scene, with narration, brief, kind, selection and readiness.
  - **Gallery:** per scene, candidates in a responsive grid with keyboard selection, alt text from the title and brief, and a large preview dialog.
  - **Validation:** the report, unpublishable images, credits, and apply.
- **Honesty.**
  - Rights status and reasons are the engine's.
  - "Publishable" is never shown for placeholder, mock or `manual_review` images without a clearance.
  - Generated images (if ever present) carry the engine's disclosure label.
  - Progress is the engine's log lines, never a percentage.
- **Accessibility:** WCAG 2.2 AA, as in M1–M3. Images need text alternatives; the selection state is never conveyed by colour alone.

## M4-04 — Validation, apply and G3
- **Apply** sends the revision the reviewer last validated. Any change in between, from the UI, the CLI or a job, is refused by the engine.
- **After apply,** G1 shows as out of date until `draft-approve` runs again (M2's flow). Apply also changes the draft revision, so any open draft editor reloads.
- **G3** is shown as production-status reports it, and is never inferred or "approved" by the UI.
- **Nothing runs automatically.** Nothing advances to narration or rendering.

## M4-05 — Security
- **Unchanged:** loopback binding, host and origin checks, CSRF on every mutation.
- **Argv.**
  - Allowlisted per operation. No `shell=True`, and no user-supplied flag, path or executable.
  - Excluded: force, replace and paid options (`--force`, `--replace-plan`, `--replace-shots`, `--replace-assets`, `--allow-paid`, `--image-provider openai`).
  - User text travels as single argv elements; image bytes and patches go on stdin.
- **Network.**
  - Only hosts the reviewer confirmed for that acquisition, from an engine preview at the same revision. The engine enforces this with `--allow-host` on every request and redirect.
  - `YTA_VISUALS_NETWORK=false` refuses every network action. The backend never fetches anything itself. No paid services and no API keys.
- **Untrusted content.** Image files, titles, licence text, creators and source URLs are untrusted.
  - Images are served only from engine-made files, hash-checked, never as SVG or HTML.
  - Text is rendered as text, and links carry `rel="noopener noreferrer"`.
  - None of it is ever used in a command line.
- **Uploads.** At most 25 MB, magic-byte checked, streamed to the engine on stdin, and never stored by the UI.

## M4-06 — Tests, CI and handoff
- **Backend.**
  - The argv builders and the excluded flags.
  - The preview-bound host confirmation (stale revision, changed hosts), and network disabled.
  - The image endpoint: pattern, traversal, hash mismatch, content type, no SVG.
  - Upload limits and magic bytes, and the edit request models.
  - The error mapping, and `exclusive`.
  - A fake engine extended with V1/V2 JSON, errors and race modes.
- **Real-engine integration (required, offline).** A successful G3 on non-fixture images:
  1. create, fixture draft, narration rewritten and attested (as in M3's G2 test), G1;
  2. `visuals-plan`;
  3. import a **genuinely public-domain or openly licensed image** for every scene, with full provenance;
  4. clear the rights of each `manual_review` import;
  5. select a shot per scene, check, and apply (G1 now out of date);
  6. `draft-approve`.

  The CLI then reports `G3 visuals: ready` and G1 approved. The images are committed under `backend/tests/fixtures/visuals/` with a `SOURCE.md` giving the Commons file page, the revision or upload date, the licence and the attribution.
- **Negative paths:**
  - a stale revision on every mutation, including acquire after the network phase (fixture provider);
  - `host_not_allowed`;
  - a placeholder image never shown as publishable;
  - a clearance refused for a wrong acknowledgement, and stale after the image bytes change;
  - a chart scene refusing a non-imported image;
  - a human-edit conflict on apply, shown and not overwritten;
  - a CLI hand edit producing a UI conflict.
- **Frontend component tests:**
  - selection, and its keyboard and focus;
  - the clearance form, with the exact acknowledgement and no prefill;
  - labels for placeholder and mock images;
  - the host-confirmation dialog;
  - apply's G1 warning;
  - conflict and recovery.
- **E2E (fake and real engine).** The journey above, with axe WCAG 2.2 AA on every tab and dialog; 1440, 768 and 375 px; 200% zoom; reduced motion.
- **CI.** The real-engine script minimums rise, and `ENGINE_REF` is bumped per UI PR. A live Wikimedia smoke test is recorded by hand in `docs/m4-verification.md`, not in CI.

## Delivery plan (independently reviewable PRs; none merged automatically)

```
UI-0 (this spec) ─► V1 engine: visuals CLI contract ─► V2 engine: visuals-edit (selection, clearances, plan)
                      └─► UI-A read-only workspace, plan job, previewed Wikimedia acquire, gallery, import   (needs V1)
                                                   V1 + V2 ─► UI-B selection, clearances, plan narrowing, validation, apply, G1 again, G3
```

| PR | Repository | Depends on | Content | Verified by |
|---|---|---|---|---|
| UI-0 | UI | none | this specification and the roadmap | review |
| V1 | engine | UI-0 reviewed | visuals revision and read-only check; `--json` and the error envelope; `--expect-revision` (acquire re-checked after the network phase); acquire `--dry-run` host preview and `--allow-host`; `visuals-import --stdin`; progress | engine pytest |
| V2 | engine | V1 | `visuals-edit` (shots, clearances with history, plan narrowing), strict patch, atomic publication | engine pytest |
| UI-A | UI | V1 | the visuals view and image endpoint, plan job, preview-confirmed acquire job, gallery, import upload, navigation | backend, frontend, E2E, real-engine script, CI |
| UI-B | UI | V1, V2 | selection, clearances (with history), plan narrowing, validation, apply with the G1 warning and re-approval link, G3 display; the required real-engine G3 success test with genuinely licensed images | same, plus the manual live Wikimedia smoke test |

## Non-goals
- Paid image generation, API keys, OpenAI or any chargeable call: the UI never offers `--image-provider openai` or `--allow-paid`.
- Narration audio, rendering and publishing (M5, M6).
- Image editing, cropping or upscaling in the browser.
- Editing tool-owned files (`candidates.json`, `provenance.json`, `applied.json`, the report) or the draft from the visuals page.
- Bypassing licences, robots or access controls.
- Force or replace flags, and `resume`.

## Definition of done
- [ ] V1 and V2 are merged in the engine and recorded in `engine-compatibility.md`. `ENGINE_REF` pins the minimum.
- [ ] The browser performs every visuals action only by invoking supported engine commands. The UI and backend never write, move or delete engine-owned files directly; reading documented artifacts is the only direct file access.
- [ ] Network requests go only to hosts the reviewer confirmed for that specific acquisition, from an engine preview at the same revision. With `YTA_VISUALS_NETWORK=false` there are none. No paid call is possible from the UI.
- [ ] Every mutation, including acquire after its network phase, is checked against the revision the reviewer loaded. Conflicts never overwrite.
- [ ] Rights status and reasons are the engine's. Placeholder, mock and uncleared `manual_review` images are never shown as publishable. Clearances are bound to the image bytes, need the exact acknowledgement, and are kept in history when replaced or revoked.
- [ ] Imports reach the engine only as bytes on stdin, size- and format-checked; no path crosses the boundary.
- [ ] Apply warns about G1 and leads to re-approval. G3 is shown as the engine reports it, never approved or inferred by the UI.
- [ ] The required real-engine test reaches `G3 visuals: ready` offline with genuinely licensed images. M1–M3 flows still pass, and CI and the real-engine script pass.
- [ ] The gallery and forms meet WCAG 2.2 AA at all three widths, at 200% zoom and with reduced motion.
- [ ] Each PR is reviewed, with no automatic merge.

## Claude Code handoff
- **Read first:** `CLAUDE.md`, `docs/architecture.md`, `docs/engine-compatibility.md`, `docs/api-contract.md`, `docs/ui-design.md`, this file, and the engine's `docs/milestone-4-visuals.md` and decisions D-58…D-75.
- **Order:** V1, V2 on engine feature branches, then UI-A, UI-B.
- **Verify engine facts** again at the current engine `main` before relying on them, and never invent adapter flags the engine lacks.
- **Process:** each PR is a draft with its own tests and docs, merged only on the owner's explicit request.
