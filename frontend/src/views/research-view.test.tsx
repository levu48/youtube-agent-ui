import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar-nav";
import type { ResearchView as View } from "@/lib/api";
import { mockFetch, renderWithQuery } from "@/test/utils";
import { ResearchView } from "@/views/research-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/p1/research",
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const REV = "a".repeat(64);
const SHA = "b".repeat(64);

function view(over: Partial<View> = {}): View {
  return {
    report: {
      approvable: false,
      approval_status: "not_approved",
      applied: false,
      counts: {},
      items: [{ code: "no_sources", claim_id: "clm-001-fake", detail: "no sources collected", blocking: true }],
      claims: [
        {
          id: "clm-001-fake", kind: "factual", assertion: "Ngày 2 tháng 9 năm 1945, Hồ Chí Minh đọc Tuyên ngôn.",
          contested: false, flags: ["date"], status: "unverified", suggested_status: "supported_pending_review",
          scenes: ["scene-001"], supports: [{ snapshot_id: "snap-0000000000000001", source_id: "src-1", start: 0, end: 5,
            source_type: "secondary", acquisition: "fixture", evidence_root: null, is_translation: false, translator: null }],
          contradicts: [], context: [], independent_roots: 0, quotation_basis: null, reviewer: null, rationale: null,
          review_outdated: [], outdated_review: null,
        },
      ],
      coverage: { sentences: 2, covered: 1, uncovered: [{ scene_id: "scene-002", start: 0, end: 10, text: "Một câu chưa có claim." }] },
      revision: REV,
    },
    report_error: null,
    revision: REV,
    started: true,
    sources: [{ id: "src-1", kind: "web", url: "https://archive.example.net/x", host: "archive.example.net", state: "extracted",
      fixture: false, user_supplied: true, candidate_for: [], snapshot_ids: ["snap-0000000000000001"], discoveries: [],
      fetches: [{ at: null, outcome: "fetched", detail: null, final_url: null, snapshot_id: "snap-0000000000000001" }] }],
    snapshots: [],
    evidence: [],
    records_error: null,
    stage: null,
    network: { enabled: true, search_provider: "wikipedia" },
    active_job_id: null,
    ...over,
  } as View;
}

const PREVIEW = {
  revision: REV, hosts: ["en.wikipedia.org", "queued.example.net", "vi.wikipedia.org"],
  search_hosts: ["vi.wikipedia.org", "en.wikipedia.org"], provider_result_hosts: ["en.wikipedia.org", "vi.wikipedia.org"],
  known_targets: [{ source_id: "src-q", url: "https://queued.example.net/page", host: "queued.example.net", reason: "user_supplied" }],
  plan_sha256: SHA, queries: 2, fetch: true, search_provider: "wikipedia",
};

function setup(routes: Parameters<typeof mockFetch>[0] = {}, v = view()) {
  const calls = mockFetch({
    "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "vi" } }),
    "GET /projects/p1/research": () => ({ json: v }),
    "GET /jobs/job-1": () => ({ json: { id: "job-1", project_id: "p1", type: "research-collect", status: "queued", events: [] } }),
    ...routes,
  });
  const { client } = renderWithQuery(<ResearchView />);
  return { calls, client, user: userEvent.setup() };
}

/** Just enough of EventSource for a job's live "completed" event. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(id: number, type: string, data: Record<string, unknown>) {
    const msg = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) });
    for (const cb of this.listeners.get(type) ?? []) cb(msg);
  }
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

function job(type: string, status: string) {
  return {
    id: "job-1", project_id: "p1", type, status, created_at: "2026-11-22T10:00:00Z", started_at: "2026-11-22T10:00:00Z",
    finished_at: status === "running" ? null : "2026-11-22T10:00:05Z", exit_code: status === "running" ? null : 0,
    message: status === "running" ? null : "Claim inventory prepared", error_message: null, error_code: null,
    cancel_requested: false, provider: null, model: null, from_stage: null, events: [], events_truncated: false,
  };
}

describe("research workspace", () => {
  it("shows claims with the engine's status and its suggestion as not a verdict", async () => {
    setup();
    const claim = await screen.findByText(/Hồ Chí Minh đọc Tuyên ngôn/);
    expect(claim).toHaveAttribute("lang", "vi");
    const card = claim.closest("li")!;
    expect(within(card).getByText("Unverified")).toBeInTheDocument();
    expect(within(card).getByText(/tool suggestion \(not a verdict\): Evidence linked, needs a decision/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /verify|approve/i })).not.toBeInTheDocument();
    expect(screen.getByText("Một câu chưa có claim.")).toBeInTheDocument();
    expect(screen.getByText("G2 not approved")).toBeInTheDocument();
  });

  it("prepares claims with the revision it loaded", async () => {
    const { calls, user } = setup(
      { "POST /projects/p1/research/plan": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }) },
      view({ started: false }),
    );
    await user.click(await screen.findByRole("button", { name: /Prepare claims/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ expected_revision: REV });
  });

  it("asks for an approved draft first instead of offering to prepare claims", async () => {
    setup({}, view({ started: false, report: { ...view().report!, items: [
      { code: "editorial_not_current", claim_id: null, detail: "M3 editorial approval: the draft has no M3 approval", blocking: true },
    ] } }));
    expect(await screen.findByRole("link", { name: "Open the draft" })).toHaveAttribute("href", "/projects/p1/draft");
    expect(screen.queryByRole("button", { name: /Prepare claims/ })).not.toBeInTheDocument();
  });

  it("starts a search only after the exact hosts of the preview are confirmed", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/research/collect/preview": () => ({ json: PREVIEW }),
      "POST /projects/p1/research/collect": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Search Wikipedia/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search for sources" });
    const start = within(dialog).getByRole("button", { name: /Start search/ });
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Check what would be contacted/ }));
    const hosts = await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    expect(within(hosts).getAllByRole("listitem").map((li) => li.textContent)).toEqual(PREVIEW.hosts);
    expect(within(dialog).getByText(/queued\.example\.net\/page/)).toBeInTheDocument();
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /I confirm that these hosts/ }));
    await user.click(start);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/research/collect"))).toBeTruthy());
    expect(calls.find((c) => c.path.endsWith("/research/collect"))!.body).toMatchObject({
      expected_revision: REV, network: true, plan_sha256: SHA, allow_hosts: PREVIEW.hosts,
    });
  });

  it("asks again when what would be contacted changed meanwhile", async () => {
    const changed = { ...PREVIEW, hosts: [...PREVIEW.hosts, "new.example.net"], plan_sha256: "c".repeat(64) };
    const { user } = setup({
      "POST /projects/p1/research/collect/preview": () => ({ json: PREVIEW }),
      "POST /projects/p1/research/collect": () => ({ status: 422, json: { error: { code: "network_not_confirmed",
        message: "What this collection would contact has changed.", details: { preview: changed } } } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Search Wikipedia/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Check what would be contacted/ }));
    await user.click(await within(dialog).findByRole("checkbox", { name: /I confirm/ }));
    await user.click(within(dialog).getByRole("button", { name: /Start search/ }));
    expect(await within(dialog).findByText("new.example.net")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /I confirm/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: /Start search/ })).toBeDisabled();
  });

  it("queues a URL by default and confirms the host before fetching it now", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/research/sources": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Add URL/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a URL" });
    await user.type(within(dialog).getByLabelText(/Page address/), "https://Vi.Wikipedia.org/wiki/Ba_Đình");
    await user.click(within(dialog).getByRole("radio", { name: /Fetch it now/ }));
    const fetchBtn = within(dialog).getByRole("button", { name: /Fetch page/ });
    expect(fetchBtn).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /vi\.wikipedia\.org may be contacted/ }));
    await user.click(fetchBtn);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      expected_revision: REV, url: "https://Vi.Wikipedia.org/wiki/Ba_Đình", fetch: "live", network: true,
      allow_hosts: ["vi.wikipedia.org"],
    });
  });

  it("offers no network action when network research is turned off", async () => {
    const { user } = setup({}, view({ network: { enabled: false, search_provider: "wikipedia" } }));
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    expect(screen.getByRole("button", { name: /Search Wikipedia/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Add URL/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Fetch it now/ })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /Queue it/ })).toBeChecked();
  });

  it("reads a snapshot as plain text in its language", async () => {
    const { user } = setup({
      "GET /projects/p1/research/snapshots/snap-0000000000000001": () => ({ json: {
        snapshot: { id: "snap-0000000000000001", source_id: "src-1", acquisition: "retrieved", requested_url: "https://a.example.net/x",
          final_url: "https://a.example.net/x", canonical_url: null, retrieved_at: "2026-11-22T00:00:00Z", title: "Bài viết",
          publisher: null, author: null, published_at: null, language: "vi", text_sha256: SHA, chars: 20, limitations: [],
          fixture: false, document_provenance: null },
        text: "<b>Không phải HTML</b>\nNgày 2 tháng 9 năm 1945.",
      } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Read snap-0000000000000001/ }));
    const text = await screen.findByLabelText("Snapshot text");
    expect(text).toHaveAttribute("lang", "vi");
    expect(text.textContent).toContain("<b>Không phải HTML</b>"); // shown as text, never as markup
    expect(text.querySelector("b")).toBeNull();
  });
});

describe("sidebar", () => {
  it("reloads the engine's report, sources and revision when a research job finishes, without a manual refresh", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    let current = view({ started: false, report: { ...view().report!, claims: [] }, sources: [] });
    let status = "running";
    const { calls, user } = setup({
      "GET /projects/p1/research": () => ({ json: current }),
      "POST /projects/p1/research/plan": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }),
      "GET /jobs/job-1": () => ({ json: job("research-plan", status) }),
      "GET /jobs/job-1/events/page": () => ({ json: { job_id: "job-1", status, events: [], next_after: 0, has_more: false } }),
    });
    await user.click(await screen.findByRole("button", { name: /Prepare claims/ }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // Let the refresh that follows starting the job settle, then change the engine's state.
    await waitFor(() => expect(screen.getByText("Research job")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === "/projects/p1/research").length;
    const before = reads();
    current = view({ revision: "c".repeat(64) });
    status = "succeeded";
    expect(screen.queryByText(/Hồ Chí Minh đọc Tuyên ngôn/)).not.toBeInTheDocument();

    act(() => FakeEventSource.instances[0].emit(1, "completed", { status: "succeeded", exit_code: 0, message: "done" }));

    expect(await screen.findByText(/Hồ Chí Minh đọc Tuyên ngôn/)).toBeInTheDocument();
    expect(reads()).toBeGreaterThan(before);
    await user.click(screen.getByRole("tab", { name: "Sources" }));
    expect(screen.getByText("https://archive.example.net/x")).toBeInTheDocument();
  });

  it("discards a search preview and its confirmation when the research revision changes while the dialog is open", async () => {
    const REV2 = "c".repeat(64);
    let current = view();
    const { calls, client, user } = setup({
      "GET /projects/p1/research": () => ({ json: current }),
      "POST /projects/p1/research/collect/preview": (body) => ({
        json: { ...PREVIEW, revision: (body as { expected_revision: string }).expected_revision,
          plan_sha256: (body as { expected_revision: string }).expected_revision === REV2 ? "d".repeat(64) : SHA },
      }),
      "POST /projects/p1/research/collect": () => ({ status: 202, json: { job_id: "job-1", project_id: "p1", status: "queued" } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Search Wikipedia/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search for sources" });
    await user.click(within(dialog).getByRole("button", { name: /Check what would be contacted/ }));
    await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    await user.click(within(dialog).getByRole("checkbox", { name: /I confirm that these hosts/ }));
    expect(within(dialog).getByRole("button", { name: /Start search/ })).toBeEnabled();

    // Another job, the CLI or a tab changes the research: the parent reloads a new revision.
    current = view({ revision: REV2 });
    await act(() => client.invalidateQueries({ queryKey: ["project", "p1", "research"] }));

    expect(await within(dialog).findByText(/The research changed since this check/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("list", { name: "Hosts that may be contacted" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: /I confirm that these hosts/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Start search/ })).toBeDisabled();

    // Checking again previews the new revision, and the old confirmation does not carry over.
    await user.click(within(dialog).getByRole("button", { name: /Check again/ }));
    await within(dialog).findByRole("list", { name: "Hosts that may be contacted" });
    expect(within(dialog).queryByText(/The research changed since this check/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /I confirm that these hosts/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: /Start search/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /I confirm that these hosts/ }));
    await user.click(within(dialog).getByRole("button", { name: /Start search/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/projects/p1/research/collect")).toBeTruthy());
    const sent = calls.find((c) => c.method === "POST" && c.path === "/projects/p1/research/collect")!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ expected_revision: REV2, plan_sha256: "d".repeat(64), network: true });
  });

  it("describes stopping a research job as what it is, not as draft generation", async () => {
    const { user } = setup({ "GET /jobs/job-1": () => ({ json: job("research-collect", "running") }) }, view({ active_job_id: "job-1" }));
    await user.click(await screen.findByRole("button", { name: "Cancel job" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop this source search?" });
    expect(within(dialog).getByRole("button", { name: "Stop search" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("you can search again later");
    expect(dialog.textContent).not.toMatch(/draft|generation/i);
    expect(screen.queryByText(/Ollama/)).not.toBeInTheDocument();
  });

  it("links Research only inside a project", () => {
    const { rerender } = renderWithQuery(<SidebarNav pathname="/projects/p1/research" />);
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Projects" })).not.toHaveAttribute("aria-current");
    rerender(<SidebarNav pathname="/" />);
    expect(screen.queryByRole("link", { name: "Research" })).not.toBeInTheDocument();
    expect(screen.getByText("(open a project to research it)")).toBeInTheDocument();
  });
});
