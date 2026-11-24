import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar-nav";
import type { AcquirePreviewResult, VisualCandidate, VisualsView as View } from "@/lib/api";
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
const SHA = "c".repeat(64);
const PSHA = "d".repeat(64);

function cand(over: Partial<VisualCandidate> = {}): VisualCandidate {
  return {
    id: "scene-001-cm-0123456789", scene_id: "scene-001", source_type: "commons", provider: "fixture-search", kind: "archival",
    title: "File:Harbour 1902.jpg", status: "available", selectable: true, placeholder: true, synthetic: false,
    local_path: `render/visuals/candidates/${SHA}.jpg`, sha256: SHA, width: 1600, height: 900, format: "jpg",
    source_page_url: "https://commons.fixture.invalid/wiki/File:Harbour_1902.jpg",
    rights: { status: "accepted", license_name: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0",
      creator: "Fixture Photographer 0", credit_line: "\"Harbour\" by Fixture Photographer 0, CC BY 4.0", restrictions: [],
      reasons: ["licence and attribution evidence complete for the policy"] },
    disclosure_label: null, review_reasons: ["fixture search result: placeholder, not a real source"], warnings: [],
    ...over,
  };
}

function view(over: Partial<View> = {}): View {
  return {
    scheme: "m4-visuals-state-1", revision: REV, revision_scheme: "m4-visuals-revision-1", inputs: {}, evidence_inputs: {},
    pending_journals: [], recovery_required: false, catalog_trusted: true, catalog_problems: [],
    plan: { scenes: [
      { scene_id: "scene-001", section_id: "sec-01", desired_kind: "illustration", brief: "Bến cảng năm 1902", search_query: "harbour 1902",
        search_enabled: true, generation_enabled: false, requires_manual_asset: false },
      { scene_id: "scene-002", section_id: "sec-01", desired_kind: "chart", brief: "A chart", search_query: null,
        search_enabled: false, generation_enabled: false, requires_manual_asset: true },
    ] },
    candidates: { "scene-001": [cand(), cand({ id: "scene-001-cm-abcdefabcd", title: "Manual one", placeholder: false,
      rights: { status: "manual_review", reasons: ["the licence could not be verified automatically"] } })] },
    selection: { scenes: [{ scene_id: "scene-001", shots: [] }] }, clearance_history: null, applied: null, integrity: {},
    scenes: [
      { scene_id: "scene-001", apply_state: "none", draft_shots: [], selection_shots: null, applied_shots: null },
      { scene_id: "scene-002", apply_state: "existing_shots", draft_shots: [{ asset_id: "img-0000000000000001" }], selection_shots: null, applied_shots: null },
    ],
    assets: [],
    report: { render_ready: false, errors: [], warnings: [], scenes: [{ scene_id: "scene-001", disposition: "candidates_available", messages: [] }], unpublishable: [], image_integrity: [] },
    gates: { g1: { status: "approved", findings: [] }, g3: { status: "needs_review", findings: [
      { severity: "blocker", stage: "visuals", code: "visuals_selection_needed", artifact: null, detail: "G3: 2 scene(s) have no selected, applied image", next_action: null },
    ] } },
    narration: { "scene-001": "Năm 1902, bến cảng đông đúc." },
    network: { enabled: true, search_provider: "wikimedia" },
    editing: { supported: false, reason: "Choosing images and recording rights clearances need the engine's visuals-edit command (M4 V2)." },
    active_job_id: null,
    ...over,
  } as View;
}

const PREVIEW: AcquirePreviewResult = {
  preview: { scheme: "m4-acquire-preview-1", project_id: "prj-1", revision: REV, search_provider: "wikimedia-search", image_provider: "none",
    scene_ids: ["scene-001"], queries: [{ scene_id: "scene-001", query: "harbour 1902" }], generate: [], max_candidates_per_scene: 4,
    timeout: 30, concurrency: 2, force: false, hosts: ["commons.wikimedia.org", "upload.wikimedia.org"] },
  preview_sha256: PSHA,
};

function setup(routes: Parameters<typeof mockFetch>[0] = {}, v: View | (() => View) = view()) {
  const calls = mockFetch({
    "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "vi" } }),
    "GET /projects/p1/visuals": () => ({ json: typeof v === "function" ? v() : v }),
    "GET /jobs/job-1": () => ({ json: { id: "job-1", project_id: "p1", type: "visuals-acquire", status: "queued", events: [] } }),
    ...routes,
  });
  renderWithQuery(<VisualsView />);
  return { calls, user: userEvent.setup() };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("visuals workspace", () => {
  it("shows the engine's facts: apply states, gates and candidates by hash", async () => {
    setup();
    const card = (await screen.findByRole("heading", { name: "scene-001" })).closest("li")!;
    expect(within(card).getByText("No images yet")).toBeInTheDocument();
    expect(within(card).getByText("Năm 1902, bến cảng đông đúc.")).toHaveAttribute("lang", "vi");
    const img = within(card).getByRole("img", { name: /File:Harbour 1902\.jpg — candidate for: Bến cảng năm 1902/ });
    expect(img).toHaveAttribute("src", `/api/v1/projects/p1/visuals/candidates/scene-001-cm-0123456789/image?sha256=${SHA}`);
    expect(within(card).getByText("Test image: never publishable")).toBeInTheDocument();
    expect(within(card).getByText("Licence evidence complete")).toBeInTheDocument();
    expect(within(card).getByText("Needs a human rights review")).toBeInTheDocument();
    expect(screen.getByText("Keeps its current images")).toBeInTheDocument();
    expect(screen.getByText("Needs an image you provide")).toBeInTheDocument();
    expect(screen.getByText("G1 approved")).toBeInTheDocument();
    expect(screen.getAllByText("G3 needs review").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 scene\(s\) have no selected, applied image/)).toBeInTheDocument();
    expect(screen.queryByText(/^Publishable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument(); // no G3 approval
    for (const a of within(card).getAllByRole("link", { name: /Commons page/ })) expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("plans visuals with the revision it loaded", async () => {
    const { calls, user } = setup(
      { "POST /projects/p1/visuals/plan": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }) },
      view({ plan: null, candidates: {} }),
    );
    await user.click(await screen.findByRole("button", { name: /Plan visuals/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ expected_revision: REV });
  });

  it("asks for an approved draft before planning", async () => {
    setup({}, view({ plan: null, gates: { g1: { status: "not_approved", findings: [] }, g3: { status: "pending", findings: [] } } }));
    expect(await screen.findByRole("link", { name: "Open the draft" })).toHaveAttribute("href", "/projects/p1/draft");
    expect(screen.queryByRole("button", { name: /Plan visuals/ })).not.toBeInTheDocument();
  });

  it("blocks every action while a publication must be recovered, and says nothing is certified", async () => {
    setup({}, view({
      recovery_required: true,
      gates: { g1: { status: "recovery_required", findings: [] }, g3: { status: "ready", findings: [] } },
      pending_journals: [{ severity: "blocker", stage: "draft", code: "recovery_required", artifact: null,
        detail: "draft/visuals publication was interrupted and is still pending", next_action: "ytagent resume --project-root <project>" }],
    }));
    const banner = await screen.findByRole("alert", { name: /interrupted publication must be recovered/ });
    expect(within(banner).getByText(/draft\/visuals publication was interrupted/)).toBeInTheDocument();
    expect(within(banner).getByText("ytagent resume --project-root <project>").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: /Search Wikimedia Commons/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Import image/ })).toBeDisabled();
    for (const b of screen.getAllByRole("button", { name: /Import an image for/ })) expect(b).toBeDisabled();
    expect(screen.getAllByText(/not certified: recovery pending/).length).toBeGreaterThan(1);
  });

  it("notes a pending package journal without blocking anything", async () => {
    setup({}, view({ pending_journals: [{ severity: "blocker", stage: "package", code: "recovery_required", artifact: null,
      detail: "production package publication was interrupted", next_action: "ytagent resume" }] }));
    expect(await screen.findByText(/production package publication is pending recovery/)).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: /must be recovered/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search Wikimedia Commons/ })).toBeEnabled();
  });

  it("starts a search only for the exact preview the reviewer confirmed", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/visuals/acquire/preview": () => ({ json: PREVIEW }),
      "POST /projects/p1/visuals/acquire": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }),
    });
    await user.click(await screen.findByRole("button", { name: /Search Wikimedia Commons/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search for images" });
    const start = within(dialog).getByRole("button", { name: /Start search/ });
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Check what would be searched/ }));
    const hosts = await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    expect(within(hosts).getAllByRole("listitem").map((li) => li.textContent)).toEqual(PREVIEW.preview.hosts);
    expect(start).toBeDisabled();
    const confirm = within(dialog).getByRole("checkbox", { name: /I confirm this search/ });
    await user.click(confirm);
    // Changing a parameter drops the preview and its confirmation.
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "5" } });
    expect(within(dialog).queryByRole("list", { name: "Hosts that may be contacted" })).not.toBeInTheDocument();
    expect(start).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "4" } });
    await user.click(within(dialog).getByRole("button", { name: /Check what would be searched/ }));
    await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    expect(within(dialog).getByRole("checkbox", { name: /I confirm this search/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: /I confirm this search/ }));
    await user.click(start);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/visuals/acquire"))).toBeTruthy());
    expect(calls.find((c) => c.path.endsWith("/visuals/acquire"))!.body).toEqual({
      scene_ids: [], max_candidates_per_scene: 4, expected_revision: REV, network: true,
      preview_sha256: PSHA, allow_hosts: PREVIEW.preview.hosts,
    });
  });

  it("drops a preview answer that arrives after a newer check", async () => {
    let n = 0;
    let release: (() => void) | null = null;
    setup({
      "POST /projects/p1/visuals/acquire/preview": async () => {
        n += 1;
        if (n === 1) await new Promise<void>((r) => (release = r));
        return { json: n === 1 ? { ...PREVIEW, preview: { ...PREVIEW.preview, hosts: ["old.example.org"] } } : PREVIEW };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Search Wikimedia Commons/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search for images" });
    await user.click(within(dialog).getByRole("button", { name: /Check what would be searched/ }));
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "3" } }); // drops check 1
    await user.click(within(dialog).getByRole("button", { name: /Check what would be searched/ }));
    await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    release!();
    await new Promise((r) => setTimeout(r, 20));
    expect(within(dialog).queryByText("old.example.org")).not.toBeInTheDocument();
  });

  it("shows what changed when the backend refuses a stale confirmation, unconfirmed", async () => {
    const fresh = { ...PREVIEW.preview, hosts: ["commons.wikimedia.org", "upload.wikimedia.org", "new.wikimedia.org"] };
    setup({
      "POST /projects/p1/visuals/acquire/preview": () => ({ json: PREVIEW }),
      "POST /projects/p1/visuals/acquire": () => ({ status: 409, json: { error: { code: "preview_mismatch",
        message: "What this search would contact changed since you confirmed it.",
        details: { checked_by: "backend", preview: fresh, preview_sha256: "e".repeat(64) } } } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Search Wikimedia Commons/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search for images" });
    await user.click(within(dialog).getByRole("button", { name: /Check what would be searched/ }));
    await user.click(await within(dialog).findByRole("checkbox", { name: /I confirm this search/ }));
    await user.click(within(dialog).getByRole("button", { name: /Start search/ }));
    expect(await within(dialog).findByText("new.wikimedia.org")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /I confirm this search/ })).not.toBeChecked();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/changed since you confirmed/);
  });

  it("turns the search off when network visuals actions are disabled", async () => {
    setup({}, view({ network: { enabled: false, search_provider: "wikimedia" } }));
    expect(await screen.findByRole("button", { name: /Search Wikimedia Commons/ })).toBeDisabled();
    expect(screen.getByText(/YTA_VISUALS_NETWORK=false/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import image/ })).toBeEnabled();
  });

  it("uploads an import with every text field before the file", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/visuals/import": () => ({ json: { result: { candidate_id: "scene-002-imp-0123456789", scene_id: "scene-002",
        sha256: SHA, width: 640, height: 360, rights_status: "manual_review", warnings: [], revision: "f".repeat(64) }, visuals: view() } }),
    });
    await user.click(await screen.findByRole("button", { name: /Import an image for scene-002/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import an image" });
    expect(within(dialog).getByRole("combobox", { name: "Scene" })).toHaveValue("scene-002");
    const submit = within(dialog).getByRole("button", { name: /Import image/ });
    expect(submit).toBeDisabled();
    await user.upload(within(dialog).getByLabelText(/Image file/), new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "chart.png", { type: "image/png" }));
    await user.type(within(dialog).getByLabelText(/Provenance/), "A chart I drew myself.");
    await user.type(within(dialog).getByLabelText("Creator"), "Nguyễn Văn A");
    await user.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/visuals/import"))).toBeTruthy());
    const body = calls.find((c) => c.path.endsWith("/visuals/import"))!.body as Record<string, string>;
    expect(Object.keys(body)).toEqual(["expected_revision", "scene_id", "kind", "provenance", "creator", "file"]);
    expect(body).toMatchObject({ expected_revision: REV, scene_id: "scene-002", kind: "archival", file: "file:chart.png" });
  });

  it("refuses an import over 20 MB before uploading it", async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Import image/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import an image" });
    const big = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await user.upload(within(dialog).getByLabelText(/Image file/), big);
    await user.type(within(dialog).getByLabelText(/Provenance/), "My own photograph.");
    expect(within(dialog).getByText(/larger than 20 MB/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Import image/ })).toBeDisabled();
    expect(calls.some((c) => c.path.endsWith("/visuals/import"))).toBe(false);
  });

  it("refreshes the view once when an image no longer loads", async () => {
    const { calls } = setup();
    const img = (await screen.findAllByRole("img", { name: /File:Harbour 1902\.jpg/ }))[0];
    const before = calls.filter((c) => c.path === "/projects/p1/visuals").length;
    fireEvent.error(img);
    await waitFor(() => expect(calls.filter((c) => c.path === "/projects/p1/visuals").length).toBe(before + 1));
    fireEvent.error(img);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.path === "/projects/p1/visuals").length).toBe(before + 1);
  });

  it("notes that G3 does not require the selection to be applied", async () => {
    setup({}, view({ gates: { g1: { status: "approved", findings: [] }, g3: { status: "ready", findings: [] } } }));
    expect(await screen.findByText("G3 does not require the selection to be applied; apply it before rendering.")).toBeInTheDocument();
  });

  it("shows each applied image's facts, including an ambiguous binding", async () => {
    const { user } = setup({}, view({ assets: [{
      asset_id: "img-0000000000000001", scene_ids: ["scene-002"], candidate_id: null,
      candidate_ids: ["scene-002-cm-0000000001", "scene-002-cm-0000000002"], candidate_binding: "ambiguous", sha256: SHA,
      local_path: `assets/images/${SHA}.png`, image: "mismatch", record_intact: true, problem: "image file does not match", credit_problems: [],
      fixture: true, rights_current: false, rights_reason: "candidate_ambiguous",
    }] }));
    await user.click(await screen.findByRole("tab", { name: "Applied images" }));
    expect(screen.getByText("Image file modified (bytes do not match)")).toBeInTheDocument();
    expect(screen.getByText(/several candidates have these bytes, and the engine picks none/)).toBeInTheDocument();
    expect(screen.getByText(/not current — Applied before candidate tracking/)).toBeInTheDocument();
    expect(screen.getByText("Test image: never publishable")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Applied image/ })).not.toBeInTheDocument(); // not intact: not shown
  });

  it("hides every image of an untrusted catalogue", async () => {
    setup({}, view({ catalog_trusted: false, catalog_problems: ["render/visuals/candidates.json is not the file the tool last wrote"] }));
    expect(await screen.findByText(/nothing in it is trusted or shown/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /File:Harbour/ })).not.toBeInTheDocument();
  });

  it("links Visuals only inside a project", () => {
    const { rerender } = renderWithQuery(<SidebarNav pathname="/projects/p1/visuals" />);
    expect(screen.getByRole("link", { name: "Visuals" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Projects" })).not.toHaveAttribute("aria-current");
    rerender(<SidebarNav pathname="/" />);
    expect(screen.queryByRole("link", { name: "Visuals" })).not.toBeInTheDocument();
  });
});

describe("malformed engine records", () => {
  it("never renders a non-text value from the plan", async () => {
    const v = view();
    (v.plan!.scenes[0] as unknown as { brief: unknown }).brief = { description: "x", suggested_kind: "photo" };
    setup({}, v);
    expect(await screen.findByRole("heading", { name: "scene-001" })).toBeInTheDocument();
  });
});
