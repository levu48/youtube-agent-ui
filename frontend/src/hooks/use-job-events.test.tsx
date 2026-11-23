/**
 * Regression tests for review findings (docs/reviews/pr-1-chatgpt-review.md):
 *  - P2: no missing/duplicated events after a long disconnect (>1,000 events)
 *  - P2: jobs already terminal at load trigger the same (single) completion refresh
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobCard } from "@/components/job-card";
import { useJobEvents, type CompletionInfo } from "@/hooks/use-job-events";
import type { JobEvent, JobStatus } from "@/lib/api";

const JOB = "11111111-1111-4111-8111-111111111111";

// ------------------------------------------------------------------ fake backend

class FakeServer {
  events: JobEvent[] = [];
  status: JobStatus = "running";
  pageRequests: { after: number; limit: number }[] = [];
  beforePage?: (n: number) => void;
  private nextId = 1;

  push(type: string, data: Record<string, unknown> = {}) {
    const e: JobEvent = { id: this.nextId++, type, data, created_at: "2026-11-20T16:00:00Z" };
    this.events.push(e);
    return e;
  }
  logs(n: number) {
    for (let i = 0; i < n; i++) this.push("log", { sequence: i, stream: "stdout", message: `line ${i}` });
  }
  complete(status: JobStatus = "succeeded") {
    this.status = status;
    return this.push("completed", { status, exit_code: 0, message: "done" });
  }
  job() {
    return {
      id: JOB, project_id: "hcm-demo", type: "draft", status: this.status,
      created_at: "2026-11-20T16:00:00Z", started_at: "2026-11-20T16:00:00Z",
      finished_at: null, exit_code: null, message: null, error_message: null, error_code: null,
      cancel_requested: false, provider: "fixture", model: null, from_stage: "outline",
      events: [], events_truncated: false,
    };
  }
  fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://127.0.0.1:3000");
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/events/page")) {
      const after = Number(url.searchParams.get("after"));
      const limit = Number(url.searchParams.get("limit"));
      this.beforePage?.(this.pageRequests.length);
      this.pageRequests.push({ after, limit });
      const rest = this.events.filter((e) => e.id > after);
      const page = rest.slice(0, limit);
      return json({
        job_id: JOB, status: this.status, events: page,
        next_after: page.length ? page[page.length - 1].id : after, has_more: rest.length > limit,
      });
    }
    if (url.pathname === `/api/v1/jobs/${JOB}`) return json(this.job());
    return new Response(JSON.stringify({ error: { code: "not_found", message: "nf" } }), { status: 404 });
  };
}

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
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(e: JobEvent) {
    const msg = new MessageEvent(e.type, { data: JSON.stringify(e.data), lastEventId: String(e.id) });
    for (const cb of this.listeners.get(e.type) ?? []) cb(msg);
  }
  fail() {
    this.onerror?.();
  }
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  FakeEventSource.instances = [];
  globalThis.fetch = server.fetch as typeof fetch;
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const ids = (events: JobEvent[]) => events.map((e) => e.id);

// ------------------------------------------------------------------ hook

describe("useJobEvents", () => {
  it("recovers >1,000 events missed during a disconnect, in order, without duplicates", async () => {
    server.push("status", { status: "queued" });
    server.push("status", { status: "running" });
    server.logs(1);
    const onCompleted = vi.fn<(i: CompletionInfo) => void>();
    const { result } = renderHook(() => useJobEvents(JOB, onCompleted));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain("after=3"); // SSE resumes from the seeded cursor
    act(() => es.open());

    // Two events arrive live, then the connection drops for a long time.
    server.logs(2);
    act(() => {
      es.emit(server.events[3]);
      es.emit(server.events[4]);
    });
    server.logs(2500);
    server.complete();
    act(() => {
      es.fail();
      es.fail();
      es.fail();
    });

    await waitFor(() => expect(result.current.connection).toBe("closed"));
    expect(ids(result.current.events)).toEqual(ids(server.events)); // nothing missing
    expect(new Set(ids(result.current.events)).size).toBe(server.events.length); // no dupes
    expect(result.current.status).toBe("succeeded");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith({ live: true, status: "succeeded" });
    // Recovery paged by cursor from the last event seen, never "latest N".
    const recovery = server.pageRequests.slice(1);
    expect(recovery[0].after).toBe(5);
    expect(recovery.map((r) => r.after)).toEqual([5, 1005, 2005]);
  });

  it("seeds the full history of a long job by paging", async () => {
    server.push("status", { status: "running" });
    server.logs(2300);
    server.complete();
    const { result } = renderHook(() => useJobEvents(JOB));
    await waitFor(() => expect(result.current.connection).toBe("closed"));
    expect(ids(result.current.events)).toEqual(ids(server.events));
  });

  it("calls onCompleted once (live: false) for a job already terminal at load", async () => {
    server.push("status", { status: "running" });
    server.logs(3);
    server.complete();
    const onCompleted = vi.fn();
    const { result } = renderHook(() => useJobEvents(JOB, onCompleted));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onCompleted).toHaveBeenCalledWith({ live: false, status: "succeeded" });
    expect(FakeEventSource.instances).toHaveLength(0); // no stream for a finished job
    expect(result.current.connection).toBe("closed");
    await new Promise((r) => setTimeout(r, 50));
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("fetches the final event when the terminal status is visible before it", async () => {
    server.push("status", { status: "running" });
    server.status = "failed"; // committed, but the "completed" event is not written yet
    server.beforePage = (n) => {
      if (n === 1) server.push("completed", { status: "failed", exit_code: 10 });
    };
    const onCompleted = vi.fn();
    const { result } = renderHook(() => useJobEvents(JOB, onCompleted));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(result.current.events.at(-1)?.type).toBe("completed");
    expect(result.current.status).toBe("failed");
  });

  it("calls onCompleted once (live: true) when a running job completes, despite duplicates", async () => {
    server.push("status", { status: "running" });
    const onCompleted = vi.fn();
    renderHook(() => useJobEvents(JOB, onCompleted));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    const done = server.complete();
    act(() => {
      es.emit(done);
      es.emit(done); // duplicate delivery
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onCompleted).toHaveBeenCalledWith({ live: true, status: "succeeded" });
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });
});

// ------------------------------------------------------------------ JobCard refresh

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <JobCard jobId={JOB} />
    </QueryClientProvider>,
  );
  const keys = () => spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  return { keys };
}

describe("JobCard completion refresh", () => {
  it("refreshes project/job queries once for an already-completed job, without announcing", async () => {
    server.push("status", { status: "running" });
    server.complete();
    const { keys } = renderCard();
    await waitFor(() => expect(keys()).toContain(JSON.stringify(["project", "hcm-demo"])));
    await new Promise((r) => setTimeout(r, 50));
    expect(keys().filter((k) => k === JSON.stringify(["project", "hcm-demo"]))).toHaveLength(1);
    expect(keys()).toContain(JSON.stringify(["jobs"]));
    expect(keys()).toContain(JSON.stringify(["projects"]));
    // Named explicitly, so a research page reloads the engine's report after any job.
    expect(keys()).toContain(JSON.stringify(["project", "hcm-demo", "research"]));
    expect(screen.queryByText(/^Draft job succeeded\.$/)).toBeNull();
  });

  it("performs the same refresh and announces when the job completes live", async () => {
    server.push("status", { status: "running" });
    const { keys } = renderCard();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const done = server.complete();
    act(() => FakeEventSource.instances[0].emit(done));
    await waitFor(() => expect(keys()).toContain(JSON.stringify(["project", "hcm-demo"])));
    expect(keys().filter((k) => k === JSON.stringify(["project", "hcm-demo"]))).toHaveLength(1);
    expect(await screen.findByText("Draft job succeeded.")).toBeInTheDocument();
  });
});
