import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobCard } from "@/components/job-card";
import { mockFetch, renderWithQuery } from "@/test/utils";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const JOB = "22222222-2222-4222-8222-222222222222";

function job(over: Record<string, unknown>) {
  return {
    id: JOB, project_id: "p1", type: "research-add-url", status: "succeeded", created_at: "2026-11-28T07:00:00Z",
    started_at: "2026-11-28T07:00:00Z", finished_at: "2026-11-28T07:00:02Z", exit_code: 0, message: "Source added and its page saved",
    error_message: null, error_code: null, cancel_requested: false, provider: null, model: null, from_stage: null,
    events: [], events_truncated: false, ...over,
  };
}

function setup(j: Record<string, unknown>) {
  mockFetch({
    [`GET /jobs/${JOB}`]: () => ({ json: j }),
    [`GET /jobs/${JOB}/events/page`]: () => ({ json: { job_id: JOB, status: j.status, events: [], next_after: 0, has_more: false } }),
  });
  renderWithQuery(<JobCard jobId={JOB} title="Research job" />);
}

afterEach(() => vi.unstubAllGlobals());

describe("job outcome", () => {
  it("a page the engine did not save is a warning with the engine's detail, not a plain success", async () => {
    setup(job({
      message: "Source recorded, but its page was not saved: the page is larger than the engine's size limit",
      error_code: "page_not_saved", error_message: "response from vi.wikipedia.org exceeds 2097152 bytes",
    }));
    const msg = await screen.findByText(/its page was not saved: the page is larger than the engine's size limit/);
    expect(msg.closest("div")).toHaveClass("bg-amber-50");
    expect(screen.getByText("Engine: response from vi.wikipedia.org exceeds 2097152 bytes")).toBeInTheDocument();
    expect(screen.queryByText(/^Source added/)).not.toBeInTheDocument();
  });

  it("a saved page stays a plain success", async () => {
    setup(job({}));
    expect(await screen.findByText(/Source added and its page saved/)).toHaveClass("text-success");
  });
});
