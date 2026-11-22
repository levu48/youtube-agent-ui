import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalPanel, approvalBlocker } from "@/components/draft/approval-panel";
import type { DraftCheck, DraftView } from "@/lib/api";
import { qk } from "@/lib/queries";
import { mockFetch, renderWithQuery } from "@/test/utils";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const TOKEN = "a".repeat(64);

function check(over: Partial<DraftCheck> = {}): DraftCheck {
  return {
    ok: true,
    errors: [],
    warnings: [],
    review_blockers: ["Content is unverified: an LLM is not a research source.", "8 statement(s) flagged for review."],
    approval_status: "not_approved",
    approval_changed: [],
    ...over,
  };
}

function draft(over: Partial<DraftView> = {}): DraftView {
  return {
    available: true,
    outline: { state: "ok", error: null, data: null, markdown: null },
    script: { state: "ok", error: null, data: null, markdown: null },
    draft_check: check(),
    draft_check_error: null,
    review_token: TOKEN,
    approval: null,
    active_job_id: null,
    ...over,
  } as DraftView;
}

const approvedRecord = {
  status: "approved",
  reviewer: "Nguyễn Văn A",
  approved_at: "2026-11-21T12:00:00Z",
  comment: "Đã xem",
  artifacts: {},
  unresolved_blockers: [],
  meaning: null,
};

function setup(d: DraftView, routes: Parameters<typeof mockFetch>[0] = {}) {
  const calls = mockFetch(routes);
  const onValidate = vi.fn();
  const utils = renderWithQuery(<ApprovalPanel projectId="p1" draft={d} onValidate={onValidate} validating={false} />);
  return { calls, onValidate, ...utils };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

async function approveAs(name = "B") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/Reviewer name/), name);
  await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve draft" }));
  return user;
}

describe("approvalBlocker", () => {
  it("explains every reason approval is unavailable", () => {
    expect(approvalBlocker(draft())).toBeNull();
    expect(approvalBlocker(draft({ active_job_id: "j" }))).toMatch(/job is running/);
    expect(approvalBlocker(draft({ draft_check: null }))).toMatch(/could not be run/);
    expect(approvalBlocker(draft({ draft_check: check({ ok: false, errors: ["x"] }) }))).toMatch(/has errors/);
    expect(approvalBlocker(draft({ review_token: null }))).toMatch(/Validate it again/);
    const reason = "The engine report does not cover script.json.";
    expect(approvalBlocker(draft({ review_token: null, review_token_reason: reason }))).toBe(reason);
  });
});

describe("ApprovalPanel", () => {
  it("requires a reviewer name, then confirms with the disclaimer and blockers before calling the engine", async () => {
    const result = {
      already_approved: false,
      approved_version_matches: true,
      approval: approvedRecord,
      draft_check: check({ approval_status: "approved" }),
      draft_check_error: null,
      review_token: TOKEN,
      status: { available: true, stages: [], current_stage: null, error: null, error_code: null },
    };
    const { calls, client } = setup(draft(), { "POST /projects/p1/draft/approve": () => ({ json: result }) });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
    const name = screen.getByLabelText(/Reviewer name/);
    expect(name).toHaveFocus();
    expect(name).toHaveAccessibleDescription("Enter the reviewer's name.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.type(name, "Nguyễn Văn A");
    await user.type(screen.getByLabelText(/Comment/), "Đã xem");
    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));

    const dialog = await screen.findByRole("dialog", { name: "Approve this editorial draft (G1)?" });
    expect(dialog).toHaveTextContent(/does not verify historical claims, rights or release readiness/);
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing sent before confirming

    await user.click(within(dialog).getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      reviewer: "Nguyễn Văn A",
      comment: "Đã xem",
      confirm: true,
      review_token: TOKEN,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.getQueryData(qk.projectStatus("p1"))).toEqual(result.status);
    expect(window.localStorage.getItem("yta.reviewerName")).toBe("Nguyễn Văn A");
  });

  it("cancelling the confirmation sends nothing", async () => {
    const { calls } = setup(draft());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reviewer name/), "B");
    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Approve Editorial Draft/ })).toHaveFocus();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("is disabled with the reason when the engine check fails", () => {
    setup(draft({ draft_check: check({ ok: false, errors: ["script.json is missing"] }) }));
    const button = screen.getByRole("button", { name: /Approve Editorial Draft/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/refuses approval while the draft has errors/);
  });

  it("is disabled while a draft job is running", () => {
    setup(draft({ active_job_id: "job-1" }));
    expect(screen.getByRole("button", { name: /Approve Editorial Draft/ })).toBeDisabled();
  });

  it("shows a changed-draft conflict with a way to load the latest version", async () => {
    const { onValidate } = setup(draft(), {
      "POST /projects/p1/draft/approve": () => ({
        status: 409,
        json: { error: { code: "draft_changed", message: "The draft changed after you last validated it.", details: {} } },
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reviewer name/), "B");
    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The draft changed after you last validated it.");
    await user.click(within(alert).getByRole("button", { name: /Load the latest draft/ }));
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it("lists the engine's reasons when it refuses", async () => {
    setup(draft(), {
      "POST /projects/p1/draft/approve": () => ({
        status: 422,
        json: {
          error: {
            code: "approval_refused",
            message: "The engine refused the approval: cannot approve: the draft has errors:",
            details: { errors: ["script.json is missing (run `ytagent draft`)"] },
          },
        },
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reviewer name/), "B");
    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve draft" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("listitem")).toHaveTextContent("script.json is missing");
  });

  it("shows a current approval from the engine without the form", () => {
    setup(draft({ draft_check: check({ approval_status: "approved" }), approval: approvedRecord }));
    expect(screen.getByText("G1 approved")).toBeInTheDocument();
    expect(screen.getByText(/Approved by Nguyễn Văn A/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve Editorial Draft/ })).not.toBeInTheDocument();
  });

  it("never shows a stale approval as current", () => {
    setup(
      draft({
        draft_check: check({ approval_status: "stale", approval_changed: ["outline.json"] }),
        approval: approvedRecord,
      }),
    );
    expect(screen.getByText("G1 approval out of date")).toBeInTheDocument();
    expect(screen.queryByText("G1 approved")).not.toBeInTheDocument();
    expect(screen.getByText(/Previously approved by Nguyễn Văn A/)).toBeInTheDocument();
    expect(screen.getByText(/outline.json changed after it was approved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve Editorial Draft/ })).toBeEnabled();
  });

  it("warns when the engine approved a different version than the one checked", async () => {
    setup(draft(), {
      "POST /projects/p1/draft/approve": () => ({
        json: {
          already_approved: false,
          approved_version_matches: false,
          approval: approvedRecord,
          draft_check: check({ approval_status: "approved" }),
          draft_check_error: null,
          review_token: TOKEN,
          status: { available: true, stages: [], current_stage: null },
        },
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reviewer name/), "B");
    await user.click(screen.getByRole("button", { name: /Approve Editorial Draft/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/approved a slightly different version/);
    // Mismatch takes precedence: no success toast even though the engine reports "approved".
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/does not match the version you validated/));
  });

  it("treats an unconfirmed approval (409) as a failure, never a success", async () => {
    const { onValidate } = setup(draft(), {
      "POST /projects/p1/draft/approve": () => ({
        status: 409,
        json: {
          error: {
            code: "approval_unconfirmed",
            message: "The engine recorded an approval, but a file changed while it was being approved.",
            details: { approval_status: "approved" },
          },
        },
      }),
    });
    const user = await approveAs();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/a file changed while it was being approved/);
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: /Load the latest draft/ }));
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it("never presents an unconfirmed engine approval as approved", () => {
    setup(
      draft({
        draft_check: check({ approval_status: "approved" }),
        approval: approvedRecord,
        approval_confirmed: false,
      }),
    );
    expect(screen.getByText("G1 approval unconfirmed")).toBeInTheDocument();
    expect(screen.queryByText("G1 approved")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Approved by/)).not.toBeInTheDocument();
    expect(screen.getByText(/Unconfirmed approval by Nguyễn Văn A/)).toBeInTheDocument();
    // The reviewer can confirm the current version by approving it.
    expect(screen.getByRole("button", { name: /Approve Editorial Draft/ })).toBeEnabled();
  });
});
