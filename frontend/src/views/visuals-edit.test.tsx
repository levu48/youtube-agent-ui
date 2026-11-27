import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplyState, VisualCandidate, VisualsView as View } from "@/lib/api";
import { APPLY_STATE, RIGHTS_REASON } from "@/lib/status";
import { mockFetch, renderWithQuery } from "@/test/utils";
import { VisualsView } from "@/views/visuals-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/p1/visuals",
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const REV = "a".repeat(64);
const REV2 = "b".repeat(64);
const SHA = "c".repeat(64);
const SHA2 = "e".repeat(64);
const FP = "f".repeat(64);
const ACK =
  "I reviewed the source and licence of this exact image and take responsibility for this rights decision. The tool did not verify it and it is not legal advice.";

function cand(over: Partial<VisualCandidate> = {}): VisualCandidate {
  return {
    id: "scene-001-cm-0123456789", scene_id: "scene-001", source_type: "commons", provider: "wikimedia-search", kind: "archival",
    title: "File:Harbour 1902.jpg", status: "available", selectable: true, placeholder: false, synthetic: false,
    local_path: `render/visuals/candidates/${SHA}.jpg`, sha256: SHA, width: 1600, height: 900, format: "jpg",
    source_page_url: "https://commons.wikimedia.org/wiki/File:Harbour_1902.jpg",
    rights: { status: "accepted", license_name: "CC BY 4.0", creator: "A. Photographer", reasons: [] },
    disclosure_label: null, review_reasons: [], warnings: [], rights_fingerprint: FP,
    ...over,
  };
}

const MANUAL = cand({
  id: "scene-001-imp-abcdefabcd", title: "Card import", source_type: "import", sha256: SHA2,
  local_path: `render/visuals/candidates/${SHA2}.png`,
  rights: { status: "manual_review", license_name: null, creator: null, reasons: ["imported: a human must clear its rights"] },
  source_page_url: null,
});

function view(over: Partial<View> = {}): View {
  return {
    scheme: "m4-visuals-state-1", revision: REV, revision_scheme: "m4-visuals-revision-1", inputs: {}, evidence_inputs: {},
    pending_journals: [], recovery_required: false, catalog_trusted: true, catalog_problems: [],
    plan: { scenes: [
      { scene_id: "scene-001", section_id: "sec-01", desired_kind: "illustration", brief: "Harbour", search_query: "harbour 1902",
        search_enabled: true, generation_enabled: false, requires_manual_asset: false, notes: "" },
      { scene_id: "scene-002", section_id: "sec-01", desired_kind: "chart", brief: "A chart", search_query: null,
        search_enabled: false, generation_enabled: false, requires_manual_asset: true, notes: "" },
    ] },
    candidates: { "scene-001": [cand(), MANUAL] },
    selection: { scenes: [{ scene_id: "scene-001", shots: [] }, { scene_id: "scene-002", shots: [] }], rights_clearances: [] },
    clearance_history: null, applied: null, integrity: {},
    scenes: [
      { scene_id: "scene-001", apply_state: "none", draft_shots: [], selection_shots: null, applied_shots: null },
      { scene_id: "scene-002", apply_state: "none", draft_shots: [], selection_shots: null, applied_shots: null },
    ],
    assets: [],
    report: { render_ready: false, errors: [], warnings: [], unpublishable: [], image_integrity: [], scenes: [
      { scene_id: "scene-001", disposition: "candidates_available", messages: [], render_ready: false, ready_via: null,
        publication_blockers: [], next_action: "choose candidate id(s) in visual-selection.json" },
      { scene_id: "scene-002", disposition: "not_acquired", messages: [], render_ready: false, ready_via: null,
        publication_blockers: [], next_action: "run visuals-import for this scene" },
    ] },
    gates: { g1: { status: "approved", findings: [] }, g3: { status: "needs_review", findings: [] } },
    narration: {},
    network: { enabled: true, search_provider: "wikimedia" },
    editing: { supported: true, reason: null, acknowledgement: ACK,
      bases: ["license_confirmed_at_source", "public_domain_confirmed", "permission_obtained", "own_work", "provider_terms_reviewed"],
      motions: ["static", "slow_zoom", "slow_zoom_out", "pan_left", "pan_right"], fits: ["auto", "cover", "contain"], max_shots: 20 },
    active_job_id: null,
    ...over,
  } as View;
}

const EDITED = { status: "published", dry_run: false, previous_revision: REV, revision: REV2, changed_files: ["visual-selection.json"], history: [], check: null };

function setup(routes: Parameters<typeof mockFetch>[0] = {}, v: View | (() => View) = view()) {
  const calls = mockFetch({
    "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "en" } }),
    "GET /projects/p1/visuals": () => ({ json: typeof v === "function" ? v() : v }),
    ...routes,
  });
  renderWithQuery(<VisualsView />);
  return { calls, user: userEvent.setup() };
}

const posts = (calls: ReturnType<typeof mockFetch>, path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const card = async (scene: string) => (await screen.findByRole("heading", { name: scene, level: 3 })).closest("li")!;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("selection", () => {
  it("chooses shots with the keyboard and saves them as one shots.set under the loaded revision", async () => {
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: view() } }) });
    const c1 = await card("scene-001");
    const use = within(c1).getByRole("button", { name: /Use as a shot: File:Harbour 1902\.jpg/ });
    expect(use).toHaveAttribute("aria-pressed", "false");
    use.focus();
    await user.keyboard("{Enter}");
    const chosen = within(c1).getByRole("button", { name: /Shot 1 \(remove\): File:Harbour 1902\.jpg/ });
    expect(chosen).toHaveAttribute("aria-pressed", "true"); // not conveyed by colour alone
    expect(within(c1).getByText("(unsaved changes)")).toBeInTheDocument();
    await user.selectOptions(within(c1).getByLabelText("Motion"), "pan_left");
    await user.click(within(c1).getByRole("button", { name: /Save selection/ }));
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toEqual({
      expected_revision: REV,
      operations: [{ op: "shots.set", scene_id: "scene-001", shots: [{ candidate_id: "scene-001-cm-0123456789", motion: "pan_left" }] }],
    });
  });

  it("removing every shot saves shots.clear", async () => {
    const v = view({ selection: { scenes: [{ scene_id: "scene-001", shots: [{ candidate_id: "scene-001-cm-0123456789" }] }], rights_clearances: [] } });
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: view() } }) }, v);
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: "Remove shot 1" }));
    await user.click(within(c1).getByRole("button", { name: /Clear the selection/ }));
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toMatchObject({ operations: [{ op: "shots.clear", scene_id: "scene-001" }] });
  });

  it("keeps the unsaved shots and offers a reload on a revision conflict", async () => {
    const { user } = setup({
      "POST /projects/p1/visuals/edit": () => ({ status: 409, json: { error: { code: "revision_conflict", message: "changed", details: { current_revision: REV2 } } } }),
    });
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Use as a shot: File:Harbour/ }));
    await user.click(within(c1).getByRole("button", { name: /Save selection/ }));
    expect(await within(c1).findByText(/The visuals changed since you loaded them/)).toBeInTheDocument();
    expect(within(c1).getByRole("button", { name: /Reload latest/ })).toBeInTheDocument();
    expect(within(c1).getByText(/^Shot 1:/)).toBeInTheDocument();
  });

  it("disables every edit while a publication must be recovered", async () => {
    setup({}, view({ recovery_required: true }));
    const c1 = await card("scene-001");
    expect(within(c1).getByRole("button", { name: /Use as a shot: File:Harbour/ })).toBeDisabled();
    expect(within(c1).getByRole("button", { name: /Clear rights…: Card import/ })).toBeDisabled();
    expect(within(c1).getByRole("button", { name: /Narrow the plan/ })).toBeDisabled();
  });
});

describe("rights clearance", () => {
  it("opens empty, shows the image and the exact statement, and sends a bound clearance.set", async () => {
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: view() } }) });
    const c1 = await card("scene-001");
    expect(within(c1).queryByRole("button", { name: /Clear rights…: File:Harbour/ })).not.toBeInTheDocument(); // accepted: nothing to clear
    await user.click(within(c1).getByRole("button", { name: /Clear rights…: Card import/ }));
    const dialog = await screen.findByRole("dialog", { name: "Record a rights clearance" });
    const shown = within(dialog).getByRole("img", { name: /Card import: the image being cleared/ });
    expect(shown).toHaveAttribute("src", `/api/v1/projects/p1/visuals/candidates/scene-001-imp-abcdefabcd/image?sha256=${SHA2}`);
    fireEvent.load(shown); // the reviewer has seen these exact bytes
    expect(within(dialog).getByText(ACK)).toBeInTheDocument();
    expect(within(dialog).getByText(/missing: licence name, creator, source URL/)).toBeInTheDocument();
    const box = within(dialog).getByRole("checkbox", { name: /I make this statement/ });
    expect(box).not.toBeChecked(); // no prefill
    expect(within(dialog).getByLabelText(/^Reviewer/)).toHaveValue("");
    const submit = within(dialog).getByRole("button", { name: /Record clearance/ });
    expect(submit).toBeDisabled();
    // A generated-only basis is not offered for an import.
    expect(within(dialog).queryByRole("option", { name: /Generator terms/ })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.selectOptions(within(dialog).getByLabelText(/^Basis/), "own_work");
    await user.type(within(dialog).getByLabelText(/^Justification/), "The project team drew this card itself for this video.");
    await user.type(within(dialog).getByLabelText(/^Evidence/), "permissions/card.txt");
    expect(submit).toBeDisabled();
    await user.click(box);
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toEqual({
      expected_revision: REV,
      operations: [{
        op: "clearance.set", candidate_id: "scene-001-imp-abcdefabcd", expected_candidate_sha256: SHA2,
        expected_rights_fingerprint: FP, reviewer: "Lan Nguyen", basis: "own_work",
        justification: "The project team drew this card itself for this video.", evidence: "permissions/card.txt", acknowledgement: ACK,
      }],
    });
  });

  it("locks the dialog when the image changes while it is open", async () => {
    let current = view();
    const { calls, user } = setup({}, () => current);
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Clear rights…: Card import/ }));
    const dialog = await screen.findByRole("dialog", { name: "Record a rights clearance" });
    // The CLI replaces the image: same candidate ID, other bytes.
    current = view({ revision: REV2, candidates: { "scene-001": [cand(), { ...MANUAL, sha256: "9".repeat(64) }] } });
    // A background refresh (the page's query) while the modal dialog is open.
    fireEvent.click(screen.getByRole("button", { name: /Check visuals/, hidden: true }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This image or its evidence changed");
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    expect(within(dialog).getByRole("button", { name: /Record clearance/ })).toBeDisabled();
    expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(0);
  });

  it("shows an engine target_changed refusal in the engine's words", async () => {
    const { user } = setup({
      "POST /projects/p1/visuals/edit": () => ({ status: 422, json: { error: { code: "invalid_edit", message: "operation 0 (clearance.set) refused", details: {
        errors: [{ loc: "operations.0", msg: "the rights evidence of scene-001-imp-abcdefabcd changed since you reviewed it", code: "target_changed" }] } } } }),
    });
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Clear rights…: Card import/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.load(within(dialog).getByRole("img"));
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.selectOptions(within(dialog).getByLabelText(/^Basis/), "own_work");
    await user.type(within(dialog).getByLabelText(/^Justification/), "The project team drew this card itself for this video.");
    await user.type(within(dialog).getByLabelText(/^Evidence/), "https://project.example/card");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: /Record clearance/ }));
    expect(await within(dialog).findByText(/changed since you reviewed it/)).toBeInTheDocument();
  });

  it("revokes with a reviewer and a reason, and shows the history", async () => {
    const cleared = view({
      selection: { scenes: [], rights_clearances: [{ candidate_id: MANUAL.id, reviewer: "Lan Nguyen", basis: "own_work", evidence: "permissions/card.txt", evidence_sha256: SHA }] },
      evidence_inputs: { "permissions/card.txt": SHA },
      clearance_history: { entries: [{ id: "ch-00001", seq: 1, action: "set", candidate_id: MANUAL.id, at: "2026-11-27T12:00:00Z", by_reviewer: "Lan Nguyen", reason: null, clearance: null }] },
    });
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: cleared } }) }, cleared);
    const c1 = await card("scene-001");
    expect(within(c1).getByText(/Its bytes are bound/)).toBeInTheDocument();
    expect(within(c1).getByText(/Set by Lan Nguyen on 2026-11-27/)).toBeInTheDocument();
    await user.click(within(c1).getByRole("button", { name: /Revoke clearance…: Card import/ }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke a rights clearance" });
    const submit = within(dialog).getByRole("button", { name: "Revoke clearance" });
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.type(within(dialog).getByLabelText(/^Reason/), "too short");
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/^Reason/), " because the owner withdrew it today");
    await user.click(submit);
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toMatchObject({
      operations: [{ op: "clearance.revoke", candidate_id: MANUAL.id, reviewer: "Lan Nguyen" }],
    });
  });
});

describe("plan narrowing", () => {
  it("sends only the changed fields, and never offers to widen the plan", async () => {
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: view() } }) });
    const c2 = await card("scene-002");
    await user.click(within(c2).getByRole("button", { name: /Narrow the plan for scene-002/ }));
    expect(within(c2).getByRole("checkbox", { name: /cannot be turned on/ })).toBeDisabled();
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Narrow the plan for scene-001/ }));
    await user.click(within(c1).getByRole("checkbox", { name: /Search for images/ }));
    await user.click(within(c1).getByRole("button", { name: /Save plan/ }));
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toEqual({
      expected_revision: REV, operations: [{ op: "plan.update", scene_id: "scene-001", search_enabled: false }],
    });
  });
});

describe("validation and apply", () => {
  const selected = () =>
    view({ selection: { scenes: [{ scene_id: "scene-001", shots: [{ candidate_id: "scene-001-cm-0123456789" }] }], rights_clearances: [] },
      scenes: [{ scene_id: "scene-001", apply_state: "selected_not_applied", draft_shots: [], selection_shots: null, applied_shots: null }] });

  it("applies only the validated revision, warns about G1 and links to re-approval", async () => {
    const applied = view({ revision: REV2, gates: { g1: { status: "stale_after_apply", findings: [] }, g3: { status: "ready", findings: [] } } });
    const { calls, user } = setup({
      "POST /projects/p1/visuals/apply": () => ({ json: { result: { status: "published", scenes_changed: ["scene-001"], assets_added: ["img-0123456789abcdef"],
        assets_unchanged: [], rights_unverified: [], images_restored: [], revision: REV2 }, visuals: applied } }),
    }, selected());
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    const apply = screen.getByRole("button", { name: /Apply selection…/ });
    expect(apply).toBeDisabled();
    expect(screen.getByText("Validate the visuals first.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    const dialog = await screen.findByRole("dialog", { name: "Apply the selection to the draft" });
    expect(within(dialog).getByText(/editorial approval \(G1\) goes out of date/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.click(within(dialog).getByRole("button", { name: /^Apply selection$/ }));
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/apply")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/apply")[0].body).toEqual({ expected_revision: REV, reviewer: "Lan Nguyen", confirm: true });
    expect(await screen.findByText(/Apply: Published/)).toBeInTheDocument();
    for (const l of screen.getAllByRole("link", { name: "Re-approve the draft (G1)" })) expect(l).toHaveAttribute("href", "/projects/p1/draft");
  });

  it("a change after validation spends it", async () => {
    let current = selected();
    const { user } = setup({}, () => current);
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    const apply = screen.getByRole("button", { name: /Apply selection…/ });
    await waitFor(() => expect(apply).toBeEnabled());
    current = { ...selected(), revision: REV2 };
    await user.click(screen.getByRole("button", { name: /Check visuals/ }));
    await waitFor(() => expect(apply).toBeDisabled());
    expect(screen.getByText(/changed since you validated them: validate again/)).toBeInTheDocument();
  });

  it("shows the shared-bytes refusal with the engine's items and the fix", async () => {
    const { user } = setup({
      "POST /projects/p1/visuals/apply": () => ({ status: 409, json: { error: { code: "not_ready", message: "cannot apply visuals:", details: {
        errors: ["scene-001-imp-a and scene-002-imp-b have identical image bytes (asset img-0123456789abcdef) but different provenance or rights, and one asset record cannot carry both: select only one of them"] } } } }),
    }, selected());
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply selection…/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply selection…/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.click(within(dialog).getByRole("button", { name: /^Apply selection$/ }));
    expect(await within(dialog).findByText(/different provenance or rights, and one asset record/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Choose a compatible candidate, or new shots for every scene/)).toBeInTheDocument();
  });
});

describe("engine facts", () => {
  it("names every apply state and rights reason in fixed words", async () => {
    const states = Object.keys(APPLY_STATE) as ApplyState[];
    setup({}, view({
      plan: { scenes: states.map((s, i) => ({ scene_id: `scene-00${i + 1}`, section_id: null, desired_kind: "illustration", brief: s,
        search_query: "q", search_enabled: true, generation_enabled: false, requires_manual_asset: false })) },
      scenes: states.map((s, i) => ({ scene_id: `scene-00${i + 1}`, apply_state: s, draft_shots: [], selection_shots: null, applied_shots: null })),
      candidates: {}, report: { render_ready: false, errors: [], warnings: [], unpublishable: [], image_integrity: [], scenes: [] },
    }));
    for (const s of states) expect(await screen.findByText(APPLY_STATE[s].label)).toBeInTheDocument();
    expect(RIGHTS_REASON.evidence_changed).toMatch(/evidence document/);
  });
});


describe("review fixes", () => {
  const selected = () =>
    view({ selection: { scenes: [{ scene_id: "scene-001", shots: [{ candidate_id: "scene-001-cm-0123456789" }] }], rights_clearances: [] },
      scenes: [{ scene_id: "scene-001", apply_state: "selected_not_applied", draft_shots: [], selection_shots: null, applied_shots: null }] });

  it("FIX-01: a failed validation never enables apply, even with cached data", async () => {
    let fail = false;
    const { user } = setup({
      "GET /projects/p1/visuals": () =>
        fail ? { status: 503, json: { error: { code: "state_unavailable", message: "The engine's visuals state could not be read." } } } : { json: selected() },
    });
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    const apply = screen.getByRole("button", { name: /Apply selection…/ });
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    await waitFor(() => expect(apply).toBeEnabled());
    fail = true; // the next read fails; the cache still holds the old snapshot
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    // The page never shows the old snapshot as current: it shows the failure instead.
    expect(await screen.findByText("The visuals could not be loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply selection…/ })).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    // The failed validation was not kept: apply needs a new, successful one.
    expect(screen.getByRole("button", { name: /Apply selection…/ })).toBeDisabled();
    expect(screen.getByText("Validate the visuals first.")).toBeInTheDocument();
  });

  it("FIX-02: a changed saved selection never replaces unsaved shots; the reviewer chooses", async () => {
    let current = view();
    const { calls, user } = setup({ "POST /projects/p1/visuals/edit": () => ({ json: { result: EDITED, visuals: current } }) }, () => current);
    let c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Use as a shot: File:Harbour/ }));
    expect(within(c1).getByText(/^Shot 1:/)).toBeInTheDocument();
    // The CLI saves another selection for the same scene; the page refreshes.
    current = view({ revision: REV2, selection: { scenes: [{ scene_id: "scene-001", shots: [{ candidate_id: MANUAL.id }] }], rights_clearances: [] } });
    await user.click(screen.getByRole("button", { name: /Check visuals/ }));
    c1 = await card("scene-001");
    const alert = await within(c1).findByRole("alert");
    expect(alert).toHaveTextContent(/changed while you were editing/);
    expect(alert).toHaveTextContent(/Card import/); // the new saved selection is named
    expect(within(c1).getByText(/^Shot 1:/).parentElement).toHaveTextContent("File:Harbour 1902.jpg"); // kept
    expect(within(c1).getByRole("button", { name: /Save selection/ })).toBeDisabled();
    await user.click(within(alert).getByRole("button", { name: /Keep my list/ }));
    await user.click(within(c1).getByRole("button", { name: /Save selection/ }));
    await waitFor(() => expect(posts(calls, "/projects/p1/visuals/edit")).toHaveLength(1));
    expect(posts(calls, "/projects/p1/visuals/edit")[0].body).toMatchObject({
      expected_revision: REV2,
      operations: [{ op: "shots.set", scene_id: "scene-001", shots: [{ candidate_id: "scene-001-cm-0123456789" }] }],
    });
  });

  it("FIX-02: loading the saved selection drops the reviewer's list only when asked", async () => {
    let current = view();
    const { user } = setup({}, () => current);
    let c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Use as a shot: File:Harbour/ }));
    current = view({ revision: REV2, selection: { scenes: [{ scene_id: "scene-001", shots: [{ candidate_id: MANUAL.id }] }], rights_clearances: [] } });
    await user.click(screen.getByRole("button", { name: /Check visuals/ }));
    c1 = await card("scene-001");
    await user.click(await within(c1).findByRole("button", { name: /Load the saved selection/ }));
    expect(within(c1).getByText(/^Shot 1:/).parentElement).toHaveTextContent("Card import");
    expect(within(c1).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("FIX-03: a clearance cannot be recorded for an image that did not load", async () => {
    const { user } = setup();
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Clear rights…: Card import/ }));
    const dialog = await screen.findByRole("dialog", { name: "Record a rights clearance" });
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.selectOptions(within(dialog).getByLabelText(/^Basis/), "own_work");
    await user.type(within(dialog).getByLabelText(/^Justification/), "The project team drew this card itself for this video.");
    await user.type(within(dialog).getByLabelText(/^Evidence/), "permissions/card.txt");
    const box = within(dialog).getByRole("checkbox", { name: /I make this statement/ });
    expect(box).toBeDisabled(); // not loaded yet
    expect(within(dialog).getByText("Waiting for the image to load.")).toBeInTheDocument();
    fireEvent.error(within(dialog).getByRole("img"));
    expect(await within(dialog).findByText(/could not be loaded, so it cannot be cleared/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Record clearance/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Retry the image/ }));
    fireEvent.load(within(dialog).getByRole("img"));
    await user.click(box);
    expect(within(dialog).getByRole("button", { name: /Record clearance/ })).toBeEnabled();
  });

  it("FIX-04: nothing can be edited while a save is running", async () => {
    let release: (v: { json: unknown }) => void = () => {};
    const { user } = setup({ "POST /projects/p1/visuals/edit": () => new Promise((r) => (release = r)) });
    const c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Use as a shot: File:Harbour/ }));
    await user.click(within(c1).getByRole("button", { name: /Save selection/ }));
    expect(await within(c1).findByRole("button", { name: /Saving…/ })).toBeDisabled();
    expect(within(c1).getByRole("button", { name: "Remove shot 1" })).toBeDisabled();
    expect(within(c1).getByLabelText("Motion")).toBeDisabled();
    expect(within(c1).getByRole("button", { name: /Use as a shot: Card import/ })).toBeDisabled();
    expect(within(c1).getByRole("button", { name: /Discard changes/ })).toBeDisabled();
    release({ json: { result: EDITED, visuals: view() } });
    await waitFor(() => expect(within(c1).getByRole("button", { name: /Use as a shot: Card import/ })).toBeEnabled());
  });

  it("FIX-06: unsaved shots survive switching tabs, and validation warns about them", async () => {
    const { user } = setup({}, selected());
    let c1 = await card("scene-001");
    await user.click(within(c1).getByRole("button", { name: /Use as a shot: Card import/ }));
    await user.click(screen.getByRole("tab", { name: "Validate and apply" }));
    const warning = screen.getByText(/Unsaved shot changes in scene-001/);
    expect(warning).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Validate visuals/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Apply selection…/ })).toBeDisabled();
    expect(screen.getByText("Save or discard the unsaved shot changes first.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Scenes and candidates" }));
    c1 = await card("scene-001");
    expect(within(c1).getByText(/^Shot 2:/).parentElement).toHaveTextContent("Card import");
    expect(within(c1).getByText("(unsaved changes)")).toBeInTheDocument();
  });

  it("FIX-07: a not_ready that is not the shared-image conflict is shown in the engine's words only", async () => {
    const { user } = setup({
      "POST /projects/p1/visuals/apply": () => ({ status: 409, json: { error: { code: "not_ready", message: "cannot apply visuals:", details: {
        errors: ["scene-002: candidate scene-002-cm-0123456789 is rejected and cannot be used"] } } } }),
    }, selected());
    await user.click(await screen.findByRole("tab", { name: "Validate and apply" }));
    await user.click(screen.getByRole("button", { name: /Validate visuals/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply selection…/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply selection…/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Lan Nguyen");
    await user.click(within(dialog).getByRole("button", { name: /^Apply selection$/ }));
    expect(await within(dialog).findByText(/is rejected and cannot be used/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/same image/)).not.toBeInTheDocument(); // no shared-image explanation, old or new wording
  });
});
