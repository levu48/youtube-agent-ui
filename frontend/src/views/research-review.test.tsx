import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FixturePanel } from "@/components/draft/fixture-panel";
import { AddClaimDialog } from "@/components/research/add-claim-dialog";
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
