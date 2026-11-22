# Milestone 2 — Editorial Workspace, Draft Editing and G1 Approval

**Status:** implementation specification; engine edit capability is a prerequisite. **Goal:** review, edit, validate and explicitly approve a documentary outline and script in the browser, while the `youtube-agent` engine remains the sole authority for artifacts and approval state.

## Existing baseline
M1 provides a local Next.js/FastAPI UI, project workspace, draft generation jobs, read-only outline/script viewer, engine `draft-check --json`, engine status, SSE and durable jobs. M2 reuses its shell, API security, project confinement and job infrastructure.

The UI roadmap defines M2 as **script/outline editing, validation and editorial approval (G1)**. Engine documentation at the pinned M1 revision (`d1325c4`) describes `outline.json` and `script.json` as human-editable, `.md` as generated views, and `draft-approve --project-root ... --reviewer NAME` as the engine-owned approval command. Approval binds SHA-256 hashes of `input.json`, `outline.json`, `script.json` and `storyboard.draft.json`; subsequent changes make approval stale. The engine documents manual JSON editing, **not an authenticated/transactional editing CLI**. Verify all commands and schemas against the current engine revision before implementation.

## Critical dependency — safe engine-owned edits
The M1 boundary forbids UI/backend from writing engine-owned artifacts directly. **Do not implement browser saving by `open(..., 'w')`, filesystem replace, or by inventing CLI flags.** First inspect the current engine for a supported safe edit API/CLI. If absent, prepare a separate, reviewed engine PR introducing narrowly scoped operations such as `draft-edit-outline` / `draft-edit-script` (names illustrative, not verified), with these properties:
- Validate the same Pydantic schemas and cross-artifact invariants used by the engine; reject unsupported fields and unknown IDs.
- Accept structured patch/input through a bounded, safe transport (e.g. stdin JSON); never use shell interpolation or arbitrary filesystem paths.
- Lock the project, recover any pending publication journal, check an expected revision/hash for optimistic concurrency, and reject concurrent or stale edits with a stable conflict response.
- Preserve unrelated fields, IDs and sections; atomically publish the edit plus any engine-required derived views/metadata. Never leave `.json` and `.md` inconsistent.
- Protect user edits from future LLM regeneration; ensure the engine's manifest/cache/edit protection understands the change.
- Invalidate G1 approval when its bound content changes, and expose the actual engine approval state.
- Avoid silent storyboard/script divergence: document and implement how scene narration, storyboard draft, and downstream artifacts are synchronized or invalidated when script narration changes.
- Support a dry-run validation or clearly separate schema validation from persisted edits.
- Add real-engine integration tests. Pin the minimum compatible engine revision in UI docs and CI.

If the engine cannot be changed, **M2 may ship read-only review, check and approve only**; do not label it an editor or claim M2 complete.

## User journey
1. Open a drafted project and choose **Edit Draft**.
2. Review outline sections and script narration side by side; navigate by stable section IDs.
3. Edit permitted fields, see unsaved changes, save explicitly, and receive the new engine revision/hash.
4. Run **Validate Draft** and inspect engine errors, warnings, timing and review blockers.
5. Correct blockers, then enter a reviewer name and explicitly confirm **Approve Editorial Draft (G1)**.
6. Backend invokes engine `draft-approve`; UI reloads `draft-check` and `production-status` to show the actual approval state.
7. Any subsequent edit makes approval stale according to engine rules; the UI never displays stale approval as current.

## M2-01 — Compatibility and engine editing contract
- Inspect `ytagent draft-approve --help`, `draft-check --help`, draft schemas, lock/journal behavior, approval invalidation and current editing capabilities.
- Record exact flags, JSON output, exit codes, artifact hashes, edit semantics and tested engine commit in `docs/engine-compatibility.md`.
- Resolve the safe engine edit dependency as described above, via separate engine PR if needed; do not modify the engine as an undocumented side effect of the UI PR.
- Tests: real-engine edit, stale revision, malformed input, concurrent edit, invalid section ID, crash recovery, regeneration protection and approval invalidation.

## M2-02 — Backend API and concurrency
Proposed `/api/v1` additions (final payloads depend on verified engine capability):
- `GET /projects/{id}/draft/editable` — structured editable document, allowed fields, revision token and approval state.
- `PUT /projects/{id}/draft/outline` — save validated outline patch with required expected revision.
- `PUT /projects/{id}/draft/script` — save validated script patch with required expected revision.
- `POST /projects/{id}/draft/validate` — invoke engine check (or reuse GET draft-check when read-only), return exact engine report.
- `POST /projects/{id}/draft/approve` — reviewer name and explicit confirmation; call `draft-approve` with allowlisted args; return engine-derived approval status.

Requirements:
- Same-origin/CSRF on mutations; safe slug/root confinement and no arbitrary path/file API.
- Strict field/length/schema validation, request-size limits, Unicode/Vietnamese support.
- 409 on revision conflict or active mutating job; return latest revision and a clear conflict message. Do not auto-overwrite.
- No approval during active draft generation or unsaved edits; server checks the actual engine state, not frontend assumptions.
- Approval command is a short controlled subprocess with group termination and sanitized errors.
- UI-owned SQLite may store editor preferences only; never copy authoritative draft or approval data into UI state as truth.
- Tests: CSRF, path confinement, stale revision, concurrent save, engine unavailable, engine gate failure, malformed payload and successful approval.

## M2-03 — Editorial workspace UI
Route: retain `/projects/[projectId]/draft`, extending the M1 viewer into a review/edit workspace.

Desktop layout:
```
┌────────────────────────────────────────────────────────────────────┐
│ Projects / Project / Draft       Draft status · G1 Not approved    │
│ [Outline] [Script] [Validation]          [Save] [Validate]        │
├────────────────────┬───────────────────────────────────────────────┤
│ Section navigator  │ Selected section                              │
│ 01 Introduction    │ Heading / purpose / key points or narration   │
│ 02 Context         │ Editable structured fields                   │
│ 03 Analysis        │ Word/syllable count · timing estimate         │
│ ...                │ Review flags / notes                           │
├────────────────────┴───────────────────────────────────────────────┤
│ Validation: errors, warnings, review blockers, approval state      │
│ Reviewer name [____________]  [Approve Editorial Draft (G1)]      │
└────────────────────────────────────────────────────────────────────┘
```
- Outline tab: sections, heading, purpose, key points, claims to investigate, estimated duration where engine permits.
- Script tab: section heading, narration, summary, review flags and editable notes where permitted.
- Validation tab: actual engine `draft-check` result; separate blocking errors from warnings; show timing and changed approval inputs.
- Dirty state: unsaved indicator; disable approval until saved and validated; warn before navigation away.
- Save: pending state, success feedback, conflict dialog with **Reload latest** and **Copy my edits**; never silently discard or overwrite.
- Approval: reviewer name required, confirmation dialog clearly saying editorial acceptance **does not verify historical claims, rights or release readiness**. Refresh approval state after engine response.
- Responsive: stacked section navigator/editor below 1024px; keyboard accessible; 200% zoom; WCAG 2.2 AA where practical.
- Preserve Vietnamese diacritics and long paragraphs. No HTML execution from generated content.

## M2-04 — Validation and G1 approval
- Run `draft-check --json` using the engine and show `ok`, `errors`, `warnings`, `review_blockers`, `approval_status`, `approval_changed`, timing and section details when present.
- Distinguish check validity from approval: `ok=true` is **not** G1 approval.
- Approval must use verified `draft-approve --project-root ... --reviewer ...`; do not write `review.json` from UI.
- On success, fetch fresh `draft-check` and `production-status`; show the engine's current gate, not a locally guessed success flag.
- Any changed bound artifact must make previous approval stale. Require explicit reapproval.
- Never auto-advance to research or run other stages after approval.
- Tests: missing reviewer, blockers, stale hashes, concurrent mutation, approval success and later invalidation.

## M2-05 — Tests, CI and handoff
- Backend unit/integration tests for edit contract, revision conflicts, schema safety, G1 CLI invocation and sanitized errors.
- Frontend component tests for dirty state, save failures, validation, approval confirmation and keyboard navigation.
- Playwright: edit outline, edit Vietnamese script, validate, approve, reload, change text, verify approval stale, reject conflicting save.
- Run real-engine fixture integration tests against a pinned revision; if engine secret unavailable, fail a required job rather than silently reporting it as passed.
- Preserve M1 tests and no paid/network dependencies.
- Update `docs/api-contract.md`, `docs/ui-design.md`, `docs/engine-compatibility.md`, `docs/m2-verification.md`, and README.

## Non-goals
Research evidence and G2 approval (M3), visual candidate selection (M4), narration, rendering, publishing, cloud access, multiuser collaboration, AI auto-rewriting, arbitrary JSON editor, direct engine filesystem writes, bypassing approvals, automatic research after G1.

## Definition of done
- [ ] Verified safe engine edit interface exists and is documented, or M2 remains explicitly blocked.
- [ ] Browser can edit and save permitted outline/script fields without direct engine-file writes.
- [ ] Edits preserve IDs, artifact consistency, human edit protection and optimistic concurrency.
- [ ] Real draft-check output is visible with actionable errors/warnings.
- [ ] Named reviewer can explicitly approve G1 through the engine.
- [ ] Approval becomes stale after bound edits and never appears falsely current.
- [ ] M1 flows remain functional; all automated tests and pinned real-engine CI pass.
- [ ] PR reviewed, no automatic merge.

## Claude Code handoff
Read `CLAUDE.md`, `docs/architecture.md`, `docs/engine-compatibility.md`, `docs/api-contract.md`, `docs/ui-design.md`, and this file. Start with **M2-01** and verify the engine's actual edit/approve interfaces before implementing UI saves. If no safe engine editing operation exists, stop at the dependency and propose a separate engine PR; do not directly write engine-owned artifacts. Implement M2 incrementally with tests and an updated compatibility record. Use a feature branch and draft PR; do not merge automatically.
