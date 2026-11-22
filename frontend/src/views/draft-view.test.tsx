import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EditableDraft } from "@/lib/api";
import { clearEdits } from "@/lib/edit-recovery";
import { LIMITS } from "@/test/fixtures";
import { mockFetch, renderWithQuery } from "@/test/utils";
import { DraftView } from "@/views/draft-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/p1/draft",
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const REV = "a".repeat(64);
const REV2 = "b".repeat(64);

function editable(over: Partial<EditableDraft> = {}, editing: Partial<EditableDraft["editing"]> = {}): EditableDraft {
  return {
    available: true,
    outline: {
      state: "ok",
      error: null,
      markdown: "# Hành trình",
      data: {
        title: "Hành trình",
        thesis_or_question: "Vì sao?",
        language: "vi",
        target_duration_seconds: 180,
        notice: null,
        generated_by: null,
        verification: null,
        sections: [
          { id: "sec-01", heading: "Mở đầu", role: "hook", purpose: "Giới thiệu", key_points: ["A"], claims_to_investigate: [], estimated_duration_seconds: 30 },
          { id: "sec-02", heading: "Bối cảnh", role: "context", purpose: "Bối cảnh", key_points: ["B"], claims_to_investigate: [], estimated_duration_seconds: 60 },
        ],
      },
    },
    script: {
      state: "ok",
      error: null,
      markdown: "# Hành trình\n\n## Mở đầu",
      data: {
        title: "Hành trình",
        language: "vi",
        target_duration_seconds: 180,
        notice: null,
        generated_by: null,
        verification: null,
        sections: [
          { outline_section_id: "sec-01", heading: "Mở đầu", narration: "Đoạn một.", summary: null, target_duration_seconds: 30, estimated_duration_seconds: 20, spoken_units: 3, editorial_notes: [], review_flags: [] },
          { outline_section_id: "sec-02", heading: "Bối cảnh", narration: "Đoạn hai.", summary: null, target_duration_seconds: 60, estimated_duration_seconds: 40, spoken_units: 3, editorial_notes: [], review_flags: [] },
        ],
      },
    },
    draft_check: { ok: true, errors: [], warnings: [], review_blockers: [], approval_status: "not_approved", approval_changed: [], revision: REV },
    draft_check_error: null,
    review_token: REV,
    review_token_reason: null,
    review_mode: "engine",
    approval: null,
    approval_confirmed: null,
    active_job_id: null,
    editing: { supported: true, can_edit: true, revision: REV, reason: null, reason_code: null, paths: [], limits: LIMITS, ...editing },
    ...over,
  } as EditableDraft;
}

function setup(routes: Parameters<typeof mockFetch>[0] = {}, draft = editable()) {
  const calls = mockFetch({
    "GET /projects/p1": () => ({ json: { id: "p1", display_name: "Dự án" } }),
    "GET /projects/p1/draft/editable": () => ({ json: draft }),
    ...routes,
  });
  const utils = renderWithQuery(<DraftView />);
  return { calls, ...utils, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearEdits("p1");
  vi.restoreAllMocks();
});

function publishedResult(changed: string[]) {
  return {
    status: "published", dry_run: false, previous_revision: REV, revision: REV2,
    changed_files: changed, human_edited: ["outline.json"],
    storyboard: { resplit_sections: [], scenes_added: [], scenes_removed: [], briefs_need_review: [] },
    check: { ok: true, errors: [], warnings: [], review_blockers: [] },
    approval_status: "not_approved", approval_changed: [],
  };
}

describe("draft editor", () => {
  it("edits the title, marks it unsaved, blocks approval, and saves only the change", async () => {
    const saved = editable({}, { revision: REV2 });
    saved.outline.data!.title = "Hành trình mới";
    const { calls, user } = setup({
      "POST /projects/p1/draft/edit": () => ({
        json: {
          result: {
            status: "published", dry_run: false, previous_revision: REV, revision: REV2,
            changed_files: ["outline.json", "outline.md"], human_edited: ["outline.json"],
            storyboard: { resplit_sections: [], scenes_added: [], scenes_removed: [], briefs_need_review: [] },
            check: { ok: true, errors: [], warnings: [], review_blockers: [] },
            approval_status: "not_approved", approval_changed: [],
          },
          draft: saved,
        },
      }),
    });
    const title = await screen.findByLabelText(/^Title/);
    expect(screen.getByText("Editable")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("There are no unsaved edits.");

    await user.clear(title);
    await user.type(title, "Hành trình mới");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Outline \(1 unsaved\)/ })).toBeInTheDocument();
    expect(save).toBeEnabled();

    // Approval is not offered while edits are unsaved.
    await user.click(screen.getByRole("tab", { name: "Validation" }));
    const approve = screen.getByRole("button", { name: /Approve Editorial Draft/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/unsaved edits/);

    await user.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      expected_revision: REV,
      outline: { title: "Hành trình mới" },
    });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalled();
    expect(screen.getByText(/Saved by the engine/)).toBeInTheDocument();
  });

  it("edits Vietnamese narration of a selected script section", async () => {
    const { calls, user } = setup({
      "POST /projects/p1/draft/edit": () => ({ status: 409, json: { error: { code: "engine_conflict", message: "busy", details: {} } } }),
    });
    await screen.findByLabelText(/^Title/);
    await user.click(screen.getByRole("tab", { name: "Script" }));
    const nav = screen.getByRole("navigation", { name: "Script sections" });
    await user.click(within(nav).getByRole("button", { name: /2\. Bối cảnh/ }));
    const narration = screen.getByLabelText(/^Narration/);
    expect(narration).toHaveAttribute("lang", "vi");
    await user.clear(narration);
    await user.type(narration, "Năm 1911, người thanh niên rời bến Nhà Rồng.");
    expect(within(nav).getByText("Edited")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      expected_revision: REV,
      script: { sections: [{ outline_section_id: "sec-02", narration: "Năm 1911, người thanh niên rời bến Nhà Rồng." }] },
    });
    // Not a conflict on the revision: shown as a save failure, edits kept.
    expect(await screen.findByText(/The edit was not saved/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Narration/)).toHaveValue("Năm 1911, người thanh niên rời bến Nhà Rồng.");
  });

  it("on a revision conflict, offers to copy the edits and reload; never overwrites", async () => {
    let fresh = false;
    const latest = editable({}, { revision: REV2 });
    latest.outline.data!.title = "Đổi từ CLI";
    const { calls, user } = setup({
      "GET /projects/p1/draft/editable": () => ({ json: fresh ? latest : editable() }),
      "POST /projects/p1/draft/edit": () => ({
        status: 409,
        json: { error: { code: "revision_conflict", message: "The draft changed since you loaded it.", details: { current_revision: REV2 } } },
      }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const title = await screen.findByLabelText(/^Title/);
    await user.clear(title);
    await user.type(title, "Của tôi");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    const dialog = await screen.findByRole("dialog", { name: "The draft changed since you loaded it" });
    const text = within(dialog).getByLabelText("Your unsaved edits");
    expect(text).toHaveValue("[Outline] Title:\nCủa tôi");
    await user.click(within(dialog).getByRole("button", { name: /Copy my edits/ }));
    expect(writeText).toHaveBeenCalledWith("[Outline] Title:\nCủa tôi");
    expect(within(dialog).getByText("Copied to the clipboard.")).toBeInTheDocument();

    // Keep editing: nothing is lost.
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Của tôi");

    // Reload latest: the edits are dropped only now, and the engine's latest version shows.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    fresh = true;
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Reload latest/ }));
    await waitFor(() => expect(screen.getByLabelText(/^Title/)).toHaveValue("Đổi từ CLI"));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("shows field problems and keeps Save disabled with the reason", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("tab", { name: "Script" }));
    const narration = screen.getByLabelText(/^Narration/);
    await user.clear(narration);
    await user.type(narration, "   ");
    expect(narration).toHaveAccessibleDescription(/cannot be empty/);
    expect(narration).toHaveAttribute("aria-invalid", "true");
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("Fix 1 field problem first.");
  });

  it("is read-only with the engine's reason when editing is not possible", async () => {
    setup({}, editable({}, { can_edit: false, reason: "The draft cannot be edited in place: later-stage work depends on it.", reason_code: "downstream_artifacts", paths: ["research-plan.json"] }));
    const title = await screen.findByLabelText(/^Title/);
    expect(title).toHaveAttribute("readonly");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText(/Editing is not available/)).toBeInTheDocument();
    expect(screen.getByText(/Depends on the draft: research-plan.json/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toHaveAccessibleDescription(/later-stage work depends on it/);
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it("discards only after confirmation", async () => {
    const { user } = setup();
    const title = await screen.findByLabelText(/^Title/);
    await user.type(title, " x");
    await user.click(screen.getByRole("button", { name: /Discard/ }));
    const dialog = await screen.findByRole("dialog", { name: "Discard your unsaved edits?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Hành trình x");
    await user.click(screen.getByRole("button", { name: /Discard/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard edits" }));
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Hành trình");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("lists the engine's reasons when it rejects an edit", async () => {
    const { user } = setup({
      "POST /projects/p1/draft/edit": () => ({
        status: 422,
        json: { error: { code: "invalid_edit", message: "the patch refers to unknown sections:", details: { errors: [{ loc: "outline.sections.0.id", msg: "no section 'sec-99'" }] } } },
      }),
    });
    await user.type(await screen.findByLabelText(/^Title/), " x");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("outline.sections.0.id: no section 'sec-99'")).toBeInTheDocument();
  });

  it("supports arrow-key navigation between tabs", async () => {
    const { user } = setup();
    const outlineTab = await screen.findByRole("tab", { name: "Outline" });
    outlineTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Script" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Script" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Validation" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Validation (draft-check)" })).toBeInTheDocument();
  });

  it("warns before unloading the page with unsaved edits", async () => {
    const { user } = setup();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.type(await screen.findByLabelText(/^Title/), " x");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("keeps edits typed while a save is pending and layers them on the saved version", async () => {
    const saved = editable({}, { revision: REV2 });
    saved.outline.data!.title = "Mới";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    const { calls, user } = setup({
      "POST /projects/p1/draft/edit": async () => {
        posts += 1;
        if (posts === 1) await gate; // the first save is slow
        return { json: { result: publishedResult(["outline.json", "outline.md"]), draft: saved } };
      },
    });
    const title = await screen.findByLabelText(/^Title/);
    await user.clear(title);
    await user.type(title, "Mới");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByRole("button", { name: /Saving…/ })).toBeDisabled();

    // While the engine is still saving: more typing in the same field and another field.
    await user.type(title, " thêm");
    await user.type(screen.getByLabelText(/^Central question/), " Ra sao?");
    release();

    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled());
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Mới thêm");
    expect(screen.getByLabelText(/^Central question/)).toHaveValue("Vì sao? Ra sao?");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Changes you made while saving are still unsaved.");

    // The next save is checked against the version the first save produced.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { expected_revision: REV, outline: { title: "Mới" } },
      { expected_revision: REV2, outline: { title: "Mới thêm", thesis_or_question: "Vì sao? Ra sao?" } },
    ]);
  });

  it("restores unsaved edits after leaving the page (browser Back), until saved or discarded", async () => {
    const first = setup();
    await first.user.type(await screen.findByLabelText(/^Title/), " x");
    first.unmount(); // what Back does: the page goes away without beforeunload or a link click

    const again = setup();
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình x");
    expect(screen.getByText(/Your unsaved edits were restored/)).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await again.user.click(screen.getByRole("button", { name: /Discard/ }));
    await again.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard edits" }));
    expect(screen.queryByText(/Your unsaved edits were restored/)).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.length).toBe(0));
    again.unmount();

    setup();
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình");
  });

  it("restores edits made on an older version as stale, so saving them is refused, not forced", async () => {
    const first = setup();
    await first.user.type(await screen.findByLabelText(/^Title/), " x");
    first.unmount();

    const newer = editable({}, { revision: REV2 });
    newer.outline.data!.title = "Đổi từ CLI";
    const { calls, user } = setup({
      "POST /projects/p1/draft/edit": () => ({
        status: 409,
        json: { error: { code: "revision_conflict", message: "The draft changed since you loaded it.", details: { current_revision: REV2 } } },
      }),
    }, newer);
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình x");
    expect(screen.getByText(/The draft changed since you started editing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByRole("dialog", { name: "The draft changed since you loaded it" });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ expected_revision: REV, outline: { title: "Hành trình x" } });
  });

  it("stores a small payload: the edits, the base revision and text, no Markdown or checks", async () => {
    const { user } = setup();
    await user.type(await screen.findByLabelText(/^Title/), " x");
    const raw = sessionStorage.getItem("yta:unsaved-draft-edits:p1")!;
    const stored = JSON.parse(raw);
    expect(Object.keys(stored).sort()).toEqual(["edits", "outline", "revision", "savedAt", "script", "v"]);
    expect(stored.revision).toBe(REV);
    expect(raw).not.toContain("# Hành trình\n\n## Mở đầu"); // the script Markdown
    expect(screen.queryByText(/not keeping a backup/)).not.toBeInTheDocument();
  });

  it("when sessionStorage refuses the backup: warns, offers a copy, and still restores after Back", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const first = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const title = await screen.findByLabelText(/^Title/);
    await first.user.type(title, " x");
    expect(setItem).toHaveBeenCalled();
    const warning = await screen.findByText(/not keeping a backup of your unsaved edits/);
    const alert = warning.closest("[role=alert]") as HTMLElement;
    await first.user.click(within(alert).getByRole("button", { name: /Copy my edits/ }));
    expect(writeText).toHaveBeenCalledWith("[Outline] Title:\nHành trình x");
    first.unmount();

    // Back within the app: the in-memory copy restores the edits.
    const again = setup();
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình x");
    expect(screen.getByText(/Your unsaved edits were restored/)).toBeInTheDocument();
    expect(screen.getByText(/not keeping a backup/)).toBeInTheDocument();

    // Discarding clears both copies and the warning.
    await again.user.click(screen.getByRole("button", { name: /Discard/ }));
    await again.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard edits" }));
    expect(screen.queryByText(/not keeping a backup/)).not.toBeInTheDocument();
    again.unmount();
    setup();
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình");
  });

  it("restores from sessionStorage alone (after a reload, when memory is gone)", async () => {
    const first = setup();
    await first.user.type(await screen.findByLabelText(/^Title/), " x");
    first.unmount();
    const raw = sessionStorage.getItem("yta:unsaved-draft-edits:p1")!;
    clearEdits("p1"); // drops memory and storage: put the stored copy back, as after a reload
    sessionStorage.setItem("yta:unsaved-draft-edits:p1", raw);
    setup();
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Hành trình x");
  });
});
