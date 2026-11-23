import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FixturePanel } from "@/components/draft/fixture-panel";
import { AddClaimDialog } from "@/components/research/add-claim-dialog";
import { HistoryDisclosure } from "@/components/research/decision-panel";
import { LinkDialog } from "@/components/research/link-dialog";
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
const CID = "clm-001-fake";
const SNAP = "snap-00000000000000d1";
const ASSERTION = "Ngày 2 tháng 9 năm 1945, Hồ Chí Minh đọc Tuyên ngôn Độc lập.";

function claim(over: Record<string, unknown> = {}) {
  return {
    id: CID, kind: "factual", assertion: ASSERTION, contested: false, flags: ["date"], status: "unverified",
    suggested_status: "supported_pending_review", scenes: ["scene-001"], supports: [], contradicts: [], context: [],
    independent_roots: 0, quotation_basis: null, reviewer: null, rationale: null, review_outdated: [], outdated_review: null,
    ...over,
  };
}

function view(over: Partial<View> = {}, claimOver: Record<string, unknown> = {}): View {
  return {
    report: {
      approvable: false, approval_status: "not_approved", applied: false, counts: {},
      items: [{ code: "completeness_missing", claim_id: null, detail: "no completeness attestation", blocking: true }],
      claims: [claim(claimOver)],
      coverage: { sentences: 1, covered: 1, uncovered: [] },
      revision: REV,
    },
    report_error: null, revision: REV, started: true,
    sources: [{ id: "doc-00000000000000d1", kind: "document", url: null, host: null, state: "extracted", fixture: false, user_supplied: true,
      candidate_for: [], snapshot_ids: [SNAP], discoveries: [], fetches: [] }],
    snapshots: [{ id: SNAP, source_id: "doc-00000000000000d1", acquisition: "imported", requested_url: null, final_url: null, canonical_url: null,
      retrieved_at: "2026-11-22T10:00:00Z", title: "Tuyên ngôn Độc lập (trích)", publisher: null, author: null, published_at: null, language: "vi",
      text_sha256: "c".repeat(64), chars: 120, limitations: [], fixture: false,
      document_provenance: { title: "Tuyên ngôn Độc lập (trích)", language: "vi", citation: "Toàn tập, tập 4", imported_by: "Trần Thị B",
        imported_at: "2026-11-22T10:00:00Z" } }],
    evidence: [],
    records_error: null, stage: null, network: { enabled: true, search_provider: "wikipedia" }, active_job_id: null,
    plan: { language: "vi", leads: [], claims: [{ id: CID, assertion: ASSERTION, kind: "factual", flags: ["date"], contested: false, notes: "",
      origin: "rule", search_queries: [], anchors: [{ scene_id: "scene-001", start: 0, end: 10, excerpt: "Ngày 2 thán",
        context: { before: "", excerpt: "Ngày 2 thán", after: "g 9 năm 1945", truncated_before: false, truncated_after: false } }] }] },
    review: { present: true, schema_version: "m5-review-0.2", supported: true, reviews: [], completeness: null, source_rechecks: [],
      primary_source_attestations: [], history_summary: { count: 0, last_seq: null } },
    scenes: [{ id: "scene-001", section_id: "s1", narration: "Ngày 2 tháng 9 năm 1945." }],
    editing: { supported: true, reason: null, migration_required: false, legacy_ids: false },
    ...over,
  } as unknown as View;
}

const EDITED = (v: View) => ({ json: { result: { status: "published", created: [], occurrences: [] }, research: v } });

function setup(routes: Parameters<typeof mockFetch>[0] = {}, v = view()) {
  const calls = mockFetch({
    "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "vi" } }),
    "GET /projects/p1/research": () => ({ json: v }),
    ...routes,
  });
  renderWithQuery(<ResearchView />);
  return { calls, user: userEvent.setup() };
}

const posted = (calls: ReturnType<typeof setup>["calls"], path = "/projects/p1/research/edit") =>
  calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body as Record<string, unknown>);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Review this claim/ }));
  return screen.getByRole("region", { name: `Decision for ${CID}` });
}

beforeEach(() => vi.clearAllMocks());

describe("decisions", () => {
  it("has no preselected status, never uses the tool suggestion, and confirms a verified decision first", async () => {
    const { calls, user } = setup({ "POST /projects/p1/research/edit": () => EDITED(view()) });
    const panel = await openReview(user);
    await user.click(within(panel).getByRole("button", { name: /Record a decision/ }));
    const radios = within(panel).getAllByRole("radio");
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(panel).getByText(/The tool suggestion \(Evidence linked, needs a decision\) is not a verdict/)).toBeInTheDocument();
    const save = within(panel).getByRole("button", { name: "Save decision" });
    expect(save).toBeDisabled();
    await user.type(within(panel).getByLabelText(/Reviewer/), "Trần Thị B");
    await user.type(within(panel).getByLabelText(/Rationale/), "Văn bản gốc nêu rõ ngày và địa điểm.");
    expect(save).toBeDisabled(); // still no status
    await user.click(within(panel).getByRole("radio", { name: /^Verified/ }));
    await user.click(save);
    const dialog = await screen.findByRole("dialog", { name: "Record this claim as verified?" });
    expect(dialog).toHaveTextContent("your own judgement");
    expect(dialog).toHaveTextContent("Imported documents never count as independent roots");
    expect(posted(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Record as verified" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toEqual({
      expected_revision: REV,
      operations: [{ op: "reviews.set", claim_id: CID, status: "verified", reviewer: "Trần Thị B", rationale: "Văn bản gốc nêu rõ ngày và địa điểm." }],
    });
  });

  it("never shows an outdated decision as current, and Confirm again sends the same decision", async () => {
    const record = { claim_id: CID, status: "disputed", reviewer: "Trần Thị B", reviewed_at: "2026-11-20T10:00:00Z",
      rationale: "Hai nguồn mâu thuẫn về giờ đọc bản Tuyên ngôn.", counterargument_summary: "Một nguồn ghi buổi sáng, nguồn kia buổi chiều.",
      narration_qualifies_dispute: true, basis: null };
    const v = view({ review: { ...view().review!, reviews: [record] } } as Partial<View>, {
      review_outdated: ["claim"], outdated_review: { status: "disputed", reviewer: "Trần Thị B", reviewed_at: "2026-11-20T10:00:00Z" },
    });
    const { calls, user } = setup({ "POST /projects/p1/research/edit": () => EDITED(v) }, v);
    const card = (await screen.findByText(ASSERTION)).closest("li")!;
    expect(within(card).getByText("Needs a new decision")).toBeInTheDocument();
    expect(within(card).getByText("Unverified")).toBeInTheDocument();
    expect(within(card).queryByText("Disputed")).not.toBeInTheDocument();
    const panel = await openReview(user);
    expect(panel).toHaveTextContent("the claim's wording, kind, contested state or flags");
    await user.click(within(panel).getByRole("button", { name: /Confirm again/ }));
    expect(within(panel).getByRole("radio", { name: /^Disputed/ })).toBeChecked();
    await user.click(within(panel).getByRole("button", { name: "Save decision" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0].operations).toEqual([{
      op: "reviews.set", claim_id: CID, status: "disputed", reviewer: "Trần Thị B", rationale: record.rationale,
      counterargument_summary: record.counterargument_summary, narration_qualifies_dispute: true,
    }]);
  });

  it("renders the decision history when opened", async () => {
    const { user } = setup({
      "GET /projects/p1/research/history": () => ({
        json: { entries: [{ id: "hist-1", seq: 1, kind: "claim_review", subject_id: CID, action: "replaced", at: "2026-11-21T10:00:00Z",
          by_reviewer: "Trần Thị B", reason: null, previous: { status: "insufficient", reviewer: "Nguyễn Văn A", rationale: "Chỉ một nguồn." },
          outdated_components: [] }], next_after_seq: 1, has_more: false, chain_ok: true, revision: REV },
      }),
    });
    const panel = await openReview(user);
    await user.click(within(panel).getByText("Decision history"));
    expect(await within(panel).findByText(/#1 Replaced/)).toBeInTheDocument();
    expect(within(panel).getByText(/Previous: Insufficient evidence by Nguyễn Văn A — Chỉ một nguồn\./)).toBeInTheDocument();
  });

  it("keeps the input after a revision conflict and offers to reload", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/research/edit": () => ({ status: 409, json: { error: { code: "revision_conflict", message: "changed", details: { current_revision: "b".repeat(64) } } } }),
    });
    const panel = await openReview(user);
    await user.click(within(panel).getByRole("button", { name: /Record a decision/ }));
    await user.click(within(panel).getByRole("radio", { name: /^Insufficient/ }));
    await user.type(within(panel).getByLabelText(/Reviewer/), "Trần Thị B");
    await user.type(within(panel).getByLabelText(/Rationale/), "Chưa có nguồn độc lập.");
    await user.click(within(panel).getByRole("button", { name: "Save decision" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The research changed since you loaded it");
    expect(within(panel).getByLabelText(/Rationale/)).toHaveValue("Chưa có nguồn độc lập.");
    const reads = calls.filter((c) => c.method === "GET" && c.path === "/projects/p1/research").length;
    await user.click(within(alert).getByRole("button", { name: /Reload latest/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/projects/p1/research").length).toBeGreaterThan(reads));
  });
});

describe("evidence", () => {
  it("labels imported evidence and attested primary sources", async () => {
    const v = view({
      evidence: [{ id: "ev-00000000000000e1", claim_id: CID, snapshot_id: SNAP, start: 0, end: 4, quote: "Ngày", role: "supports",
        explanation: "Văn bản nêu ngày diễn ra sự kiện.", source_type: "primary", evidence_root: null, original_language: null,
        is_translation: true, translation_of: "bản tiếng Pháp", translator: null }],
      review: { ...view().review!, primary_source_attestations: [{ snapshot_id: SNAP, text_sha256: "c", provenance_sha256: "d", reviewer: "Trần Thị B",
        statement: "Bản in chính thức.", at: "2026-11-22T11:00:00Z" }] },
    } as unknown as Partial<View>);
    const { user } = setup({}, v);
    await openReview(user);
    const list = screen.getByRole("region", { name: "Supports evidence" });
    expect(list).toHaveTextContent("Imported document — not retrieved by the engine");
    expect(list).toHaveTextContent("Attested primary source (this edition)");
    expect(list).toHaveTextContent("Translation — not traced to its original");
    expect(within(list).getByRole("button", { name: /Trace to original/ })).toBeInTheDocument();
    expect(within(list).getByText("Ngày").closest("blockquote")).toHaveAttribute("lang", "vi");
  });

  it("links a selected passage after the dry run lists its occurrences", async () => {
    const occurrences = [
      { n: 1, start: 0, end: 4, context: "Ngày 2 tháng 9" },
      { n: 2, start: 40, end: 44, context: "cũng trong Ngày ấy" },
    ];
    const { calls, user } = setup({
      "GET /projects/p1/research/snapshots/snap-00000000000000d1": () => ({ json: { snapshot: view().snapshots[0], text: "Ngày 2 tháng 9 … cũng trong Ngày ấy" } }),
      "POST /projects/p1/research/edit": (b) =>
        (b as { dry_run?: boolean }).dry_run
          ? { json: { result: { status: "would_publish", created: [], occurrences: [{ op_index: 0, field: "quote", occurrences }] } } }
          : EDITED(view()),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Read Tuyên ngôn/ }));
    const reader = await screen.findByRole("dialog", { name: "Tuyên ngôn Độc lập (trích)" });
    expect(await within(reader).findByText(/Imported document — not retrieved by the engine/)).toBeInTheDocument();
    expect(within(reader).getByText("Toàn tập, tập 4")).toBeInTheDocument();
    await user.click(within(reader).getByRole("button", { name: /Link a passage to a claim/ }));
    const dialog = await screen.findByRole("dialog", { name: "Link to claim" });
    await user.selectOptions(within(dialog).getByLabelText(/^Claim/), CID);
    await user.type(within(dialog).getByLabelText(/Passage/), "Ngày");
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "supports");
    await user.type(within(dialog).getByLabelText(/Explanation/), "Văn bản nêu ngày của sự kiện này.");
    await user.click(within(dialog).getByRole("button", { name: /Find the passage/ }));
    const link = await within(dialog).findByRole("button", { name: /Link evidence/ });
    expect(link).toBeDisabled(); // two occurrences: the reviewer must choose
    await user.click(within(dialog).getByRole("radio", { name: /#2/ }));
    await user.click(link);
    await waitFor(() => expect(posted(calls)).toHaveLength(2));
    expect(posted(calls)[0].dry_run).toBe(true);
    expect(posted(calls)[1].operations).toEqual([{
      op: "evidence.add", claim_id: CID, snapshot_id: SNAP, quote: "Ngày", role: "supports",
      explanation: "Văn bản nêu ngày của sự kiện này.", occurrence: 2, source_type: "user_supplied",
    }]);
  });
});

describe("documents and records", () => {
  it("imports a document only with its required provenance, and never sends a URL to fetch", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/research/documents": () => ({ json: { result: { source_id: "doc-1", snapshot_id: "snap-1", supersedes_snapshot_id: null, chars: 10 }, research: view() } }),
    });
    await user.click(await screen.findByRole("tab", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: /Import document/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import a document" });
    const go = within(dialog).getByRole("button", { name: /Import document/ });
    await user.type(within(dialog).getByLabelText(/^Title/), "Hồi ký");
    await user.type(within(dialog).getByLabelText(/^Language/), "Tiếng Việt");
    await user.type(within(dialog).getByLabelText(/^Citation/), "NXB Văn học, 1975, tr. 12");
    await user.type(within(dialog).getByLabelText(/^Imported by/), "Trần Thị B");
    await user.type(within(dialog).getByLabelText(/^Text/), "Văn bản.");
    expect(go).toBeDisabled(); // not a language code
    await user.clear(within(dialog).getByLabelText(/^Language/));
    await user.type(within(dialog).getByLabelText(/^Language/), "vi");
    await user.click(go);
    await waitFor(() => expect(posted(calls, "/projects/p1/research/documents")).toHaveLength(1));
    expect(posted(calls, "/projects/p1/research/documents")[0]).toEqual({
      expected_revision: REV, title: "Hồi ký", language: "vi", citation: "NXB Văn học, 1975, tr. 12", imported_by: "Trần Thị B", text: "Văn bản.",
    });
  });

  it("upgrades legacy records only after a confirmation that decisions stay and G2 goes stale", async () => {
    const v = view({ editing: { supported: true, reason: null, migration_required: true, legacy_ids: true },
      review: { ...view().review!, schema_version: "m5-review-0.1" } } as Partial<View>);
    const { calls, user } = setup({ "POST /projects/p1/research/edit": () => EDITED(view()) }, v);
    await user.click(await screen.findByRole("button", { name: /Upgrade research records/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upgrade the research records?" });
    expect(dialog).toHaveTextContent("Every decision is kept, word for word");
    expect(dialog).toHaveTextContent("an existing research approval (G2) goes out of date");
    await user.click(within(dialog).getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0].operations).toEqual([{ op: "migrate_review_file" }, { op: "migrate_ids" }]);
  });
});

describe("fixture text panel", () => {
  it("only offers to attest rewrites, and shows the engine's refusal in words", async () => {
    const segs = [
      { segment_id: "seg-0000000000000001", section_id: "s1", scene_id: "scene-001", origin: "fixture", text: "Câu thử nghiệm.", norm: "câu thử nghiệm",
        derived_from: [], attestation: null, initialized_from: null },
      { segment_id: "seg-0000000000000002", section_id: "s1", scene_id: "scene-001", origin: "fixture_derived", text: "Câu viết lại.", norm: "câu viết lại",
        derived_from: ["seg-0000000000000009"], attestation: null, initialized_from: null },
    ];
    const calls = mockFetch({
      "GET /projects/p1/draft/narration": () => ({
        json: { revision: REV, report_error: null, lineage: { present: true, supported: true, fixture_project: true, segments: segs }, lineage_error: null,
          items: [{ code: "fixture_narration", claim_id: null, detail: "2 sentences", blocking: true }], needs_init: false },
      }),
      "POST /projects/p1/draft/narration/attest": () => ({
        status: 422, json: { error: { code: "lineage_refused", message: "seg-0000000000000002 is still close", details: { reason: "still_close" } } },
      }),
    });
    renderWithQuery(<FixturePanel projectId="p1" lang="vi" unsaved={false} />);
    expect(await screen.findByText("Câu thử nghiệm.")).toHaveAttribute("lang", "vi");
    expect(screen.queryByRole("checkbox", { name: /seg-0000000000000001/ })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /seg-0000000000000002/ }));
    await user.type(screen.getByLabelText(/^Reviewer/), "Trần Thị B");
    await user.type(screen.getByLabelText(/What you rewrote/), "Tôi viết lại toàn bộ câu mở đầu.");
    await user.click(screen.getByRole("button", { name: "Attest rewrite" }));
    expect(await screen.findByText(/Still close to the fixture text it replaces/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      expected_revision: REV, reviewer: "Trần Thị B", statement: "Tôi viết lại toàn bộ câu mở đầu.", segment_ids: ["seg-0000000000000002"],
    });
  });
});

// A dry run that answers late must never repopulate the picker: request A starts, the form
// changes, request B starts, B answers, then A answers. Only B's occurrences may be used.
type Reply = { status?: number; json: unknown };
function heldDryRuns(onWrite: () => Reply = () => EDITED(view())) {
  const held: { body: Record<string, unknown>; answer: (r: Reply) => void }[] = [];
  const route = (b?: unknown) =>
    (b as { dry_run?: boolean }).dry_run
      ? new Promise<Reply>((answer) => held.push({ body: b as Record<string, unknown>, answer }))
      : onWrite();
  return { held, route };
}
const occurrencesFound = (field: string, contexts: string[]): Reply => ({
  json: { result: { status: "would_publish", created: [], occurrences: [{ op_index: 0, field,
    occurrences: contexts.map((context, i) => ({ n: i + 1, start: i * 10, end: i * 10 + 4, context })) }] } },
});
const opOf = (b: Record<string, unknown>) => (b.operations as Record<string, unknown>[])[0];

describe("occurrence searches answering out of order", () => {
  it("link dialog: only the latest search's occurrences can be chosen and linked", async () => {
    const { held, route } = heldDryRuns();
    const calls = mockFetch({ "POST /projects/p1/research/edit": route });
    const v = view();
    renderWithQuery(
      <LinkDialog open onOpenChange={vi.fn()} projectId="p1" revision={REV} snapshot={v.snapshots[0]} snapshots={v.snapshots}
        initialQuote="Ngày" claims={[{ id: CID, assertion: ASSERTION }]} />,
    );
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Link to claim" });
    await user.selectOptions(within(dialog).getByLabelText(/^Claim/), CID);
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "supports");
    await user.type(within(dialog).getByLabelText(/Explanation/), "Văn bản nêu ngày của sự kiện này.");
    await user.click(within(dialog).getByRole("button", { name: /Find the passage/ }));
    await waitFor(() => expect(held).toHaveLength(1));
    const passage = within(dialog).getByLabelText(/^Passage/);
    await user.clear(passage);
    await user.type(passage, "tháng");
    // The outdated search does not block a search for the form as it is now.
    await user.click(within(dialog).getByRole("button", { name: /Find the passage/ }));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(opOf(held[0].body).quote).toBe("Ngày");
    expect(opOf(held[1].body).quote).toBe("tháng");
    await act(async () => held[1].answer(occurrencesFound("quote", ["B một", "B hai"])));
    await act(async () => held[0].answer(occurrencesFound("quote", ["A only"])));
    expect(within(dialog).getByText(/found 2 times/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/A only/)).toBeNull();
    const link = within(dialog).getByRole("button", { name: /Link evidence/ });
    expect(link).toBeDisabled(); // A's single occurrence was not auto-picked
    await user.click(within(dialog).getByRole("radio", { name: /#2/ }));
    await user.click(link);
    const writes = () => calls.filter((c) => c.method === "POST" && c.path === "/projects/p1/research/edit" && !(c.body as { dry_run?: boolean }).dry_run);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(opOf(writes()[0].body as Record<string, unknown>)).toMatchObject({ quote: "tháng", occurrence: 2 });
  });

  it("link dialog: editing the form hides results and picks from the earlier search", async () => {
    const { held, route } = heldDryRuns();
    mockFetch({ "POST /projects/p1/research/edit": route });
    const v = view();
    renderWithQuery(
      <LinkDialog open onOpenChange={vi.fn()} projectId="p1" revision={REV} snapshot={v.snapshots[0]} snapshots={v.snapshots}
        initialQuote="Ngày" claims={[{ id: CID, assertion: ASSERTION }]} />,
    );
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Link to claim" });
    await user.selectOptions(within(dialog).getByLabelText(/^Claim/), CID);
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "supports");
    await user.type(within(dialog).getByLabelText(/Explanation/), "Văn bản nêu ngày của sự kiện này.");
    await user.click(within(dialog).getByRole("button", { name: /Find the passage/ }));
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held[0].answer(occurrencesFound("quote", ["một", "hai"])));
    await user.click(within(dialog).getByRole("radio", { name: /#1/ }));
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "context");
    expect(within(dialog).queryByRole("button", { name: /Link evidence/ })).toBeNull();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    // Restoring the searched input does not bring the old result or pick back: search again.
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "supports");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Find the passage/ })).toBeEnabled();
  });

  it("add claim: a late answer for the previous scene is dropped", async () => {
    const created = { json: { result: { status: "published", created: [{ op_index: 0, kind: "claim", id: "clm-002" }], occurrences: [] }, research: view() } };
    const { held, route } = heldDryRuns(() => created);
    const calls = mockFetch({ "POST /projects/p1/research/edit": route });
    const scenes = [
      { id: "scene-001", section_id: "s1", narration: "Ngày 2 tháng 9 năm 1945." },
      { id: "scene-002", section_id: "s1", narration: "Ngày ấy, Ngày lịch sử." },
    ];
    renderWithQuery(<AddClaimDialog open onOpenChange={vi.fn()} projectId="p1" revision={REV} anchor={{ kind: "excerpt" }} scenes={scenes} lang="vi" />);
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Add a claim" });
    await user.selectOptions(within(dialog).getByLabelText(/^Scene/), "scene-002");
    await user.type(within(dialog).getByLabelText(/^Excerpt/), "Ngày");
    await user.type(within(dialog).getByLabelText(/^Assertion/), "Ngày 2 tháng 9 là ngày lịch sử.");
    await user.selectOptions(within(dialog).getByLabelText(/^Kind/), "factual");
    await user.click(within(dialog).getByRole("button", { name: "Find in the narration" }));
    await waitFor(() => expect(held).toHaveLength(1));
    await user.selectOptions(within(dialog).getByLabelText(/^Scene/), "scene-001");
    expect(within(dialog).queryByRole("button", { name: "Add claim" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Find in the narration" }));
    await waitFor(() => expect(held).toHaveLength(2));
    await act(async () => held[1].answer(occurrencesFound("excerpt", ["Ngày 2 tháng 9"])));
    await act(async () => held[0].answer(occurrencesFound("excerpt", ["Ngày ấy", "Ngày lịch sử"])));
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByText(/found once/)).toHaveTextContent("Ngày 2 tháng 9");
    await user.click(within(dialog).getByRole("button", { name: "Add claim" }));
    await waitFor(() => expect(posted(calls).filter((b) => !b.dry_run)).toHaveLength(1));
    expect(opOf(posted(calls).filter((b) => !b.dry_run)[0]).anchor).toEqual({ scene_id: "scene-001", excerpt: "Ngày", occurrence: 1 });
  });

  it("add claim: a search abandoned by a change is ignored even after the input is restored", async () => {
    const { held, route } = heldDryRuns();
    mockFetch({ "POST /projects/p1/research/edit": route });
    const scenes = [
      { id: "scene-001", section_id: "s1", narration: "Ngày 2 tháng 9 năm 1945." },
      { id: "scene-002", section_id: "s1", narration: "Ngày ấy, Ngày lịch sử." },
    ];
    renderWithQuery(<AddClaimDialog open onOpenChange={vi.fn()} projectId="p1" revision={REV} anchor={{ kind: "excerpt" }} scenes={scenes} lang="vi" />);
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Add a claim" });
    await user.selectOptions(within(dialog).getByLabelText(/^Scene/), "scene-002");
    await user.type(within(dialog).getByLabelText(/^Excerpt/), "Ngày");
    await user.type(within(dialog).getByLabelText(/^Assertion/), "Ngày 2 tháng 9 là ngày lịch sử.");
    await user.selectOptions(within(dialog).getByLabelText(/^Kind/), "factual");
    await user.click(within(dialog).getByRole("button", { name: "Find in the narration" }));
    await waitFor(() => expect(held).toHaveLength(1));
    await user.selectOptions(within(dialog).getByLabelText(/^Scene/), "scene-001");
    await user.selectOptions(within(dialog).getByLabelText(/^Scene/), "scene-002");
    await act(async () => held[0].answer(occurrencesFound("excerpt", ["Ngày ấy"])));
    expect(within(dialog).queryByText(/found once/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Add claim" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Find in the narration" })).toBeEnabled();
  });

  it("trace translation: a late answer for the previous original passage is dropped", async () => {
    const SNAP2 = "snap-00000000000000f2";
    const base = view();
    const v = view({
      snapshots: [...base.snapshots, { ...base.snapshots[0], id: SNAP2, title: "Déclaration (original)", language: "fr", document_provenance: null,
        acquisition: "retrieved" }],
      evidence: [{ id: "ev-00000000000000e1", claim_id: CID, snapshot_id: SNAP, start: 0, end: 4, quote: "Ngày", role: "supports",
        explanation: "Văn bản nêu ngày diễn ra sự kiện.", source_type: "secondary", evidence_root: null, original_language: null,
        is_translation: true, translation_of: null, translator: null }],
    } as unknown as Partial<View>);
    const { held, route } = heldDryRuns(() => EDITED(v));
    const { calls, user } = setup({ "POST /projects/p1/research/edit": route }, v);
    await openReview(user);
    await user.click(screen.getByRole("button", { name: /Trace to original/ }));
    const dialog = await screen.findByRole("dialog", { name: "Trace the translation to its original" });
    await user.selectOptions(within(dialog).getByLabelText(/Snapshot with the original/), SNAP2);
    const original = within(dialog).getByLabelText(/Original passage/);
    await user.type(original, "jour");
    await user.type(within(dialog).getByLabelText(/Language of the original/), "fr");
    await user.type(within(dialog).getByLabelText(/Who spoke or wrote/), "Hồ Chí Minh");
    await user.type(within(dialog).getByLabelText(/Equivalence note/), "Bản dịch giữ nguyên nghĩa của từ gốc tiếng Pháp.");
    await user.click(within(dialog).getByRole("button", { name: "Find the original" }));
    await waitFor(() => expect(held).toHaveLength(1));
    await user.clear(original);
    await user.type(original, "le 2 septembre");
    await user.click(within(dialog).getByRole("button", { name: "Find the original" }));
    await waitFor(() => expect(held).toHaveLength(2));
    await act(async () => held[1].answer(occurrencesFound("original_quote", ["le 2 septembre 1945", "dès le 2 septembre"])));
    await act(async () => held[0].answer(occurrencesFound("original_quote", ["ce jour"])));
    expect(within(dialog).getByText(/found 2 times/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/ce jour/)).toBeNull();
    const save = within(dialog).getByRole("button", { name: "Save translation" });
    expect(save).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: /#1/ }));
    await user.click(save);
    await waitFor(() => expect(posted(calls).filter((b) => !b.dry_run)).toHaveLength(1));
    expect(opOf(posted(calls).filter((b) => !b.dry_run)[0]).translation_of).toMatchObject({ quote: "le 2 septembre", occurrence: 1 });
  });
});

describe("evidence root", () => {
  const rootView = (root: string | null) =>
    view({
      evidence: [{ id: "ev-00000000000000e1", claim_id: CID, snapshot_id: SNAP, start: 0, end: 4, quote: "Ngày", role: "supports",
        explanation: "Văn bản nêu ngày diễn ra sự kiện.", source_type: "secondary", evidence_root: root, original_language: null,
        is_translation: false, translation_of: null, translator: null }],
    } as unknown as Partial<View>);

  it("leaves an existing root out of the update when it is unchanged", async () => {
    const v = rootView("root-tuyen-ngon");
    const { calls, user } = setup({ "POST /projects/p1/research/edit": () => EDITED(v) }, v);
    await openReview(user);
    await user.click(screen.getByRole("button", { name: /Edit link/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit evidence link" });
    const root = within(dialog).getByLabelText(/Evidence root/);
    await user.type(root, " "); // whitespace around the same value is no change
    await user.type(within(dialog).getByLabelText(/Explanation/), " Thêm chi tiết.");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(opOf(posted(calls)[0])).toEqual({
      op: "evidence.update", link_id: "ev-00000000000000e1", explanation: "Văn bản nêu ngày diễn ra sự kiện. Thêm chi tiết.",
    });
  });

  it("shows the engine's new root after an update", async () => {
    const before = rootView("root-tuyen-ngon");
    const { user } = setup({ "POST /projects/p1/research/edit": () => EDITED(rootView("root-ban-in")) }, before);
    await openReview(user);
    expect(screen.getByRole("region", { name: "Supports evidence" })).toHaveTextContent("root root-tuyen-ngon");
    await user.click(screen.getByRole("button", { name: /Edit link/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit evidence link" });
    const root = within(dialog).getByLabelText(/Evidence root/);
    await user.clear(root);
    await user.type(root, "root-ban-in");
    await user.click(within(dialog).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit evidence link" })).toBeNull());
    expect(screen.getByRole("region", { name: "Supports evidence" })).toHaveTextContent("root root-ban-in");
  });

  it("never reports a save while silently keeping a root the reviewer emptied", async () => {
    const v = view({
      evidence: [{ id: "ev-00000000000000e1", claim_id: CID, snapshot_id: SNAP, start: 0, end: 4, quote: "Ngày", role: "supports",
        explanation: "Văn bản nêu ngày diễn ra sự kiện.", source_type: "secondary", evidence_root: "root-tuyen-ngon", original_language: null,
        is_translation: false, translation_of: null, translator: null }],
    } as unknown as Partial<View>);
    const { calls, user } = setup({ "POST /projects/p1/research/edit": () => EDITED(v) }, v);
    await openReview(user);
    await user.click(screen.getByRole("button", { name: /Edit link/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit evidence link" });
    const root = within(dialog).getByLabelText(/Evidence root/);
    await user.clear(root);
    await user.type(within(dialog).getByLabelText(/Explanation/), " Thêm chi tiết.");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("cannot be removed, only changed");
    const save = within(dialog).getByRole("button", { name: "Save link" });
    expect(save).toBeDisabled();
    await user.type(root, "root-ban-in");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(save);
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(opOf(posted(calls)[0])).toMatchObject({ op: "evidence.update", evidence_root: "root-ban-in" });
  });
});

describe("history pagination", () => {
  const entry = (seq: number) => ({
    id: `hist-${seq}`, seq, kind: "claim_review", subject_id: CID, action: "replaced", at: `2026-11-2${seq}T10:00:00Z`,
    by_reviewer: "Trần Thị B", reason: `lý do ${seq}`, previous: { status: "disputed" }, outdated_components: [],
  });
  const page = (seqs: number[], has_more: boolean) => ({
    json: { entries: seqs.map(entry), next_after_seq: seqs.at(-1) ?? null, has_more, chain_ok: true, revision: REV, report_error: null },
  });

  async function openHistory() {
    renderWithQuery(<HistoryDisclosure projectId="p1" kind="claim_review" subjectId={CID} label="Decision history" pageSize={2} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Decision history"));
    return user;
  }
  const seqsShown = () => screen.getAllByRole("listitem").map((li) => li.textContent?.match(/^#(\d+)/)?.[1]);

  it("loads later pages after the last seq, keeping the filters, without duplicates", async () => {
    const calls = mockFetch({
      "GET /projects/p1/research/history": (_b, q) => {
        const after = Number(q?.get("after_seq") ?? 0);
        return after === 0 ? page([1, 2], true) : after === 2 ? page([2, 3, 4], true) : page([5], false);
      },
    });
    const user = await openHistory();
    await screen.findByText(/lý do 2/);
    expect(seqsShown()).toEqual(["1", "2"]);
    expect(screen.getByText(/oldest first; later entries follow/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(/lý do 4/);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(/lý do 5/);
    expect(seqsShown()).toEqual(["1", "2", "3", "4", "5"]);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const queries = calls.filter((c) => c.path === "/projects/p1/research/history").map((c) => Object.fromEntries(c.query));
    expect(queries).toEqual([
      { kind: "claim_review", subject_id: CID, limit: "2" },
      { kind: "claim_review", subject_id: CID, after_seq: "2", limit: "2" },
      { kind: "claim_review", subject_id: CID, after_seq: "4", limit: "2" },
    ]);
  });

  it("keeps the loaded entries when a later page fails, and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /projects/p1/research/history": (_b, q) => {
        if (!q?.get("after_seq")) return page([1, 2], true);
        if (fail) return { status: 502, json: { error: { code: "engine_unsupported", message: "The engine could not read the history." } } };
        return page([3], false);
      },
    });
    const user = await openHistory();
    await screen.findByText(/lý do 2/);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more history: The engine could not read the history.");
    expect(seqsShown()).toEqual(["1", "2"]);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/lý do 3/);
    expect(seqsShown()).toEqual(["1", "2", "3"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("G2 approval, apply and export", () => {
  const REV2 = "b".repeat(64);
  const approvable = (over: Partial<View> = {}, report: Record<string, unknown> = {}) =>
    view({
      gates: { g1: "approved", g2: "needs_review" },
      ...over,
      report: { ...view().report!, approvable: true, items: [], ...report },
    } as Partial<View>);
  const validation = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("tab", { name: "Validation" }));
    return screen.getByRole("region", { name: /Research approval \(G2\)/ });
  };
  const approved = (applied: boolean, g1 = "approved") =>
    approvable({ gates: { g1, g2: applied ? "approved" : "approved_not_applied" } }, { approval_status: "approved", applied });
  const result = (research: View, extra: Record<string, unknown>) => ({ json: { result: extra, research } });

  it("approves only the revision that was validated, after an explicit attestation", async () => {
    const v = approvable();
    const after = approved(false);
    const { calls, user } = setup({
      "POST /projects/p1/research/approve": () =>
        result(after, { status: "approved", revision: REV, approval: { reviewer: "Trần Thị B", approved_at: "2026-11-23T12:00:00Z",
          comment: null, policy_version: "m5-research-3", meaning: "…" } }),
    }, v);
    const panel = await validation(user);
    const approve = within(panel).getByRole("button", { name: /Approve research \(G2\)/ });
    expect(approve).toBeDisabled(); // nothing validated yet, even though the report says approvable
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    expect(await within(panel).findByText(/the engine reports the research is approvable/)).toBeInTheDocument();
    await user.click(approve);
    const dialog = await screen.findByRole("dialog", { name: "Approve the research (G2)?" });
    expect(dialog).toHaveTextContent("not permission to publish");
    const submit = within(dialog).getByRole("button", { name: "Approve research" });
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Trần Thị B");
    expect(submit).toBeDisabled(); // the attestation is not ticked
    await user.click(within(dialog).getByLabelText(/I reviewed every claim/));
    await user.click(submit);
    await waitFor(() => expect(posted(calls, "/projects/p1/research/approve")).toHaveLength(1));
    expect(posted(calls, "/projects/p1/research/approve")[0]).toEqual({ expected_revision: REV, reviewer: "Trần Thị B", confirm: true });
    expect(await within(panel).findByText("Claim IDs not applied yet")).toBeInTheDocument();
  });

  it("asks to validate again when the research changed after validation", async () => {
    let current = approvable();
    mockFetch({
      "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "vi" } }),
      "GET /projects/p1/research": () => ({ json: current }),
    });
    const { client } = renderWithQuery(<ResearchView />);
    const user = userEvent.setup();
    const panel = await validation(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/the engine reports the research is approvable/);
    current = approvable({ revision: REV2 }, { revision: REV2 }); // e.g. a CLI edit
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["project", "p1", "research"] });
    });
    expect(await within(panel).findByText(/changed since you validated it: validate again/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Approve research \(G2\)/ })).toBeDisabled();
  });

  it("never shows an out-of-date G2 approval as approved", async () => {
    const { user } = setup({}, approvable({ gates: { g1: "approved", g2: "needs_review" } }, { approval_status: "stale" }));
    const panel = await validation(user);
    expect(within(panel).getByRole("alert")).toHaveTextContent("The G2 approval is out of date");
    expect(within(panel).queryByText("G2 approved")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Validate research" })).toBeInTheDocument();
  });

  it("applies claim IDs only after a warning about G1, then leads to G1 re-approval", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/research/apply": () =>
        result(approved(true, "stale_after_apply"), { status: "published", scenes_changed: ["scene-001"], written: ["storyboard.draft.json"], revision: REV }),
    }, approved(false));
    const panel = await validation(user);
    await user.click(within(panel).getByRole("button", { name: /Apply claim IDs to scenes/ }));
    const dialog = await screen.findByRole("dialog", { name: "Apply claim IDs to the scenes?" });
    expect(dialog).toHaveTextContent("editorial approval (G1) then goes out of date");
    expect(posted(calls, "/projects/p1/research/apply")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Apply claim IDs" }));
    await waitFor(() => expect(posted(calls, "/projects/p1/research/apply")).toEqual([{ expected_revision: REV, confirm: true }]));
    const link = await within(panel).findByRole("link", { name: "Approve the draft again" });
    expect(link).toHaveAttribute("href", "/projects/p1/draft");
    expect(within(panel).getByText("Out of date after apply: approve the draft again")).toBeInTheDocument();
  });

  it("exports after apply, and shows the engine's refusal to overwrite hand edits", async () => {
    let refuse = false;
    const { user } = setup({
      "POST /projects/p1/research/export": () =>
        refuse
          ? { status: 409, json: { error: { code: "human_edit_conflict", message: "The engine refused to overwrite hand edits (output/sources.md). The UI never overwrites them: keep or restore them in the CLI first.", details: { paths: ["output/sources.md"] } } } }
          : result(approved(true), { written: ["output/sources.md", "render/research/citation-plan.json"], unchanged: [], revision: REV }),
    }, approved(true));
    const panel = await validation(user);
    expect(within(panel).queryByText(/G1 is out of date after apply/)).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Export research records" }));
    expect(await within(panel).findByText("output/sources.md")).toBeInTheDocument();
    refuse = true;
    await user.click(within(panel).getByRole("button", { name: "Export research records" }));
    expect(await within(panel).findByText(/refused to overwrite hand edits \(output\/sources.md\)/)).toBeInTheDocument();
  });

  it("lists the engine's blocking items when it refuses the approval", async () => {
    const { user } = setup({
      "POST /projects/p1/research/approve": () => ({ status: 422, json: { error: { code: "not_approvable", message: "research is not approvable:",
        details: { items: [{ code: "completeness_stale", detail: "the completeness attestation is for a different claim inventory" }] } } } }),
    }, approvable());
    const panel = await validation(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/approvable/);
    await user.click(within(panel).getByRole("button", { name: /Approve research \(G2\)/ }));
    const dialog = await screen.findByRole("dialog", { name: "Approve the research (G2)?" });
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Trần Thị B");
    await user.click(within(dialog).getByLabelText(/I reviewed every claim/));
    await user.click(within(dialog).getByRole("button", { name: "Approve research" }));
    expect(await within(dialog).findByText(/the completeness attestation is for a different claim inventory/)).toBeInTheDocument();
  });
});

describe("G2 review findings: validation lifecycle, export feedback, busy project", () => {
  const R2 = "c".repeat(64);
  const at = (revision: string, over: Partial<View> = {}, report: Record<string, unknown> = {}) =>
    view({ revision, gates: { g1: "approved", g2: "needs_review" }, ...over,
      report: { ...view().report!, approvable: true, items: [], revision, ...report } } as Partial<View>);
  const applied = (revision = REV) => at(revision, { gates: { g1: "approved", g2: "approved" } }, { approval_status: "approved", applied: true });
  type Reply = { status?: number; json: unknown };

  /** GET /research answers with `state.current`; with `state.hold`, the next answer waits. */
  function page(initial: View, routes: Parameters<typeof mockFetch>[0] = {}) {
    const state: { current: View; hold: boolean; held: ((r: Reply) => void)[] } = { current: initial, hold: false, held: [] };
    const calls = mockFetch({
      "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án", language: "vi" } }),
      "GET /projects/p1/research": () => {
        if (!state.hold) return { json: state.current };
        state.hold = false;
        return new Promise<Reply>((answer) => state.held.push(answer));
      },
      ...routes,
    });
    const { client } = renderWithQuery(<ResearchView />);
    return { state, calls, client, user: userEvent.setup() };
  }
  const panelOf = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("tab", { name: "Validation" }));
    return screen.getByRole("region", { name: /Research approval \(G2\)/ });
  };
  const approveButton = (panel: HTMLElement) => within(panel).getByRole("button", { name: /Approve research \(G2\)/ });
  const reload = (client: { invalidateQueries: (f: { queryKey: unknown[] }) => Promise<void> }) =>
    act(async () => {
      await client.invalidateQueries({ queryKey: ["project", "p1", "research"] });
    });

  it("discards a validation whose research changed while it ran, even if its answer arrives later", async () => {
    const { state, client, user } = page(at(REV));
    const panel = await panelOf(user);
    state.hold = true; // the validation's check is slow
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await waitFor(() => expect(state.held).toHaveLength(1));
    state.current = at(R2); // an edit or job changes the research meanwhile
    await reload(client);
    await act(async () => state.held[0]({ json: at(REV) })); // the outdated answer, for REV
    expect(await within(panel).findByText(/changed since you validated it: validate again/)).toBeInTheDocument();
    expect(approveButton(panel)).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    expect(await within(panel).findByText(/the engine reports the research is approvable/)).toBeInTheDocument();
    expect(approveButton(panel)).toBeEnabled();
  });

  it("returning to an earlier revision needs a new validation", async () => {
    const { state, client, user } = page(at(REV));
    const panel = await panelOf(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/the engine reports the research is approvable/);
    state.current = at(R2);
    await reload(client);
    state.current = at(REV); // the change was undone: same content, same revision
    await reload(client);
    await waitFor(() => expect(within(panel).getByText(/changed since you validated it/)).toBeInTheDocument());
    expect(approveButton(panel)).toBeDisabled();
  });

  it("leaving the Validation tab and coming back asks for a new validation", async () => {
    const { user } = page(at(REV));
    let panel = await panelOf(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/the engine reports the research is approvable/);
    await user.click(screen.getByRole("tab", { name: "Claims" }));
    panel = await panelOf(user);
    expect(approveButton(panel)).toBeDisabled();
    expect(within(panel).getByText(/Validate to run the engine's check now/)).toBeInTheDocument();
  });

  it("keeps the approval dialog on the validated revision, and blocks it when the research changes", async () => {
    const { state, client, calls, user } = page(at(REV));
    const panel = await panelOf(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/the engine reports the research is approvable/);
    await user.click(approveButton(panel));
    const dialog = await screen.findByRole("dialog", { name: "Approve the research (G2)?" });
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Trần Thị B");
    await user.click(within(dialog).getByLabelText(/I reviewed every claim/));
    state.current = at(R2);
    await reload(client);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The research changed after you validated it");
    expect(within(dialog).getByRole("button", { name: "Approve research" })).toBeDisabled();
    expect(within(dialog).getByLabelText(/^Reviewer/)).toHaveValue("Trần Thị B"); // input kept
    expect(posted(calls, "/projects/p1/research/approve")).toHaveLength(0);
  });

  it("approves normally when the validated revision is still current", async () => {
    const after = at(REV, { gates: { g1: "approved", g2: "approved_not_applied" } }, { approval_status: "approved", applied: false });
    const { calls, user } = page(at(REV), {
      "POST /projects/p1/research/approve": () => ({ json: { result: { status: "approved", revision: REV,
        approval: { reviewer: "Trần Thị B", approved_at: "2026-11-23T12:00:00Z", comment: null, policy_version: "m5-research-3", meaning: "…" } },
        research: after } }),
    });
    const panel = await panelOf(user);
    await user.click(within(panel).getByRole("button", { name: "Validate research" }));
    await within(panel).findByText(/approvable/);
    await user.click(approveButton(panel));
    const dialog = await screen.findByRole("dialog", { name: "Approve the research (G2)?" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.type(within(dialog).getByLabelText(/^Reviewer/), "Trần Thị B");
    await user.click(within(dialog).getByLabelText(/I reviewed every claim/));
    await user.click(within(dialog).getByRole("button", { name: "Approve research" }));
    await waitFor(() => expect(posted(calls, "/projects/p1/research/approve")).toHaveLength(1));
    expect(posted(calls, "/projects/p1/research/approve")[0].expected_revision).toBe(REV);
    expect(await within(panel).findByText("Claim IDs not applied yet")).toBeInTheDocument();
  });

  const conflict: Reply = { status: 409, json: { error: { code: "human_edit_conflict", details: { paths: ["output/sources.md"] },
    message: "The engine refused to overwrite hand edits (output/sources.md). The UI never overwrites them: keep or restore them in the CLI first." } } };
  const exported = (written: string[], unchanged: string[]): Reply => ({ json: { result: { written, unchanged, revision: REV }, research: applied() } });
  const ALL = ["output/sources.md", "render/research/citation-plan.json"];

  async function exporting(replies: Reply[]) {
    const { calls, user } = page(applied(), { "POST /projects/p1/research/export": () => replies.shift()! });
    const panel = await panelOf(user);
    const click = () => user.click(within(panel).getByRole("button", { name: "Export research records" }));
    return { calls, panel, click };
  }

  it("a failed export after a successful one never shows the earlier success", async () => {
    const { panel, click, calls } = await exporting([exported(ALL, []), conflict]);
    await click();
    expect(await within(panel).findByText("Exported: 2 file(s) written.")).toBeInTheDocument();
    await click();
    expect(await within(panel).findByText("Export failed: nothing was overwritten.")).toBeInTheDocument();
    expect(within(panel).getByText(/refused to overwrite hand edits \(output\/sources.md\)/)).toBeInTheDocument();
    expect(within(panel).queryByText(/^Exported:/)).toBeNull();
    expect(within(panel).queryByText("output/sources.md")).toBeNull(); // no earlier file list
    expect(posted(calls, "/projects/p1/research/export")).toEqual([{ expected_revision: REV }, { expected_revision: REV }]);
  });

  it("a second successful export replaces the first result", async () => {
    const { panel, click } = await exporting([exported(ALL, []), exported([], ALL)]);
    await click();
    expect(await within(panel).findByText("Exported: 2 file(s) written.")).toBeInTheDocument();
    await click();
    expect(await within(panel).findByText("Exported: every file was already up to date.")).toBeInTheDocument();
    expect(within(panel).queryByText("Written:")).toBeNull();
    expect(within(panel).getByText("Unchanged:")).toBeInTheDocument();
  });

  it("an export where every file is up to date says so and lists them", async () => {
    const { panel, click } = await exporting([exported([], ALL)]);
    await click();
    expect(await within(panel).findByText("Exported: every file was already up to date.")).toBeInTheDocument();
    expect(within(panel).getByText("render/research/citation-plan.json")).toBeInTheDocument();
  });

  it("a failed export followed by a successful retry shows only the retry", async () => {
    const { panel, click } = await exporting([conflict, exported(["output/sources.md"], ["render/research/citation-plan.json"])]);
    await click();
    expect(await within(panel).findByText("Export failed: nothing was overwritten.")).toBeInTheDocument();
    await click();
    expect(await within(panel).findByText("Exported: 1 file(s) written.")).toBeInTheDocument();
    expect(within(panel).queryByText("Export failed: nothing was overwritten.")).toBeNull();
  });

  it("offers no validation while a job is changing the project, and again once it finishes", async () => {
    const { state, client, user } = page(at(REV, { active_job_id: "job-1" }));
    const panel = await panelOf(user);
    expect(within(panel).getByRole("button", { name: "Validate research" })).toBeDisabled();
    expect(within(panel).getByText("A job is running for this project.")).toBeInTheDocument();
    state.current = at(REV, { active_job_id: null });
    await reload(client);
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Validate research" })).toBeEnabled());
    expect(within(panel).queryByText("A job is running for this project.")).toBeNull();
  });
});
