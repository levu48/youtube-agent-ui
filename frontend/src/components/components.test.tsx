import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DraftContent } from "@/components/draft/draft-content";
import { DraftValidationPanel } from "@/components/draft/draft-validation-panel";
import { SafeMarkdown } from "@/components/draft/safe-markdown";
import { JobLogViewer } from "@/components/job-log-viewer";
import { ProjectCreateForm } from "@/components/project-create-form";
import { JobStatusBadge } from "@/components/status-badge";
import type { JobEvent, Script } from "@/lib/api";
import { mockFetch, renderWithQuery } from "@/test/utils";
import { useState } from "react";
import { render } from "@testing-library/react";

const config = { projects_root: "~/Documents/YouTubeAgent/projects", default_language: "vi", default_model: "qwen3:8b", providers: ["ollama"] };

describe("ProjectCreateForm", () => {
  it("is keyboard-operable, suggests a slug and submits seconds", async () => {
    const calls = mockFetch({
      "GET /system/config": () => ({ json: config }),
      "GET /projects/location-preview": () => ({
        json: { slug: "x", location: "~/Documents/YouTubeAgent/projects/x", available: true, reason: null },
      }),
      "POST /projects": () => ({ status: 201, json: { id: "ho-chi-minh", status: "created", next_action: "generate_draft" } }),
    });
    const user = userEvent.setup();
    renderWithQuery(<ProjectCreateForm />);

    const idea = screen.getByLabelText(/Documentary topic/);
    await user.click(idea);
    await user.keyboard("Hồ Chí Minh");
    expect(screen.getByLabelText(/Project slug/)).toHaveValue("ho-chi-minh");

    const duration = screen.getByLabelText(/Target duration/);
    await user.clear(duration);
    await user.type(duration, "2.5");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/projects")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ slug: "ho-chi-minh", idea: "Hồ Chí Minh", language: "vi", duration_seconds: 150 });
  });

  it("shows field errors, focuses the first and keeps input", async () => {
    mockFetch({ "GET /system/config": () => ({ json: config }) });
    const user = userEvent.setup();
    renderWithQuery(<ProjectCreateForm />);
    await user.type(screen.getByLabelText(/Documentary topic/), "abc");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    const idea = screen.getByLabelText(/Documentary topic/);
    expect(idea).toHaveAttribute("aria-invalid", "true");
    expect(idea).toHaveAccessibleDescription(/at least 5 characters/);
    expect(idea).toHaveFocus();
    expect(idea).toHaveValue("abc");
    expect(screen.getByRole("alert")).toHaveTextContent(/field/);
  });

  it("maps server conflicts onto the slug field", async () => {
    mockFetch({
      "GET /system/config": () => ({ json: config }),
      "POST /projects": () => ({
        status: 409,
        json: { error: { code: "path_exists", message: "A folder with this name already exists.", details: {} } },
      }),
    });
    const user = userEvent.setup();
    renderWithQuery(<ProjectCreateForm />);
    await user.type(screen.getByLabelText(/Documentary topic/), "A valid idea");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    const slug = await screen.findByLabelText(/Project slug/);
    await waitFor(() => expect(slug).toHaveAccessibleDescription(/already exists/));
  });
});

describe("JobStatusBadge", () => {
  it("labels status in text, not colour alone", () => {
    render(<JobStatusBadge status="interrupted" />);
    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    render(<JobStatusBadge status="running" cancelling />);
    expect(screen.getByText("Cancelling…")).toBeInTheDocument();
  });
});

describe("JobLogViewer", () => {
  const events: JobEvent[] = [
    { id: 1, type: "status", data: { status: "running", message: "Engine running" }, created_at: "2026-11-20T16:00:00Z" },
    { id: 2, type: "log", data: { stream: "stdout", message: "draft published", ts: "2026-11-20T16:00:01Z" }, created_at: "" },
    { id: 3, type: "completed", data: { status: "succeeded", exit_code: 0, message: "Draft generation finished" }, created_at: "" },
  ];
  it("renders real events in a non-announcing log region", () => {
    render(<JobLogViewer events={events} connection="closed" />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "off");
    expect(within(log).getByText("draft published")).toBeInTheDocument();
    expect(within(log).getByText(/succeeded \(exit 0\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy logs/ })).toBeEnabled();
  });
  it("shows reconnecting state without changing events", () => {
    render(<JobLogViewer events={events} connection="reconnecting" />);
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});

describe("ConfirmDialog", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Cancel job</button>
        <ConfirmDialog open={open} onOpenChange={setOpen} title="Stop this draft generation?" confirmLabel="Stop generation" onConfirm={() => setOpen(false)} />
      </>
    );
  }
  it("traps focus, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Cancel job" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Stop this draft generation?" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("draft rendering", () => {
  const script: Script = {
    title: "Bản nháp",
    language: "vi",
    target_duration_seconds: 180,
    notice: null,
    generated_by: "fixture",
    verification: null,
    sections: [
      {
        outline_section_id: "sec-01",
        heading: "Câu hỏi đặt ra",
        narration: "Đoạn một.\n\nĐoạn hai có dấu: ắ ặ ẫ ỡ ự.",
        summary: null,
        target_duration_seconds: 36,
        estimated_duration_seconds: 37,
        review_flags: [{ kind: "source_needed", excerpt: "Năm 1945", note: "Confirm.", origin: "rule" }],
      },
    ],
  };
  it("renders Vietnamese text faithfully with lang attribute", () => {
    render(<DraftContent script={script} />);
    expect(screen.getByRole("heading", { name: "1. Câu hỏi đặt ra" })).toBeInTheDocument();
    expect(screen.getByText("Đoạn hai có dấu: ắ ặ ẫ ỡ ự.")).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveAttribute("lang", "vi");
    expect(screen.getByText("Source needed")).toBeInTheDocument();
  });
  it("never renders raw HTML or unsafe links from Markdown", () => {
    const { container } = render(
      <SafeMarkdown>{'# T\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://example.org)'}</SafeMarkdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
  it("distinguishes errors, warnings and approval in validation", () => {
    render(
      <DraftValidationPanel
        check={{ ok: false, errors: ["script.json is missing"], warnings: ["long"], review_blockers: ["unverified"], approval_status: "not_approved" }}
      />,
    );
    expect(screen.getByText("Checks failed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Errors \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Warnings \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Needs human review \(1\)/ })).toBeInTheDocument();
    expect(screen.getByText(/Not approved/)).toBeInTheDocument();
  });
});
