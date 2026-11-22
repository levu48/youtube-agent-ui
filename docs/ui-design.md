# UI Design Specification — youtube-agent-ui

**Version:** 0.1 | **Target:** local macOS desktop web application | **Status:** implementation specification

## 1. Product experience

Build a professional, approachable documentary-production workspace. Prioritize a guided **project → draft → review** journey over a generic admin dashboard. Milestone 1 is desktop-first, accessible, and responsive; later milestones extend the same shell into research, visuals, narration, rendering, and final review.

**Design principles**
1. Show the next useful action prominently; do not overwhelm users with engine internals.
2. Display real engine stage and job state. Never invent completion percentages.
3. Preserve human editorial control and explicit review gates.
4. Keep long-running work visible and recoverable after navigation or refresh.
5. Distinguish project lifecycle, stage status, and job status.
6. Use Vietnamese-friendly typography, wrapping, search, and document rendering.

## 2. Visual identity and tokens

- Style: restrained creative studio, not flashy marketing UI.
- Default: light content surfaces with a dark navy left sidebar.
- Optional full dark theme is **not required** in Milestone 1.
- Font: Geist or Inter, with system sans-serif fallbacks supporting Vietnamese diacritics.
- Icons: Lucide; use shadcn/ui primitives and Tailwind tokens.
- Color tokens (initial values; expose through CSS variables):
  - `--sidebar: #172238`; `--sidebar-active: #334766`; `--sidebar-text: #D4DEEC`
  - `--background: #F8FAFC`; `--surface: #FFFFFF`; `--surface-muted: #F1F5F9`
  - `--foreground: #0F172A`; `--muted-foreground: #64748B`
  - `--primary: #2563EB`; `--primary-foreground: #FFFFFF`
  - `--success: #15803D`; `--warning: #B45309`; `--danger: #B91C1C`
  - `--border: #E2E8F0`; `--focus: #2563EB`
- Status must not rely on color alone: pair color with label and, where useful, icon.
- Radius: 8px for controls, 12px for cards, 16px for large panels.
- Spacing: 4px base scale; page padding 24–32px desktop, 16px compact.
- Typography: 28–32px page title, 18–20px section title, 14–16px body, >=12px supporting text. Avoid tiny labels for critical information.
- Shadows: subtle or none; use borders to separate workspace sections.

## 3. App shell and navigation

Desktop layout:
```
┌──────────────────┬──────────────────────────────────────────────────────┐
│ YT Agent Studio  │ Page title                         Engine ● Local   │
│                  ├──────────────────────────────────────────────────────┤
│ Dashboard        │                                                      │
│ Projects         │ Main content                                         │
│ ───────────────  │                                                      │
│ Drafts *         │                                                      │
│ Research *       │                                                      │
│ Visuals *        │                                                      │
│ Narration *      │                                                      │
│ Production *     │                                                      │
│                  │                                                      │
│ Settings *       │                                                      │
└──────────────────┴──────────────────────────────────────────────────────┘
* Future milestone: visibly disabled or labeled 'Coming later'; no dead links.
```
- Sidebar: 220–240px desktop; fixed/persistent; active route highlighted and announced to assistive technology.
- Top bar: page title/breadcrumb, local engine status, optional active-job indicator.
- Main region: max-width ~1440px, fluid; avoid excessive empty space on wide monitors.
- Under 1024px: collapsible sidebar/drawer; under 640px: stacked cards and single-column forms.
- The UI runs at `127.0.0.1:3000`; links remain within the local app.
- Navigation items in M1: **Dashboard**, **Projects**. Draft is accessible within a project; future modules must not pretend to work.
- Project breadcrumb: `Projects / <project title> / Draft`.
- Use a persistent toast region for short confirmations; durable errors belong inline as well.

## 4. Screen specifications (Milestone 1)

### 4.1 Dashboard — `/`

**Primary goal:** see projects and resume the next action.

Layout:
- Header: `My Projects`, subtitle `Documentary production workspace`, primary `New Project` button.
- Compact health row: engine available/unavailable; Ollama available/unavailable; model details on click.
- Project list/grid: project title, language, target duration, **engine-reported** current stage, last activity, next action, active job indicator.
- Each project card is a navigable link with a clear accessible name.
- Optional stage strip: use named stages, with completed/current/pending derived from engine status; if unavailable show `Status unavailable`, not guessed progress.
- Recent jobs panel: status, project, started time, `View logs` link.

States:
- Empty: `No projects yet` + `Create your first project`.
- Loading: skeletons with stable dimensions.
- Engine unavailable: nonblocking alert with setup guidance and `Retry connection`.
- Partial status: show known metadata; indicate status cannot be loaded.
- Error: actionable inline message, retry, no fabricated placeholder project counts.

### 4.2 New Project — `/projects/new`

**Primary goal:** create a valid engine project without initiating a long AI run.

Form order:
1. Documentary topic / idea (required multiline).
2. Project slug (required; suggested from topic; editable until manually changed).
3. Language (`Vietnamese`, `English`; default configurable).
4. Target duration (minutes in UI; API uses seconds; accepted 60–3600 seconds).
5. Audience (optional).
6. Tone (optional).
7. Editorial guidance (optional multiline).
8. Read-only `Project location` preview (server-derived safe root + slug).

Actions:
- Primary: `Create Project`.
- Secondary: `Cancel`.
- On success: navigate to project workspace and present `Generate Draft`.
- Do **not** trigger Ollama drafting as part of project creation in M1.
- Show validation next to the field, preserve input after failures, disable double submission.
- Never expose a freeform absolute path input.
- Explain local-only storage in small supporting copy.

### 4.3 Project workspace — `/projects/[projectId]`

**Primary goal:** understand state, start draft, monitor progress.

Layout:
- Breadcrumb and title.
- Metadata row: language, duration, project slug.
- Stage progress/stepper with names; current stage and human gate clearly labeled.
- Main card: `Next action`, using the engine's real status or `Unable to determine`.
- `Generate Draft` panel: local Ollama health, available model selection, `Generate Draft` button; show actionable missing-model guidance.
- Active job card: status badge (`Queued`, `Running`, `Succeeded`, `Failed`, `Cancelled`, `Interrupted`), start time, real logs, `Cancel job` where allowed.
- Recent jobs: latest first; persistent across refresh.
- `View Draft` when artifacts exist; draft-check status where available.
- Long logs: bounded-height scroll region, monospace, selectable text, accessible `Copy logs`, timestamps if available.
- Show stage state and job state separately (e.g., `Draft awaiting review` vs `Last draft job succeeded`).
- No arbitrary CLI argument field or shell terminal.

### 4.4 Draft viewer — `/projects/[projectId]/draft`

**Primary goal:** read generated content safely and see validation.

Layout:
- Header: `Draft`, project breadcrumb, read-only badge.
- Desktop: outline navigation pane (approximately 28%) and script content pane (approximately 72%).
- Small screens: outline collapses above script.
- Show headings/sections, paragraph spacing, Vietnamese text and punctuation faithfully.
- Render Markdown with safe renderer; raw HTML disabled; external links use safe link attributes.
- Validation panel: results from `draft-check`, distinguish warnings/errors/approval requirements.
- Missing/partial artifact: explanatory empty state and link back to project.
- Actions: `Back to Project`, `Refresh`, optional `Copy text`; no save/edit/approve controls in M1.
- No unverified claim that a draft is approved.

### 4.5 Milestone 2 (first part): validation and G1 approval on the draft page
Implemented before editing, which waits for an engine edit command (see `milestone-2.md`).
- **Header:** keeps the `Read-only` badge, because the text is still not editable, and adds the engine's G1 badge: `G1 not approved`, `G1 approved`, `G1 approval out of date` or `G1 approval unconfirmed`. The last one appears when the engine reports approved, but the UI could not confirm the approval covers the version the reviewer validated. It is never shown as `G1 approved`.
- **Actions:** `Refresh` becomes `Validate Draft`, which runs the engine's draft-check again. The validation panel says that passing checks is not approval.
- **Approval panel** (`Editorial approval (G1)`), below validation:
  - **The engine's record**, if one exists: the reviewer, time and comment.
    - Current: green background.
    - Stale: amber background, naming the changed files ("Previously approved by …").
    - Unconfirmed: amber background, "Unconfirmed approval by …". It explains that a file changed while the approval was recorded, and asks the reviewer to review the current version and approve it to confirm.
  - **The form**, hidden while the approval is current and confirmed:
    - a required reviewer name, remembered in this browser only;
    - an optional comment;
    - the button `Approve Editorial Draft (G1)`. When it is disabled, its description gives the reason: a job is running, the check failed or couldn't run, the draft changed while it was being checked, or the engine report could not be verified (the server's `review_token_reason`).
  - **Confirmation dialog** `Approve this editorial draft (G1)?`. It says approval does **not** verify historical claims, rights or release readiness. It lists the review blockers that will be recorded with the approval, in a scrollable list that keyboard users can focus. Its buttons are `Go back` and `Approve draft`.
  - **Errors** appear in an alert in the panel:
    - an engine refusal, with the engine's list of errors;
    - a changed draft, with `Load the latest draft`;
    - a conflict;
    - an unconfirmed approval (`approval_unconfirmed`), with `Load the latest draft`.
  - **After approval**, the panel shows what the engine reports, never a state the UI guessed. A mismatch always takes precedence over success: no "approved" toast is shown unless the approved version matches the validated one.
- **Workspace next action:**
  - "Review the draft" / "Review & Approve";
  - "Review the draft again" when the approval is stale;
  - "Check the draft" when the engine reports the draft is invalid.
- **Never:** approval doesn't start research or any other stage, and the UI never writes `review.json`.

### 4.6 Milestone 2: the draft editor (`/projects/[id]/draft`)
The M1 viewer becomes the editorial workspace. The workspace's **Edit Draft** button opens it.
- **Header:**
  - badges `Editable` (or `Read-only` when the engine does not allow an edit), `Unsaved changes` and the engine's G1 status;
  - actions `Back to Project`, `Discard` (only with unsaved edits), `Save`, `Validate Draft` and `Copy text`.
  - When Save is disabled, its description gives the reason: no edits, a field problem, or the engine's reason.
- **Tabs** `Outline`, `Script`, `Validation`:
  - ARIA tabs, with arrow, Home and End keys.
  - A tab's label shows how many sections have unsaved edits ("Outline (2 unsaved)"), and Validation shows the engine's error count.
- **Outline and Script:**
  - A section navigator (28%), with an `Edited` marker on changed sections, beside the selected section's form (72%). Below 1024px they stack.
  - The outline adds a "Title and question" entry.
  - Fields:
    - Outline: title and central question; per section heading, purpose, key points and claims to investigate.
    - Script: heading, narration (large, `lang` of the draft), summary and editorial notes.
    - List fields take one item per line.
  - Every field has a label, an `Unsaved` marker when changed, a character count against the engine's limit, and an inline error tied to it with `aria-describedby`.
  - Section ID, role, timing and spoken units are read-only; the engine recalculates them on save. Review flags set by the engine are shown under the script fields.
  - The Script tab also offers `Full script` (formatted) and `Markdown view` (the engine's `script.md`). Both show the saved draft, and say so while there are unsaved edits.
- **Unsaved state:**
  - Edits are kept against the version loaded when editing started. Validating again does not drop them, and an alert warns if the engine's draft changed meanwhile.
  - Leaving the page (reload, close, or an in-app link) asks first.
  - Browser Back/Forward cannot be intercepted reliably by the App Router, so leaving that way is made harmless instead: while edits are unsaved, they and the draft version they are based on are kept in this tab's `sessionStorage`. Opening the draft page again restores them, with the note "Your unsaved edits were restored". Saving or discarding clears them. If the engine's draft changed meanwhile, the usual "changed since you started editing" alert shows and a save is refused by the engine's revision check. Nothing restored is sent until Save.
  - Approval is not offered while edits are unsaved: the approval panel says so, and the button is disabled.
- **Save:**
  - Shows a pending label while saving. The fields stay editable: the patch and revision are fixed when Save is pressed, and anything typed while the save is pending stays unsaved on top of the newly saved version (a toast says so), to be saved next against the new revision.
  - Afterwards the page shows the engine's draft. A status line lists the files the engine changed, the storyboard sections it re-split and the visual briefs to check. A toast warns if the save made the G1 approval out of date.
  - Errors from the engine (field locations, downstream work, refusals) appear in an alert, and the edits stay.
- **Conflict dialog** "The draft changed since you loaded it":
  - It shows the unsaved edits as plain text in a read-only box, with `Copy my edits` (clipboard, or select the text by hand), `Keep editing` and `Reload latest`.
  - Only `Reload latest` drops the edits. Nothing is ever overwritten or retried automatically.
- **Discard** asks for confirmation.

## 5. Components and design contracts

Implement reusable components:
- `AppShell`, `SidebarNav`, `PageHeader`, `Breadcrumbs`
- `EngineHealthBadge`, `OllamaHealthBadge`
- `ProjectCard`, `ProjectStageStepper`, `NextActionPanel`
- `JobStatusBadge`, `JobLogViewer`, `JobActions`
- `ProjectCreateForm`, `ModelSelector`
- `DraftOutline`, `DraftContent`, `DraftValidationPanel`
- `EmptyState`, `ErrorState`, `LoadingSkeleton`, `ConfirmDialog`

Use typed API contracts and one centralized status-to-presentation mapping. The backend's state remains authoritative. Badge labels must be understandable without color.

## 6. Interaction behavior

- Creation: form submit → pending button → API response → navigate to project; errors retain inputs.
- Draft: select model → start job → receive job ID → subscribe to SSE → render actual log events; poll as fallback.
- SSE disconnect: show `Reconnecting…`; retry with persisted event IDs; don't reset job to `Queued`.
- Cancel: confirmation dialog (`Stop this draft generation?`), request cancel, show `Cancelling…` until confirmed. No claim of cancellation until backend confirms.
- Job completion: refresh project status and show `View Draft` only when artifacts are present.
- Engine unavailable: show clear guidance and a retry action, never silently substitute fixtures in a user's real project.
- Browser refresh: restore project and job status via API, not ephemeral frontend state.
- Any long operation: clear busy state, no fake percentage or fake ETA.

## 7. Accessibility and responsiveness

- Target WCAG 2.2 AA where practical; keyboard navigation and visible focus indicators.
- All form fields have explicit labels, help text and associated error messages.
- Use semantic headings, navigation landmarks, buttons, and status/live regions.
- Do not use icons alone to convey state or actions.
- Dialogs trap focus, restore focus on close, and support Escape.
- Announce job terminal state via polite live region; do not announce every log line.
- Respect `prefers-reduced-motion`; no essential information conveyed only by animation.
- Support 200% zoom without horizontal overflow in core flows.
- Ensure Vietnamese diacritics display correctly in form fields and rendered drafts.

## 8. Scope boundaries and future extension

**In Milestone 1:** dashboard, project creation, project workspace, read-only draft viewer, local health/status, background jobs and logs.

**Not in Milestone 1:** full script editor, research evidence workspace, visual asset gallery, narration waveform editor, video timeline/player, publishing, cloud collaboration, user accounts, theme switching.

Future workflow navigation: `Draft → Research → Visuals → Narration → Render → Review`. These may appear as noninteractive preview labels or stage indicators, but must not lead to nonexistent pages.

## 9. UI acceptance criteria

- [ ] All four M1 routes are implemented and navigable.
- [ ] Dashboard and workspace render loading, empty, error, offline, and active-job states.
- [ ] A project can be created with keyboard only and form errors are understandable.
- [ ] Stage labels reflect engine status, not guessed completion.
- [ ] Active job progress survives refresh; real logs stream or poll.
- [ ] Cancelling requires confirmation and waits for backend confirmation.
- [ ] Draft content is read-only, safe to render, and readable in Vietnamese.
- [ ] Layout works at desktop (1440px), tablet (768px), and mobile (375px).
- [ ] Core flows work with 200% zoom, reduced motion, and keyboard navigation.
- [ ] Visual and interaction conventions are shared through reusable components.
- [ ] Automated component and browser tests cover creation, job states, errors, and draft display.

## 10. Implementation guidance for Claude Code

Read `CLAUDE.md`, `docs/architecture.md`, `docs/api-contract.md`, `docs/engine-compatibility.md`, and `docs/milestones/milestone-1.md` before implementing. Treat this document as the **visual and interaction contract** for M1. Implement design tokens and `AppShell` first; then project screens, job feedback, and draft viewer. Prefer functional, accessible screens to static visual-only mockups. If an engine capability is absent, show a truthful unsupported state rather than inventing data or changing the engine.
