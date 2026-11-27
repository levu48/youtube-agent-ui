# Milestone 4 — Visuals: Plan, Candidate Gallery, Rights and Selection (G3)

**Status:** specification; owner decisions approved 2026-11-23. The engine needs two prerequisite PRs (V1, V2) before the UI can drive this stage.
- **V1 is merged:** engine PR #16 (decision D-122), merge commit `65c5f52`, now the pinned `ENGINE_REF`. The V1 section below matches the merged engine, including its three review rounds. The facts are recorded in [engine-compatibility.md](../engine-compatibility.md) with an offline CLI probe.
- **UI-A is merged** (UI PR #16): the read-only workspace, image endpoints, plan job, preview-bound search, gallery and import, against `65c5f52`.
- **UI-B is implemented** on branch `feat/m4-ui-b` (draft PR), against `26c608f`: selection, bound clearances with history and revocation, plan narrowing, validation and apply, and the real-engine G3 success test with public-domain images. The manual live Wikimedia smoke test is still to be recorded in [m4-verification.md](../m4-verification.md).
- **V2 is split in two engine PRs.**
  - **V2a is merged:** engine PR #17 (D-123), merge commit `c089089`. It covers `visuals-edit`, the clearance history, and the decision that changed evidence invalidates a clearance.
  - **V2b is merged:** engine PR #18 (D-124), merge commit `26c608f`, now the pinned `ENGINE_REF`. It is the decision-5 G3 and release change.
  - Both are verified with offline CLI probes in [engine-compatibility.md](../engine-compatibility.md).
- The baseline sections ("Existing baseline", "Selection, apply, rights and G3 at `fb6bffc`") describe the engine before V1. They were verified read-only at `fb6bffc`, and V1 changes none of their gate or rights policy.

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
- Downstream, read-only: `production-status [--json]` and `production-check --mode preview|release [--json]` (exit 16 with blockers). `draft-export` writes `storyboard.json` from the approved draft.

**Rights policy (D-61, D-62, D-72, D-73).**
- Each candidate has `rights` evidence: `status` `accepted`, `manual_review`, `rejected` or `not_applicable`, plus licence, creator, credit line, restrictions, reasons and field findings.
- A licence is verified by complete metadata (`licence_metadata`), or by a human clearance of a `manual_review` image (`human_attestation`).
  - A clearance is bound to the candidate's `sha256` and a rights fingerprint, and needs an exact acknowledgement text.
- Placeholder, mock and fixture images are never publishable.
- Chart scenes are import only. Archival and document scenes are never generated.

**UI.** M1–M3 are merged (UI `main`; their engine was `fb6bffc`, `ENGINE_REF` was `65c5f52`, the V1 merge, for UI-A, then `c089089` for V2a, and is now `26c608f`, the V2b merge). M4 reuses:
- the job runner, SSE and cancellation;
- `_engine_write` (project held, refusals mapped);
- the preview-and-confirm-hosts pattern from research collection;
- the snapshot-reader pattern for engine-owned files, read only and hash-verified;
- the "validated at revision R" binding and query-cache subscription from M3's G2 panel;
- M2's G1 re-approval flow.

## Selection, apply, rights and G3 at `fb6bffc` (verified)
These are the engine's semantics today, read from the code. The UI displays them; it does not redefine them.

| Concept | Where it lives | Semantics |
|---|---|---|
| **Selection** | `visual-selection.json` `scenes[].shots[{candidate_id, motion?, fit?, duration_seconds?}]` | A human's choice, recorded only by hand-editing at `fb6bffc`. Nothing selects automatically. |
| **Clearance** | `visual-selection.json` `rights_clearances[]` | A `manual_review` candidate's human attestation, bound to `candidate_sha256` and `rights_fingerprint` (`visuals/rights.py:486-550`, `clearance_problems` at 506). A clearance that no longer matches (other bytes, changed evidence, wrong acknowledgement) is an **error** that fails closed: `visuals-check` lists it, G3 gets `visuals_invalid`, apply refuses (`agents/visuals.py:1052-1080`). Removing a clearance is not recorded anywhere. |
| **Validation** | `_evaluate` (`agents/visuals.py:1138-1300`) | Per scene: every selected candidate must exist, be `available`, pass `blob_ok`, be planned, and satisfy the destination policy. A scene is `render_ready` either `via selection` (all its selected shots valid) or `via existing_shots` (**nothing selected** and the draft already has shots). Rights are checked only for selected candidates; an unverified one becomes an `unpublishable` entry. Existing draft shots get no rights or byte check here. |
| **Apply** | `visuals_apply` (`agents/visuals.py:1374-1530`) | Writes shots for scenes with a selection; scenes without one keep their draft shots. Assets are `img-<sha256[:16]>` at `assets/images/<sha256>.<ext>`, with `rights_verified`/`rights_basis` **frozen at apply time**. `applied.json` records `selection_sha256`, the shots written per scene, the SHA-256 of each asset **record**, and the clearances used. Apply publishes even if some rights are unverified (`rights_unverified`). It does not clear the selection. If nothing in the draft or `assets.json` would change it returns `already_current` **before** installing images, so a missing asset image is not restored. An existing `assets/images/<sha>.<ext>` whose bytes do not match its name is refused and left untouched (`store_blob`). |
| **Applied image integrity** | `asset_problem` (`production/preview.py:47-70`) | An asset is showable only if it is in `assets.json`, `rights_verified`, its record's hash equals `applied.json` `assets[id]`, and its file exists with bytes matching the content address in its name. So the chain `applied.json` → record hash → `local_path` → file name hash → bytes already binds applied image bytes; **no separate image hash is needed**. |
| **G3** | `gates.visuals()` (`production/gates.py:299-344`) | `pending` without `visual-plan.json`; otherwise `ready` iff `visuals_evaluate` is `render_ready` with no errors and no `unpublishable` entries. Findings: `visuals_not_started`, `visuals_invalid`, `visuals_selection_needed`, `image_rights_not_cleared`. **G3 does not look at the draft's shots for scenes with a selection**, so it can be `ready` before any apply, or after the selection changed since the last apply. (Its own message for `visuals_selection_needed` says "no selected, applied image".) |
| **G1 after apply** | `gates.editorial()` (`gates.py:184-200`) | Apply changes `storyboard.draft.json` and `assets.json`, so G1 is `stale_after_apply` (a warning) until `draft-approve`. Visuals commands only require that input, outline and script match the approval, so selecting and applying again need no G1 re-approval first. G3 does not depend on G1. |
| **Release eligibility** | `release_findings` (`orchestrator.py:826-850`), `release_storyboard` (`gates.py:347-410`) | Release needs G1 `approved`, G3's blockers clear, and `storyboard.json` to be the current export of the approved draft. Only then is every shown asset checked with `asset_problem`, the fixture-media rule and `credit_problems` (`image_not_releasable`, `fixture_image`, `credit_incomplete`). Before `draft-export`, the image checks do not run at all (`storyboard_export_stale` returns first). |

**Gaps this leaves, all verified:**
1. **G3 ≠ applied.** A valid selection that was never applied, or was changed after apply, gives `G3 ready` while the draft shows other images or none.
2. **Revocation after apply.** The asset keeps `rights_verified: true`. If the selection still names the candidate, G3 reports `image_rights_not_cleared`. If the selection was cleared or changed, the scene is ready (via existing shots, or via the new selection) and release's `asset_problem` passes on the frozen flag. So a revoked image can reach release.
3. **Applied bytes.** A corrupted or missing applied image with an intact candidate passes G3; it is caught only by `release_storyboard`, after export. Re-applying does not repair either case: a missing image gives `already_current`; a corrupted one is refused.

V1 reports these facts; V2 closes gaps 1 and 2 in the gate (owner decision 5). The UI never closes them itself.

## Critical dependency — engine capabilities (V1, V2)
The UI never writes, moves or deletes engine-owned files, never passes a user-supplied path, and never passes force, replace or paid options. At `fb6bffc` a browser cannot drive visuals safely:
- **No selection command.** Selection and rights clearances can only be recorded by hand-editing `visual-selection.json` (`visuals/models.py:273-283`); so can narrowing the plan (D-61).
- **No JSON or revisions.** Only `visuals-check` prints JSON, and its failures do not use the JSON error envelope. No visuals command takes an expected revision or reports one.
- **The check writes files.** `visuals-check` writes the report under the lock. The read-only `visuals_evaluate` exists internally (`agents/visuals.py:1302`) but has no CLI.
- **No network control.** `visuals-acquire --search-provider wikimedia` contacts the network with no host confirmation and no preview of what it would contact.
- **Import takes a path.** `visuals-import --file` takes an arbitrary filesystem path.
- **No apply state.** Nothing reports whether a scene's selection is applied, and the gaps above are invisible.

Two engine PRs in `youtube-agent`, each with a decision entry, README update and tests, are reviewed and merged before the UI PR that needs them. If one cannot land, the UI ships only what the merged capabilities allow and does not claim M4 complete.

### What the engine already guarantees (fb6bffc), and what V1/V2 add
**Existing** (verified at `fb6bffc`, and unchanged by V1):
- **Content-addressed images.** Every candidate image is decoded, re-encoded as PNG or JPEG, and stored as `render/visuals/candidates/<sha256>.<png|jpg>`. Its `sha256` and `local_path` are recorded in `candidates.json` (`processing.py`, `store_blob` in `storage/visual_cache.py`).
  - Only PNG and JPEG are ever stored for use. An imported TIFF survives only as an original in `render/visuals/originals/`, which nothing serves.
- **Decode limits.** 20 MB, 40 megapixels, and Pillow's decompression-bomb guard (`processing.py:25-31, 121-144`).
- **Byte check.** `blob_ok(root, rel, sha)` is true only for a regular, non-symlink file inside the project whose SHA-256 equals `sha` (`storage/visual_cache.py:45-56`). Selection validation, the contact sheets, and `visuals-apply` use it. Apply re-reads every image under the lock and refuses a changed one ("candidate image … changed; nothing was applied", `agents/visuals.py:1497-1500`).
- **Catalogue integrity.** `render/visuals/manifest.json` records the SHA-256 of the `candidates.json` and `provenance.json` the tool last wrote. Other bytes make the whole catalogue untrusted, so no candidate can be selected or cleared (`agents/visuals.py:181-192`).
- **Clearance binding.** A clearance records `candidate_sha256` and `rights_fingerprint`: the SHA-256 of the source identity, page, kind, synthetic flag, licence status, ID, name, URL, offer, creator, credit line, restrictions and attribution requirement (`visuals/rights.py:486-530`). A mismatch is a validation error (fail closed).
- **Applied images** are bound through `applied.json` and the content address, and checked by `asset_problem` (table above).
- **Not covered today:** contact sheets (`render/visuals/previews/<scene>.png`) are rewritten in place with **no recorded hash**. M4 does not serve them (owner decision 6).

### V1 — visuals CLI contract (reports; no gate policy change). Merged: engine PR #16, D-122, `65c5f52`
- **Read-only state command.** `visuals-state --json` returns one consistent snapshot of everything the UI shows, and writes nothing: no report, no directory, no recovery.
  - **Consistency.** It uses the existing read-only path (`DraftStore.inspector`, as `visuals_evaluate` and `production-check` do, D-100): it reads every input once, evaluates from those bytes, then compares the input hashes again and retries (at most 3 times, then `concurrency`) if anything changed. A pending journal is reported, not recovered.
    - The inputs include the draft manifest (the snapshot is parsed from the same bytes it compares) and the three journal manifests (`render/llm`, `render/research`, `render/production`). Every reported fact, including G1, G3, `pending_journals` and `recovery_required`, comes from that one snapshot. Image bytes are not part of the comparison; they are checked against their recorded hashes when read.
    - A refusal computed during the read (for example `revision_mismatch`) is reported only if the inputs did not change meanwhile; otherwise the read is retried.
  - **Contents:**
    - `revision` (below) and `inputs: {rel: sha256|null}`, the exact files and hashes the snapshot was built from, including the draft files behind `draft_revision`;
    - `evidence_inputs: {reference: sha256|null}`, the local clearance evidence documents the snapshot read (null: missing, unsafe or not a file). They are checked for consistency like `inputs`, but are **not** part of the revision (see Evidence documents);
    - `catalog_trusted`, the plan scenes, and the candidates with rights evidence, `rights_fingerprint`, `local_path`, `sha256` and `format`;
    - the selection, the clearances (and, after V2, their history), and `applied.json`;
    - the evaluation (the `VisualReport` fields);
    - `integrity` for every **selected**, **cleared** or **applied** candidate (`ok | missing | mismatch`, from `blob_ok`);
    - per scene, `apply_state` (below) and `draft_shots`;
    - per asset shown by the draft, `{asset_id, scene_ids, candidate_id|null, candidate_ids, candidate_binding, sha256, local_path, image, record_intact, problem, credit_problems, fixture, rights_current, rights_reason}`:
      - `candidate_ids` are every candidate the asset is bound to (sorted), and `candidate_id` is set only when there is exactly one. `candidate_binding` says how they were found:
        - `recorded`: `applied.json` `asset_candidates`, written by every apply since D-122;
        - `inferred`: an asset applied before D-122, with exactly one catalogue candidate with its bytes;
        - `ambiguous`: such an asset with several candidates with its bytes (the engine never picks one);
        - `missing`: none.
      - `problem` and `credit_problems` come from the existing `asset_problem` and `credit_problems`, and `fixture` from the release fixture-media rule (factored out as `fixture_media`). These are the functions release uses, applied to the **draft's** shots so they are visible before export;
      - `image` (`ok | missing | mismatch`) checks the bytes against the content address in the file name, and `record_intact` checks the record against `applied.json`. Both are independent of rights, because `asset_problem` stops at its first finding: an unverified asset's corrupted bytes would otherwise be hidden behind "rights not verified";
      - `rights_current` recomputes `_rights_decision` with the **current** catalogue and clearances for **every** bound candidate, and is true only if all of them pass. `rights_reason` is `not_verified | clearance_revoked | clearance_invalid | rights_changed | candidate_missing | candidate_ambiguous | null`:
        - `not_verified`: applied without verified rights, as mock and fixture images always are;
        - `candidate_ambiguous`: `candidate_binding: ambiguous`, so rights are never current;
    - `gates`: `g1` (`gates.editorial` status and findings) and `g3` (`gates.visuals` status and findings), computed from the same snapshot. Nothing new is computed for either; they are the existing gate functions;
    - `pending_journals`: every interrupted publication, as the existing `pending_journals` reports it (each a `recovery_required` blocker finding with its `next_action`);
    - `recovery_required` (boolean): see Pending recovery below.
- **Pending recovery.** A publication interrupted by a crash leaves its journal pending, and the files it writes may be mid-publication. The engine never recovers one from a read-only command (D-100).
  - `recovery_required` is true when the **draft/visuals** journal (`render/llm`) or the **research** journal (`render/research`) is pending. Those publications write files the visuals stage reads (the draft, `review.json`, `assets.json`, the visual files, `research-plan.json`).
  - A pending **production package** journal writes only `output/`. It appears in `pending_journals` but does not set `recovery_required`.
  - While `recovery_required` is true, **nothing in the view is actionable**. G1, G3, the evaluation, `apply_state` and the asset facts describe the files as they are, unrecovered, and are not a certification: a G3 `ready` or an `applied_current` scene does not mean what it says until recovery.
  - G1 itself is `recovery_required` when the draft/visuals journal is pending (existing behaviour). G3 is unchanged (no gate policy change in V1).
  - Recovery is done by a locked engine command: any visuals or draft command for the draft/visuals journal (`visuals-check`), any research command for the research journal (`research-check`), or `resume` for all three. M4 offers no recovery action in the browser (see Non-goals); the view shows the engine's `next_action`.
  - **Engine writes refuse too.** Every visuals write that carries `--expect-revision` (plan, acquire before and after its network phase, import, apply) checks for a pending draft/visuals or research journal under the lock, **before** recovering it, and refuses with `recovery_required` (exit 9, `details.journals`). Nothing is recovered or written. The dry run refuses the same way. So a write from the UI never recovers a journal as a side effect, and `checked_by: engine` refusals are expected even if the backend's own check passed a moment earlier.
  - CLI commands run without `--expect-revision` keep their earlier behaviour: they recover first, then act.
- **`apply_state` per scene**, computed by the engine from the snapshot. Apply's shot construction is factored out, so "what apply would write" is the same code:

  | `apply_state` | Engine condition |
  |---|---|
  | `none` | nothing selected; the draft has no shots |
  | `existing_shots` | nothing selected; the draft has shots (applied earlier, or human-authored) |
  | `selected_not_applied` | a selection, never applied for this scene (`applied.json` has no shots for it) |
  | `applied_current` | the draft's shots equal what apply would write for the current selection |
  | `changed_since_apply` | the draft's shots equal `applied.json`'s for the scene, but the selection now gives different shots |
  | `draft_edited` | the draft's shots match neither (hand-edited; apply would report `human_edit_conflict`) |

  Validation is not a stored state: it is the evaluation at a revision (per-scene `render_ready`, errors, unpublishable).
- **Visuals revision** (`scheme: m4-visuals-revision-1`). SHA-256 of the canonical JSON `{"draft_revision": R, "files": {rel: sha256|null}, "scheme": "m4-visuals-revision-1"}`, serialised like the engine's other revisions (`sha256_json`: sorted keys, compact separators, ASCII escapes).
  - The files are `visual-plan.json`, `visual-selection.json`, `render/visuals/candidates.json`, `render/visuals/provenance.json`, `render/visuals/manifest.json`, `render/visuals/applied.json`, `assets.json`, `render/visuals/clearance-history.json` (null until V2 writes it, listed now so the scheme does not change then) and `review.json`.
  - `draft_revision` is the `draft-check` revision (D-117), so a draft edit or a `research-apply` invalidates in-flight visuals work (owner decision 1). The draft revision does not cover `review.json`, so it is in `files`: a G1 change invalidates it too.
  - Report files and contact sheets are excluded (outputs), and so are image bytes (see Integrity).
- **`--json` and the JSON error envelope** (`{ok:false, error:{code, exit_code, message, details?}}`) on `visuals-plan`, `visuals-acquire`, `visuals-import`, `visuals-apply` and `visuals-state`, with the stable codes in the Error codes table. `visuals-check --json` keeps its report shape (now with `revision` and `image_integrity`), as `research-check` does (D-118). Exit codes are unchanged.
- **`--expect-revision`** on every visuals mutation, checked under the lock before anything is published. `visuals-acquire` checks it again after the network phase (as research collect does, D-118).
- **Acquisition preview and binding** (see Network confirmation).
- **Import from stdin.** `visuals-import --stdin --title T --expect-revision=R` reads the image bytes from standard input. They are size-limited, decoded, hashed and staged exactly like a download, outside the lock. Under the lock, the revision is checked **before** the candidate, catalogue or provenance is published; on a mismatch the staged bytes are discarded and nothing is recorded. No filesystem path crosses the boundary. `--title` names the image (with `--file` it is the file name); the other flags are unchanged.
- **Apply binds assets to candidates.** `applied.json` gains `asset_candidates: {asset_id: [candidate_id]}`, the candidates each applied asset was written from. Bindings are pruned to the assets the new draft still shows, so a candidate whose scenes were all replaced is no longer reported as applied. Bindings are per asset, not per scene: an asset still shown by an unchanged scene keeps every earlier candidate, and `rights_current` needs all of them.
- **Apply refuses conflicting provenance for shared bytes.** Two candidates can have the same image bytes, and so the same asset. Apply refuses with `not_ready` (exit 2, nothing written) when the assets it would write give one asset two different rights records:
  - two candidates selected in the same apply with different rights;
  - a candidate selected now whose rights differ from the record of an asset that a scene left unselected still shows. The retained record is the `assets.json` record, or failing that the bound candidates' records, or for a project applied before D-122 every catalogue candidate with those bytes (none is guessed).

  The compared fields are source URL, creator, licence name and URL, attribution, rights verification and basis, prompt and generation provider (not `kind`). `--replace-assets` does not bypass the check. The message names the asset, the candidates and the scenes. The reviewer resolves it by choosing a compatible candidate, or by selecting new shots for every scene that shows the asset.
- **Apply repairs a missing applied image.** When a selected asset's content-addressed file is missing and its candidate passes `blob_ok`, apply installs it even if the records are unchanged (`status: images_restored`, with the asset IDs). A file with other bytes (or a symlink) is refused, now as `image_integrity` with the path, instead of apply reporting `already_current`, and is left for the CLI user to resolve: the UI never deletes it.
- **Progress.** One line per scene searched, downloaded or rejected, on a progress logger.

### V2 — `visuals-edit`: selection, clearances and plan narrowing
V2a merged as engine PR #17 (D-123, `c089089`): the command, the operations, validation, the clearance history, revocation, and changed evidence invalidating a clearance. V2b merged as engine PR #18 (D-124, `26c608f`): the G3 gate change below and the release check.

- **The command.** `visuals-edit --expect-revision=R --json [--dry-run]`, with a strict patch `{"operations": [...]}` on stdin: no nulls, no unknown fields, at most 1 MiB and 200 operations. All operations are applied and published atomically under the lock, or none are.
- **Operations:**
  - `shots.set {scene_id, shots: [{candidate_id, motion?, fit?, duration_seconds?}]}` and `shots.clear {scene_id}`;
  - `clearance.set {candidate_id, expected_candidate_sha256, expected_rights_fingerprint, reviewer, basis, justification, evidence, acknowledgement}`. The engine records `candidate_sha256` and `rights_fingerprint` from the trusted catalogue, and refuses (`target_changed`) unless they equal the expected values the reviewer saw;
  - `clearance.revoke {candidate_id, reviewer, reason}`;
  - `plan.update {scene_id, search_query?, search_enabled?, generation_enabled?, notes?}`, narrowing only (D-61).
- **Validation.**
  - Each operation is validated as `visuals-check` and `visuals-apply` would validate it: selectable candidate, destination-scene policy (D-73), placeholder clearances, exact acknowledgement.
  - Every candidate an operation selects or clears is byte-verified with `blob_ok` under the lock (`image_integrity`).
  - The order of checks and the codes are in the Error codes table; the first failure wins and nothing is written.
- **Clearance history.** `render/visuals/clearance-history.json` is append-only and hash-chained, like research review history (D-119). Every set, replacement and revocation is kept with who, when and why. A broken chain is `history_tampered`, and every edit is refused until it is resolved in the CLI. The history is part of the visuals revision, and `visuals-state` uses it for `rights_reason: clearance_revoked`.
- **Revocation** (owner decision 3). `clearance.revoke` removes the clearance from `visual-selection.json` and appends the revocation to the history. It never touches `assets.json`, `assets/images/`, `applied.json` or the draft:
  - an applied asset that used it stays physically present, and its `rights_verified` record stays as the historical record of that apply;
  - `visuals-state` reports `rights_current: false, rights_reason: clearance_revoked` for it, and `integrity` is unchanged;
  - if the selection still names the candidate, the existing G3 already reports `image_rights_not_cleared`; otherwise only decision 5 makes G3 and release block;
  - **restoring eligibility:** a new `clearance.set` for the same bytes and evidence makes `rights_current` true again, and no apply is needed, because the asset record is unchanged. Choosing a replacement image needs `shots.set`, then apply, then G1 re-approval.
- **G3 gate change (owner decision 5, approved).** A new engine decision entry, changing `gates.visuals()` and `asset_problem`:
  - a scene with a selection is ready only when its `apply_state` is `applied_current`;
  - every asset the draft shows must have no `asset_problem` and `rights_current: true` (also for `existing_shots`);
  - new finding codes `visuals_not_applied` (with the scene IDs) and `applied_image_problem` (with the asset ID and the reason); `image_rights_not_cleared` is also used for an applied asset whose clearance was revoked;
  - `release_storyboard`'s `asset_problem` uses the same `rights_current` check, so a revoked image cannot reach release even with the selection cleared.

  This is in the pinned engine since `26c608f` (D-124). Before it, G3 kept its `fb6bffc` meaning (true at `c089089`). In D-124, a revoked clearance gives `image_rights_not_cleared`, and every other applied-image problem gives `applied_image_problem`. Release also requires `rights_current` and reads one consistent snapshot.

### Integrity: how changed, missing or substituted images are detected
Image bytes are **not** in the revision, because hashing every candidate on every page load would cost a full read of each one. Instead, integrity is enforced by mandatory checks wherever bytes matter, all against the engine's recorded hashes:

| Where | Check | Failure |
|---|---|---|
| `visuals-state` (V1) | `blob_ok` for every selected, cleared or applied candidate, plus `catalog_trusted`; for every asset the draft shows, its bytes against its content address, and `asset_problem` | per candidate `integrity: ok \| missing \| mismatch`; per asset `image` and `problem`; an evaluation error for a selected candidate (G3 `visuals_invalid`, existing) |
| `visuals-edit` `shots.set` / `clearance.set` (V2) | `blob_ok` of each named candidate, under the lock | `image_integrity`; nothing written |
| `visuals-check` / `visuals-apply` (existing, codes from V1) | `blob_ok` in selection validation; apply re-hashes each candidate image under the lock before installing it; `store_blob` refuses an existing asset file with other bytes | `image_integrity`; nothing published |
| Release (existing) | `draft-export` needs every shot's image to resolve; then `asset_problem` on every asset `storyboard.json` shows | `export_not_possible` (a corrupted or missing applied image fails the export check first) or `image_not_releasable` |
| Image endpoint (UI) | the current record's hash equals the URL's `sha256`, and the exact bytes served hash to it (M4-02) | `409 image_changed` or `409 image_integrity`; nothing served |

- **Bytes changed after validation, before apply.** The revision is unchanged, so `--expect-revision` passes. Apply's own re-hash under the lock refuses it, and nothing is published.
- **A replaced image.** A replacement has a different hash, so it is a different file name and a different catalogue entry, and a clearance bound to the old `candidate_sha256` fails validation.
- **Changed rights metadata.** This changes `candidates.json` (so the revision changes) and `rights_fingerprint`. A clearance for the old evidence becomes a validation error (G3 `visuals_invalid`), and an applied asset that relied on it gets `rights_current: false, rights_reason: rights_changed`.
- **An applied image changed or removed while its candidate is intact.** `visuals-state` reports the asset's `image` (`mismatch` or `missing`), and release is blocked (`export_not_possible`). A missing file is restored by apply (V1). A file with other bytes is refused by apply and left for the CLI user.
- **A hand-edited catalogue** is `catalog_untrusted`: nothing can be selected or cleared until `visuals-acquire` rebuilds it.

**Evidence documents.** A clearance's `evidence` can name a local document in the project (for example a permission letter). Clearance validation hashes it, using the same containment rules as everywhere else (lexically safe, inside the project, a regular file; a remote URL is never fetched).
- **One reading per snapshot.** Each distinct evidence reference is read once per snapshot and cached for that snapshot only, including a `null` result. All clearances citing the same document see the same reading.
- **Changes during a read.** The snapshot compares every reading again at the end, and retries (then `concurrency`) if one changed. A snapshot never mixes two states of one document. The readings are reported as `evidence_inputs`.
- **V1 limitation (deferred to V2).** The engine does not compare the document with the hash recorded at apply (`RecordedClearance.evidence_sha256`). Replacing a permission document with different contents therefore leaves the clearance valid and `rights_current: true`. Whether changed evidence invalidates an attestation, needs a new clearance or a re-apply, how evidence hashes enter the clearance history, and what it means for G3 and release, are V2 policy decisions. The UI must not present `rights_current` as proof that an evidence document is unchanged since apply. *Resolved by D-123, in V2a at `c089089`.* A clearance recorded with `visuals-edit` binds the evidence file's bytes. A changed file gives `rights_current: false, rights_reason: evidence_changed`; a removed one gives `clearance_invalid`. A new `clearance.set` restores the clearance without an apply. A clearance written by hand has no recorded hash and is checked as before.

### Network confirmation: the acquisition preview
- **Preview.** `visuals-acquire --dry-run --json` contacts nothing and is read-only: it evaluates one snapshot through the same read-only path as `visuals-state` (no directory, lock, recovery or manifest save; retried if the inputs change). It honours `--expect-revision` (`revision_mismatch`, nothing written). It runs the same checks and preview function as a real run does under the lock, so the same state and parameters give the same `preview_sha256`. While a draft/visuals or research publication is pending it refuses with `recovery_required` (`details.journals`), because a run would first recover and then act on other files. It returns the canonical preview `P` and `preview_sha256 = sha256(canonical_json(P))`, serialised as the revision is. `P` contains:
  - `scheme` (`m4-acquire-preview-1`), the engine `project_id`, the visuals `revision`, `search_provider`, and `image_provider` (always `none` from the UI);
  - the sorted effective `scene_ids`, the `queries` (`[{scene_id, query}]`, as the plan yields them after narrowing), `generate` (scenes that would request a generated image; none from the UI), `max_candidates_per_scene`, `timeout`, `concurrency` and `force` (always false from the UI);
  - `hosts`: the sorted exact set a run may contact: the fixed HTTPS allowlists of the providers the run would use, including media hosts.
- **Binding.** `visuals-acquire … --expect-revision=R --expect-preview=H --allow-host=…` recomputes `P` from its current state before any request, and refuses with `preview_mismatch` unless the hash equals `H` and the `--allow-host` set equals `P.hosts`.
  - `--expect-preview` needs `--allow-host`. `--allow-host` alone narrows every provider's allowlist; it is optional on the CLI, so existing scripts keep working, and the UI always passes it with `--expect-preview`.
  - Every request and redirect is checked against the allowed hosts. A refused one fails that request, counted as `host_not_allowed` in the run's `failures`; the run then ends as `partial_acquire_failure` with its report.
  - After the network phase, the revision is re-checked under the lock before anything is published (`revision_mismatch`; nothing recorded).

### Error codes
One table for the engine contract, the backend and the UI. Each refusal writes nothing.

| Code | Raised by | Meaning | HTTP |
|---|---|---|---|
| `revision_mismatch` | engine | the records changed since `expected_revision` | `409 revision_conflict`, with `details.current_revision` (as M3) |
| `preview_mismatch` | backend pre-check **and** engine `--expect-preview` | the recomputed acquisition preview, or the host set, differs from what the reviewer confirmed. One code at both layers; `details.checked_by` is `backend` or `engine` | `409 preview_mismatch` |
| `catalog_untrusted` | engine | `candidates.json` or `provenance.json` are not the bytes the tool last wrote, so no catalogue record is trusted | `409 catalog_untrusted` |
| `history_tampered` | engine (V2) | the clearance history's hash chain is broken | `409 history_tampered` (as M3: reported as an `invalid_patch` item code and mapped to its own status) |
| `invalid_patch` | engine (V2) | the patch is malformed, or an operation is refused by policy; `details[{loc, msg, code}]`, including `target_changed` (a clearance's expected hash or fingerprint is not the catalogue's) | `422 invalid_edit` (as M3) |
| `image_integrity` | engine; backend image endpoint | an image file is missing, a symlink, or has bytes other than its trusted recorded hash; `details.candidate_ids`, `asset_ids` or `path` | `409 image_integrity` |
| `image_changed` | backend image endpoint only | the URL's `sha256` is not the current record's: the URL is outdated. Not an integrity failure | `409 image_changed`, with `details.current_sha256` (or null) |
| `partial_acquire_failure` | engine | some image requests failed (including `host_not_allowed`); completed scenes were recorded. `details` is the run report, with `failures` by code | none: acquisition is a job, so this is the job's failure (exit 13), shown with its log and report, as M3 shows `partial_search_failure` |
| `recovery_required` | engine (`visuals-acquire --dry-run`, and every write with `--expect-revision`, before recovering); backend pre-check on every visuals write and preview | a draft/visuals or research publication is pending (`details.journals`); nothing is previewed, recovered or written. `details.checked_by` is `backend` or `engine` | `409 recovery_required` |
| `not_ready` (apply) | engine | among others, the shared-bytes provenance conflict (V1): one asset would get two different rights records. The message names the asset, candidates and scenes | `409 not_ready`, with the engine's message |
| `human_edit_conflict`, `g1_not_current`, `concurrency`, `invalid_input`, `provider_unavailable` | engine | as their names say, with the M3 mappings | as M3 |

Exit codes stay as before D-122: `revision_mismatch`, `preview_mismatch`, `recovery_required` and `concurrency` 9; `image_integrity`, `catalog_untrusted`, `not_ready` and `invalid_input` 2; `g1_not_current` 12; `partial_acquire_failure` 13.

Check order inside the engine (the first failure wins): `revision_mismatch` → `g1_not_current` → `catalog_untrusted` → `history_tampered` → `invalid_patch` → `image_integrity`. A tampered or untrusted file therefore never shows as a patch error, and bytes are hashed only for a patch that is otherwise valid.

## Owner decisions (all six approved by the owner on 2026-11-23)
1. **`draft_revision` in the visuals revision.** Approved: yes. Any draft change, including `research-apply`, then invalidates confirmed acquisitions and open edits. This is the safe choice, at the cost of an occasional "reload".
2. **The plan step as a job.** Approved: yes, for consistency with M3's plan job. It is fast and uses no network.
3. **Clearance revocation.** Approved: a revocation needs a reviewer and a reason, and is kept in history. A revoked clearance can only be replaced by a new `clearance.set`. Revocation never deletes assets or changes the draft.
4. **TIFF originals.** Approved: never served. The UI shows only the engine's normalised PNG or JPEG.
5. **G3 requires applied, intact, currently cleared images.** Approved: yes, as a V2 engine decision (the G3 gate change above). It closes gaps 1 and 2, and matches the engine's own message ("no selected, applied image"). It is a gate policy change, approved explicitly; V2 records it as an engine decision entry.
6. **Contact sheets are not served in M4.** Approved: yes. The gallery shows each candidate from its own content-addressed image, which already has a recorded hash. Contact sheets are a CLI convenience, rewritten in place per scene, and show nothing the gallery lacks. This removes the need to record and bind their hashes. If they are wanted later, V1 would record `previews: {scene_id: {path, sha256, scene_catalog_sha256}}` in `manifest.json` under the lock, where `scene_catalog_sha256` is the canonical-JSON hash of that scene's trusted `candidates.json` entry. Only a sheet whose value equals the current digest would be served, so a catalogue change would invalidate only the affected scenes' sheets.

## User journeys
1. **Plan visuals.** With a current G1, the Visuals page offers **Plan visuals** (`visuals-plan`), a job with no network. The page lists every scene with its kind, search query, and whether it needs a human-provided image.
2. **Narrow the plan** (optional). Edit a scene's search query, or turn search or generation off. Generation is shown as unavailable: no paid provider in M4.
3. **Search Wikimedia Commons.**
   - The backend asks the engine for the acquisition preview at the loaded revision. The dialog lists exactly its hosts, scenes and queries.
   - The confirmation is bound to that preview's `preview_sha256`. Changing any parameter (scenes, the per-scene limit, a query through plan narrowing), a new revision, or closing the dialog clears it. A preview answer for older parameters is dropped (the M3 collect-dialog pattern).
   - After confirmation, acquisition runs as a job with live logs. Nothing is contacted before confirmation, and `YTA_VISUALS_NETWORK=false` refuses it.
4. **Review candidates.** A gallery per scene shows each candidate image (served by ID and hash), title, source page, creator, licence, credit line, restrictions, the engine's rights status and reasons, and labels for placeholder or mock images ("Test image: never publishable").
5. **Import an image.** Upload a still image with its provenance (kind, provenance statement, source URL, creator, licence and attribution). The engine adds it as a `manual_review` candidate.
6. **Select.** Choose one or more candidates per scene, optionally with motion, fit and duration. Each save runs `visuals-edit` under the loaded revision.
7. **Clear rights.** For a `manual_review` candidate, record a clearance: basis, justification, evidence, the reviewer's name, and the exact acknowledgement text shown verbatim. The dialog shows the very image being cleared, and the clearance is bound to that image's hash and evidence. It can be revoked later, with a reason.
8. **Validate and apply.**
   - **Validate visuals** shows the engine's report: per-scene readiness, errors, warnings, unpublishable images and publication blockers.
   - Each scene shows its engine-reported `apply_state`, so "selected but not applied" and "changed since apply" are visible.
   - **Apply selection** runs `visuals-apply --reviewer` with the validated revision. It warns first that G1 will go out of date, then links to the G1 re-approval.
9. **G3.** The page shows G3 exactly as the engine reports it, with its findings. There is no G3 approve button, because the engine has no G3 approval. Applied images whose rights are no longer current, or whose files are missing or changed, are flagged from the engine's per-asset facts.
10. **Use the CLI** at any step. A change made there appears as a revision conflict or a new state, never as a silent overwrite.

## M4-01 — Compatibility and engine contract
- V1 and V2 are separate engine PRs, reviewed and merged in that order. Each UI PR pins its minimum engine in `ENGINE_REF`.
- `docs/engine-compatibility.md` records every flag, JSON shape, exit code and error code against the merged engine, with a real-engine probe.
- The UI's capability list grows only with commands the pinned engine actually has. An older engine shows a truthful "not supported by this engine" state.

## M4-02 — Backend API (`/api/v1`; CSRF and origin on every mutation)
Every write holds the project (`409 job_conflict` / `project_busy`) and carries `expected_revision`. Refusals map as in the Error codes table.

| Method and path | Engine command | Returns |
|---|---|---|
| `GET /projects/{id}/visuals` | `visuals-state --json` | the view: the engine snapshot (with `revision`, `catalog_trusted`, per-candidate `integrity`, per-scene `apply_state`, per-asset facts, `gates {g1, g3}`, `pending_journals`, `recovery_required`), plus `network`, `editing`, `active_job_id` |
| `GET /projects/{id}/visuals/candidates/{candidate_id}/image?sha256=H` | read, verified as below | image bytes |
| `GET /projects/{id}/visuals/assets/{asset_id}/image?sha256=H` | read, verified as below | image bytes |
| `POST /projects/{id}/visuals/plan {expected_revision}` | `visuals-plan --expect-revision --json` | 202 job |
| `POST /projects/{id}/visuals/acquire/preview {expected_revision, scene_ids?, max_candidates_per_scene}` | `visuals-acquire --dry-run --search-provider=wikimedia --json` (nothing contacted) | `{preview, preview_sha256}` |
| `POST /projects/{id}/visuals/acquire {expected_revision, scene_ids?, max_candidates_per_scene, network: true, preview_sha256, allow_hosts}` | `visuals-acquire --search-provider=wikimedia --image-provider=none --expect-revision --expect-preview --allow-host=… --json` | 202 job |
| `POST /projects/{id}/visuals/import` (multipart) | `visuals-import --stdin --expect-revision --json` | the refreshed view |
| `POST /projects/{id}/visuals/edit {expected_revision, operations, dry_run?}` | `visuals-edit` | `{result, visuals}` (no `visuals` for a dry run) |
| `POST /projects/{id}/visuals/apply {expected_revision, reviewer, confirm: true}` | `visuals-apply --expect-revision --json` | `{result, visuals}` |

**One snapshot per view.** All of a view's fields, including G1 and G3, come from one `visuals-state` run, so the UI never combines facts from different moments. `production-status`, shown on the project page, is a separate read with its own time. It may briefly differ from the visuals view, and the UI never mixes the two into one decision. Apply's confirmation and every edit are bound to the view's `revision`, not to production-status.

**Pending recovery.** When the current snapshot (after the freshness check below) has `recovery_required: true`, the backend refuses the acquisition preview, acquire, plan, import, edit and apply with `409 recovery_required` (`checked_by: backend`) before running any engine command. The journal manifests are in the snapshot's `inputs`, so a recovery made from the CLI invalidates the snapshot and lifts the refusal on the next request. The engine refuses the dry run itself as well (`checked_by: engine`), and its writes stay protected by `--expect-revision`. Reads continue: the view, and images served by ID and hash, which are verified on their bytes as always.

**Acquire confirmation.** Before submitting the job, the backend re-runs the dry run with the same parameters. It refuses (`409 preview_mismatch`, `checked_by: backend`) unless the hash equals `preview_sha256` and `allow_hosts` equals the preview's hosts exactly. The engine then checks both again itself (`--expect-preview`), so a change between the two checks is still refused (`checked_by: engine`). With `YTA_VISUALS_NETWORK=false`, both preview and acquire are refused (`403 network_disabled`), and no network provider is ever passed.

**Import.**
- Multipart fields:
  - `expected_revision` (required, 64 hex);
  - the image (at most 20 MB, the engine's limit; JPEG, PNG, WebP or TIFF by magic bytes);
  - `scene_id`, `kind`, `provenance`;
  - optional `source_url` (https), `creator`, `license_name`, `license_url` (https) and `attribution`.
- **Order:**
  1. CSRF, origin and the project hold.
  2. The text fields are validated before the file part is read, and `expected_revision` is compared with the backend's current snapshot. A mismatch gives `409 revision_conflict` before any upload bytes are read.
  3. The file is read in memory with the size cap enforced while streaming, and its magic bytes are checked.
  4. The bytes go to `visuals-import --stdin --expect-revision=R`, which checks the revision again under the lock before publishing (V1). The engine's check is the authoritative one.
- Bytes the engine cannot decode are refused by it with the generic code `error` (exit 3, "unrecognised image data"), not `invalid_input`. The backend's magic-byte check in step 3 therefore answers `422 invalid_input` itself before the engine runs, and an engine `error` from import is shown as a failed import with the engine's message.
- The UI never stores the bytes on disk.

**Image endpoints: authorisation, verification and caching.** Images are addressed by engine ID **and** expected content hash, never by file name or path. So no request can name an arbitrary project file, and a URL always means one exact image.

1. **Check the request.** `sha256` is required and must be 64 lowercase hex; the ID must match its engine pattern. Otherwise `400 invalid_input`.
2. **Use a current snapshot.** The backend keeps the latest `visuals-state` result per project, with its `inputs` and `evidence_inputs` hash maps. Before resolving a record, it re-hashes the files in both. Evidence paths are opened with the engine's containment rules (relative, inside the project, no symlink, a regular file; a missing or refused one counts as `null`), and a URL reference is never fetched. These are small JSON files the engine documents, and a stat key (inode, size, mtime) avoids re-reading an unchanged one. Any difference, from the UI, a job or the CLI, discards the snapshot and runs `visuals-state` again (single-flight per project). If that fails, the response is `503 state_unavailable` and nothing is served. Every write and every job end also discards it. A stale snapshot therefore cannot authorise an image the current state no longer references.
3. **Resolve the record** in that snapshot:
   - `candidates/{id}`: the trusted catalogue entry (`catalog_trusted` must be true, otherwise `409 catalog_untrusted`), with `local_path`, `sha256` and `format`;
   - `assets/{id}`: the `assets.json` record whose hash equals `applied.json` `assets[id]` (the existing `asset_problem` record check), with `local_path`. Its hash is the content address in the file name.

   An unknown ID or no record gives `404`.
4. **Match the URL.** If the record's hash is not `H`, the response is `409 image_changed` with `current_sha256`, and no bytes. The UI then refreshes the view instead of showing an outdated image.
5. **Check the path shape.** It must be exactly `render/visuals/candidates/<H>.(png|jpg)` or `assets/images/<H>.(png|jpg)`.
6. **Open safely.** Each path component is opened with `O_NOFOLLOW` from the project directory (no symlink anywhere, and the result stays inside the project). The descriptor must be a regular file of at most 20 MB. It is read once into memory, from that descriptor.
7. **Verify the bytes read:** their SHA-256 must equal `H` (otherwise `409 image_integrity`), the magic bytes must be PNG or JPEG matching the extension, and the header dimensions must be at most 40 megapixels. No full decode happens in the request path.
8. **Serve exactly those bytes,** with:
   - `Content-Type: image/png` or `image/jpeg` (from the verified magic);
   - `X-Content-Type-Options: nosniff`;
   - `Content-Security-Policy: default-src 'none'; sandbox`;
   - `Content-Disposition: inline`;
   - `Cache-Control: private, max-age=31536000, immutable` and `ETag: "H"`.

   Every error response is `Cache-Control: no-store`. Because the verified bytes are the bytes served, replacing the file after verification cannot change what is sent.
9. **Never served:** SVG, HTML or any other type; contact sheets (owner decision 6), originals and staging files; TIFF. Image reads share a small semaphore, so concurrent large reads are bounded.

**Why caching cannot mislead a reviewer.** Correctness never depends on the ETag or on expiry:
- A URL's bytes are fixed by its hash, and the backend served them only after checking them against that hash and a current record. Caching them for a long time is therefore safe, and an unchanged image is fetched once.
- The UI builds every image URL from the same view object as the metadata around it. When a refresh changes an image's hash, its URL changes, so the browser cannot show cached old bytes next to new metadata.
- An outdated URL that is requested anyway (an old tab, a raced refresh) gets `409 image_changed`, never old bytes passed off as current.
- If bytes on disk are corrupted while the record is unchanged, a cached copy still shows the correct bytes for that hash. The corruption is reported by `visuals-state` `integrity` and refused by edit and apply.

**Bound actions.** A clearance dialog, once open, is fixed to `{candidate_id, sha256, rights_fingerprint, revision}` from the view it opened in, and shows the image at that `sha256`.
- If a later view (watched through the query-cache subscription, as in M3's G2 panel) changes any of them, the dialog shows "This image or its evidence changed" and disables submit.
- Submission sends `expected_revision` and the clearance's `expected_candidate_sha256` and `expected_rights_fingerprint`. The engine refuses unless all three still hold (`revision_conflict`, or `invalid_edit` with `target_changed`), and it re-hashes the bytes (`image_integrity`).

So a clearance is recorded only for the exact bytes the reviewer was shown. Selection and apply are bound the same way, through `expected_revision` and the engine's byte checks.

## M4-03 — Visuals workspace UI (`/projects/[projectId]/visuals`)
- **Navigation.** The sidebar's **Visuals** entry becomes live. The project page's next step leads here once G2 is applied and G1 is current, or straight after G1 when research is not used.
- **Layout.**
  - **Scenes:** one card per scene, with narration, brief, kind, the selection, the engine's `apply_state` and readiness.
  - **Gallery:** per scene, candidates in a responsive grid with keyboard selection, alt text from the title and brief, and a large preview dialog.
  - **Validation:** the report, unpublishable images, credits, applied-asset facts, and apply.
- **Workflow states are displayed, not derived.** The workspace shows the engine's `apply_state`, `render_ready`, `integrity`, `problem` and `rights_current` as reported, with fixed wording per value:

  | Conceptual state | Engine fields shown |
  |---|---|
  | No selection | `apply_state: none` (or `existing_shots`, "keeps its current images") |
  | Selected, not applied | `selected_not_applied` |
  | Selection validated | the evaluation at the view's revision: scene `render_ready`, no errors |
  | Applied and current | `applied_current` |
  | Changed since the last apply | `changed_since_apply` |
  | Applied image with stale or revoked rights | asset `rights_current: false` and its `rights_reason` |
  | Applied image missing or modified | asset `image` (`missing` or `mismatch`), with `problem` (from `asset_problem`) |

  The frontend keeps no state machine of its own, and never combines these into a different readiness or gate.
- **Applied assets.** Each asset shows its `candidate_ids` and `candidate_binding`. `ambiguous` reads "Applied before candidate tracking; several candidates have these bytes" and `rights_reason: candidate_ambiguous` is shown as not current. The UI never picks one of the candidates itself.
- **Evidence.** A cleared candidate's local evidence document shows the snapshot's `evidence_inputs` entry (found, or missing/refused). Since D-123 the engine binds a document recorded through `visuals-edit`: the UI says that a change makes the clearance stop counting, and that a hand-written clearance (no recorded hash) is only checked for existence.
- **Pending recovery.** When the view has `recovery_required: true`:
  - a blocking banner at the top of the workspace says that an interrupted publication must be recovered, lists each `pending_journals` finding's detail and the engine's `next_action` text (a CLI command) as plain text, and says that nothing shown is certified until then;
  - plan, preview and acquire, import, selection and clearance edits, validation and apply are disabled, each with the banner as its reason (and any open confirmation dialog disables submit);
  - G1, G3, `apply_state` and the asset facts stay visible, marked "not certified: recovery pending", never as ready or current;
  - a `409 recovery_required` response refreshes the view, like `image_changed` does.
  - A pending production package journal alone shows an informational note, not the banner, and blocks nothing on this page.
- **Honesty.**
  - Rights status and reasons are the engine's.
  - "Publishable" is never shown for placeholder, mock or `manual_review` images without a clearance.
  - Generated images (if ever present) carry the engine's disclosure label.
  - Progress is the engine's log lines, never a percentage.
  - The note "G3 does not require the selection to be applied" was shown in UI-A, while decision 5 was not in the pinned engine. It is removed now that the pinned engine (`26c608f`, D-124) includes decision 5; G3's own findings say what is missing.
- **Accessibility:** WCAG 2.2 AA, as in M1–M3. Images need text alternatives; the selection state is never conveyed by colour alone.

## M4-04 — Validation, apply and G3
- **Pending recovery** disables validation and apply (M4-03), and the backend refuses apply with `409 recovery_required`.
- **Apply** sends the revision the reviewer last validated, as M3's G2 approval does: a validation is spent by any later change, and the confirmation dialog stays bound to it.
  - A change in records, from the UI, the CLI or a job, is refused with `revision_mismatch`.
  - A change in image bytes alone is refused by apply's own re-hash with `image_integrity`.
  - The result (`published`, `already_current` or `images_restored`) and its scene and asset lists are shown as the engine returns them.
  - A shared-bytes provenance refusal (`409 not_ready`) is shown with the engine's message. It can come from a later apply: the dialog explains that another scene still shows the same image under different rights, and that the fix is a compatible candidate or new shots for every scene the message names.
- **After apply,** G1 shows as out of date (`stale_after_apply`) until `draft-approve` runs again (M2's flow). Apply also changes the draft revision, so any open draft editor reloads. Selecting and applying again need no G1 re-approval first; release needs it.
- **G3** is shown as `visuals-state` reports it (the existing `gates.visuals()`, or its decision-5 version once merged), and is never inferred, strengthened, weakened or "approved" by the UI.
- **Release eligibility** is not run from the visuals page (release is M6). The page shows the engine's per-asset facts, which use the same functions as release.
- **Nothing runs automatically.** Nothing advances to narration or rendering.

## M4-05 — Security
- **Unchanged:** loopback binding, host and origin checks, CSRF on every mutation.
- **Argv.**
  - Allowlisted per operation. No `shell=True`, and no user-supplied flag, path or executable.
  - Excluded: force, replace and paid options (`--force`, `--replace-plan`, `--replace-shots`, `--replace-assets`, `--allow-paid`, `--image-provider openai`).
  - User text travels as single argv elements; image bytes and patches go on stdin.
- **Network.**
  - Only hosts the reviewer confirmed for that exact acquisition. The confirmation is bound to the engine preview's `preview_sha256`, checked by the backend and again by the engine (`--expect-preview`), and the engine enforces `--allow-host` on every request and redirect.
  - `YTA_VISUALS_NETWORK=false` refuses every network action. The backend never fetches anything itself. No paid services and no API keys.
- **Untrusted content.** Image files, titles, licence text, creators and source URLs are untrusted.
  - Images are served only by engine ID and expected hash, from a current engine record, verified on the exact bytes sent, and never as SVG, HTML or TIFF (M4-02).
  - Text is rendered as text, and links carry `rel="noopener noreferrer"`.
  - None of it is ever used in a command line.
- **Uploads.** At most 20 MB, magic-byte checked, streamed to the engine on stdin, and never stored by the UI on disk.

## M4-06 — Tests, CI and handoff
- **Backend.**
  - The argv builders and the excluded flags.
  - Requests and errors: the upload limits, magic bytes and field order (a bad `expected_revision` refused before the file is read); the edit request models; every row of the Error codes table, including `preview_mismatch` and `recovery_required` from both layers; `exclusive`.
  - Pending recovery: with `recovery_required: true` in the snapshot, every visuals write and the preview are refused with `409 recovery_required` and no engine command runs; the view and image reads continue; a CLI recovery (the journal manifest changes) invalidates the snapshot and lifts the refusal; a pending production package journal alone refuses nothing; an engine write refused with `recovery_required` (`checked_by: engine`) after the backend check passed.
  - Snapshot freshness: a changed, appearing or removed `evidence_inputs` document invalidates the snapshot; an evidence path outside the project or through a symlink is never opened.
  - A fake engine extended with the V1/V2 JSON, errors and race modes.
- **Image endpoints and caching** (unit tests):
  - served with the immutable cache headers: a catalogued candidate, an applied asset;
  - `400`: no `sha256`, or a malformed one;
  - `404`: a file with a valid name but no record; any contact-sheet path;
  - `409 catalog_untrusted`: an untrusted catalogue;
  - `409 image_changed`: an outdated URL after a catalogue update; a candidate or asset record that changed while keeping its ID;
  - a CLI change to the catalogue while the browser is open: the next image request re-runs `visuals-state` and refuses an image no longer referenced;
  - `503 state_unavailable` when the refresh fails, with nothing served;
  - path traversal in an ID, and a symlink anywhere in the path;
  - `409 image_integrity`: a hash mismatch, a missing file; a file replaced between being opened and the response (the served bytes are the verified bytes);
  - refused: a PNG named `.jpg`, an SVG or HTML disguised as an image, an oversized file, a header claiming more than 40 megapixels;
  - error responses are `no-store`.
- **Integrity** (engine and UI):
  - a candidate's bytes changed with no catalogue change: reported as a mismatch, and selection, clearance and apply refused;
  - a missing or corrupted candidate;
  - rights metadata changed after a clearance: the clearance fails validation;
  - bytes changed after validation, before apply: apply is refused and nothing is published;
  - a cleared image replaced: the clearance does not carry over;
  - an image changed while a clearance dialog is open: the dialog shows the change and disables submit; a forced submission is refused (`revision_conflict`, `target_changed` or `image_integrity`);
  - unchanged, valid images continue through the normal workflow.
- **Selection, apply, rights and G3** (engine tests in V1/V2, and the fake engine; each checks the engine-reported G3, `apply_state` and per-asset facts, and, where it applies, release):
  - G3 before any selection (`needs_review`, `visuals_selection_needed`);
  - G3 after a valid selection but before apply (`selected_not_applied`; at `fb6bffc` G3 `ready`; with decision 5 `visuals_not_applied`);
  - G3 after apply (`applied_current`; G1 `stale_after_apply`);
  - G3 after G1 re-approval (unchanged by it; G1 `approved`);
  - the selection changed after apply (`changed_since_apply`);
  - a clearance revoked after apply: assets, `applied.json` and the draft untouched; `rights_current: false, clearance_revoked`; G3 `image_rights_not_cleared` while still selected. With the selection then cleared: G3 `ready` at `fb6bffc` (the documented gap), and blocked with decision 5;
  - rights metadata changed after apply (`rights_reason: rights_changed`);
  - applied image bytes modified, and removed: asset `problem`; a missing file restored by apply (`images_restored`); a modified one refused (`image_integrity`) and left in place;
  - a candidate image intact while its applied asset image is corrupted: the candidate's `integrity: ok`, the asset's `problem` set;
  - two candidates with the same bytes and different rights: apply refused with `not_ready` in one apply, and in a later apply while an unselected scene still shows the asset; compatible candidates accepted; `candidate_binding` `recorded`, and `ambiguous` with `candidate_ambiguous` for a pre-D-122 project;
  - a replacement selection applied, then `draft-approve`: `applied_current`, `rights_current` true, G1 approved, G3 `ready`;
  - release: after `draft-export`, `production-check --mode release --json` has no `image_not_releasable`, `fixture_image` or `credit_incomplete` for the good case, and is blocked for the corrupted-asset case (`export_not_possible`, as verified in V1), and for the revoked case with decision 5.
- **Network confirmation** (backend and frontend):
  - after the preview, a change of scenes, of the per-scene limit or of a query (plan narrowing), or a new revision: the confirmation is cleared and the backend refuses with `preview_mismatch`;
  - a change between the backend's check and the engine's: the engine refuses with `preview_mismatch` (`checked_by: engine`);
  - preview answers arriving out of order: the stale one is dropped;
  - the dialog closed and reopened: no confirmation is kept;
  - a request or redirect to an unconfirmed host: counted as `host_not_allowed` in a `partial_acquire_failure` (fixture provider);
  - network disabled: `403`, and no engine run;
  - research or visuals state changing during acquisition: `revision_mismatch` after the network phase, nothing recorded;
  - a valid, explicitly confirmed acquisition succeeds.
- **Real-engine integration (required, offline).** A successful G3 on non-fixture images:
  1. create; fixture draft; narration rewritten and attested (as in M3's G2 test); G1;
  2. `visuals-plan`;
  3. import a **genuinely public-domain or openly licensed image** for every scene, through `visuals-import --stdin`, with full provenance;
  4. clear the rights of each `manual_review` import with `visuals-edit` (bound to its bytes, recorded in the clearance history);
  5. select a shot per scene with `visuals-edit`;
  6. validate, then apply with the validated revision (G1 now out of date; every scene `applied_current`);
  7. `draft-approve`.

  The CLI then reports `G3 visuals: ready` and G1 approved. The test also checks that:
  - an applied asset image is served through the asset endpoint at its hash, and an outdated hash gives `409 image_changed`;
  - after `draft-export` (in the test's own project), `production-check --mode release --json` lists no visuals or image release blockers;
  - a stale revision on apply is refused;
  - a clearance does not survive a changed image.

  The images are committed under `backend/tests/fixtures/visuals/` with a `SOURCE.md` giving the Commons file page, the revision or upload date, the licence and the attribution.
- **Other negative paths:**
  - a placeholder image never shown as publishable;
  - a clearance refused for a wrong acknowledgement;
  - a chart scene refusing a non-imported image;
  - a human-edit conflict on apply (`draft_edited`), shown and not overwritten;
  - `history_tampered`;
  - a CLI hand edit producing a UI conflict.
- **Frontend component tests:**
  - selection, and its keyboard and focus;
  - the clearance form, with the exact acknowledgement, no prefill, and the changed-image lock;
  - labels for placeholder and mock images;
  - every `apply_state` value and per-asset fact, and the G3-not-applied note;
  - the host-confirmation dialog;
  - apply's G1 warning;
  - an `image_changed` response triggering a view refresh;
  - the recovery banner: its findings and `next_action` as text, every action disabled, gates and facts marked not certified, a `409 recovery_required` triggering a refresh, and the informational note for a package journal alone;
  - conflict and recovery.
- **E2E (fake and real engine).** The journey above, with axe WCAG 2.2 AA on every tab and dialog; 1440, 768 and 375 px; 200% zoom; reduced motion.
- **CI.** The real-engine script minimums rise, and `ENGINE_REF` is bumped per UI PR. A live Wikimedia smoke test is recorded by hand in `docs/m4-verification.md`, not in CI.

## Delivery plan (independently reviewable PRs; none merged automatically)

```
UI-0 (this spec) ─► V1 engine: visuals CLI contract ─► V2 engine: visuals-edit (selection, clearances, plan) [+ G3 change, decision 5]
                      └─► UI-A read-only workspace, plan job, previewed Wikimedia acquire, gallery, import   (needs V1)
                                                   V1 + V2 ─► UI-B selection, clearances, plan narrowing, validation, apply, G1 again, G3
```

| PR | Repository | Depends on | Content | Verified by |
|---|---|---|---|---|
| UI-0 | UI | none | this specification and the roadmap | review |
| V1 (**merged**, PR #16, `65c5f52`) | engine | UI-0 reviewed | `visuals-state` (one consistent read-only snapshot, journal manifests included: `revision`, `inputs`, per-candidate `integrity`, per-scene `apply_state`, per-asset `problem`/`rights_current` from the existing release functions, G1 and G3 from the existing gate functions, `pending_journals` and `recovery_required`); `--json` and the error envelope with the stable codes; `--expect-revision` everywhere (acquire re-checked after the network phase, import before publishing); the canonical, read-only acquisition preview (refusing `recovery_required`) with `--expect-preview` and `--allow-host`; `visuals-import --stdin`; apply restoring a missing applied image; progress | engine pytest, including the selection/apply/G3 cases above at `fb6bffc` semantics |
| V2 (V2a **merged**, PR #17, `c089089`; V2b **merged**, PR #18, `26c608f`) | engine | V1 | `visuals-edit` (shots; clearances bound by the engine to the image bytes and rights fingerprint, with expected values; revocation; plan narrowing); byte verification under the lock; the hash-chained clearance history in the revision; a strict patch, atomic publication; the G3 and release gate change (decision 5) with its decision entry | engine pytest |
| UI-A (**merged**, UI PR #16) | UI | V1 | the visuals view (from `visuals-state`), the two hash-addressed image endpoints with the snapshot freshness check, the plan job, the preview-bound acquire job, the gallery, the import upload, the `apply_state` and asset-fact display, the pending-recovery banner and `409 recovery_required` refusals, navigation | backend, frontend, E2E, real-engine script, CI |
| UI-B (**implemented**, branch `feat/m4-ui-b`) | UI | V1, V2 | selection, clearances (bound dialog, history, revocation), plan narrowing, validation, apply with the G1 warning and re-approval link, G3 display; the required real-engine G3 success test with genuinely licensed images | same, plus the manual live Wikimedia smoke test |

## Non-goals
- Paid image generation, API keys, OpenAI or any chargeable call: the UI never offers `--image-provider openai` or `--allow-paid`.
- Narration audio, rendering, release checks and publishing (M5, M6).
- Serving contact sheets (owner decision 6).
- Image editing, cropping or upscaling in the browser.
- Editing tool-owned files (`candidates.json`, `provenance.json`, `applied.json`, `assets.json`, the report) or the draft from the visuals page.
- Repairing a corrupted asset file from the UI: the engine refuses it and the CLI user resolves it.
- Bypassing licences, robots or access controls.
- Force or replace flags, and `resume`.
- Recovering an interrupted publication from the browser: the view shows the engine's `next_action`, and the CLI user recovers it (a later milestone may add an explicit recovery action).

## Definition of done
- [x] V1 and V2 are merged in the engine and recorded in `engine-compatibility.md`. `ENGINE_REF` pins the minimum. The merged engine matches owner decisions 1–6 (approved). (V1: `65c5f52`. V2a: `c089089`. V2b: `26c608f`, pinned.)
- [ ] The browser performs every visuals action only by invoking supported engine commands. The UI and backend never write, move or delete engine-owned files directly; reading documented artifacts is the only direct file access.
- [ ] Network requests go only to hosts the reviewer confirmed for that exact acquisition. The confirmation is bound to the engine's canonical preview (`preview_sha256`), checked by the backend and by the engine (`preview_mismatch` at both), and invalidated by any parameter or revision change. With `YTA_VISUALS_NETWORK=false` there are none. No paid call is possible from the UI.
- [ ] Image integrity holds end to end:
  - selection, clearance, validation and apply verify candidate bytes against the engine's recorded hashes;
  - applied asset images are checked through the existing `applied.json` and content-address chain, and a missing or modified one is never shown as intact or eligible;
  - a changed, missing or replaced image is refused with `image_integrity`;
  - a clearance never applies to different bytes or changed rights evidence, and is recorded only for the bytes the reviewer was shown.
- [ ] Images are served only by engine ID and expected hash, from a record in a snapshot verified current, on the exact bytes verified. An outdated URL gets `image_changed`, never old bytes. Unchanged images are cached as immutable.
- [ ] Every mutation, including acquire after its network phase and import before publishing, is checked against the revision the reviewer loaded. Conflicts never overwrite.
- [ ] While `recovery_required` is true, the workspace shows the pending journals and the engine's next action, offers no visuals action, and never presents a gate or fact as certified; the backend refuses every visuals write and the preview with `recovery_required`, and no read-only path recovers or writes.
- [ ] Rights status and reasons are the engine's. Placeholder, mock and uncleared `manual_review` images are never shown as publishable. Clearances need the exact acknowledgement and are kept in a hash-chained history, part of the visuals revision. Revocation needs a reviewer and reason, and never deletes assets or changes the draft.
- [ ] The workspace shows the engine's `apply_state` and per-asset facts for all seven conceptual states, with no frontend state machine.
- [ ] Imports reach the engine only as bytes on stdin, size- and format-checked; no path crosses the boundary.
- [ ] Apply warns about G1 and leads to re-approval. G3 is shown as the engine reports it, never approved, inferred, strengthened or weakened by the UI.
- [ ] The required real-engine test reaches `G3 visuals: ready` offline with genuinely licensed images, every scene `applied_current`, and no visuals release blockers after export. M1–M3 flows still pass, and CI and the real-engine script pass.
- [ ] The gallery and forms meet WCAG 2.2 AA at all three widths, at 200% zoom and with reduced motion.
- [ ] Each PR is reviewed, with no automatic merge.

## Claude Code handoff
- **Read first:** `CLAUDE.md`, `docs/architecture.md`, `docs/engine-compatibility.md`, `docs/api-contract.md`, `docs/ui-design.md`, this file, and the engine's `docs/milestone-4-visuals.md` and decisions D-58…D-75.
- **Order:** V1, V2 on engine feature branches, then UI-A, UI-B.
- **Verify engine facts** again at the current engine `main` before relying on them, and never invent adapter flags the engine lacks.
- **Process:** each PR is a draft with its own tests and docs, merged only on the owner's explicit request.
