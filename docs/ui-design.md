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
