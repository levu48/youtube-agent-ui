"use client";

import { useEffect, useRef, useState } from "react";

import { api, isTerminal, type JobEvent, type JobStatus } from "@/lib/api";

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "polling" | "closed";

const EVENT_TYPES = ["status", "log", "log_truncated", "cancel_requested", "completed"] as const;
/**
 * Client-side display retention. The backend persists at most 5,000 log events per job plus
 * a handful of lifecycle events, so this cap does not drop events in practice; it only
 * bounds memory if that limit ever changes. Event *delivery* is always complete (cursor
 * paging and SSE replay); retention is a separate, display-only concern.
 */
export const MAX_EVENTS = 6000;
const POLL_MS = 2000;
const MAX_SSE_ERRORS = 3;
const PAGE = 1000;

export interface CompletionInfo {
  /** true when the job finished while this view was watching; false if already terminal. */
  live: boolean;
  status: JobStatus;
}

export interface JobEventsState {
  events: JobEvent[];
  connection: Connection;
  /** Latest status reported by a real lifecycle event (never synthesised). */
  status: JobStatus | null;
  cancelRequested: boolean;
  error: string | null;
}

export function mergeEvents(prev: JobEvent[], incoming: JobEvent[]): JobEvent[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  const out = [...byId.values()].sort((a, b) => a.id - b.id);
  return out.length > MAX_EVENTS ? out.slice(out.length - MAX_EVENTS) : out;
}

function derive(events: JobEvent[]) {
  let status: JobStatus | null = null;
  let cancelRequested = false;
  for (const e of events) {
    const s = e.data?.status;
    if ((e.type === "status" || e.type === "completed") && typeof s === "string") status = s as JobStatus;
    if (e.type === "cancel_requested") cancelRequested = true;
  }
  return { status, cancelRequested };
}

/**
 * Subscribe to a job's persisted events without gaps:
 *  1. seed by paging `GET /jobs/{id}/events/page?after=<cursor>` until `has_more` is false;
 *  2. stream SSE from the last seen id (the browser resumes with Last-Event-ID);
 *  3. after repeated SSE failures, poll the same cursor endpoint (all pages each time).
 * Events are merged by id, so order is preserved and duplicates are dropped.
 *
 * `onCompleted` is called exactly once per mount when the job is terminal, whether it was
 * already terminal at load (`live: false`) or finished while watching (`live: true`).
 * Mount one instance per job (e.g. `key={jobId}`) so state starts fresh.
 */
export function useJobEvents(
  jobId: string | null,
  onCompleted?: (info: CompletionInfo) => void,
): JobEventsState {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [connection, setConnection] = useState<Connection>(jobId ? "connecting" : "idle");
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef(onCompleted);
  useEffect(() => {
    completedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;
    let finished = false;
    let sawCompleted = false;
    let watchedLive = false;
    let sseErrors = 0;

    const add = (batch: JobEvent[]) => {
      if (batch.length === 0) return;
      for (const e of batch) {
        cursor = Math.max(cursor, e.id);
        if (e.type === "completed") sawCompleted = true;
      }
      setEvents((prev) => mergeEvents(prev, batch));
    };

    const finish = (status: JobStatus) => {
      if (finished || cancelled) return;
      finished = true;
      es?.close();
      es = null;
      if (pollTimer) clearTimeout(pollTimer);
      setConnection("closed");
      completedRef.current?.({ live: watchedLive, status });
    };

    /** Fetch every event after the cursor (all pages). Returns the job status. */
    const catchUp = async (): Promise<JobStatus> => {
      for (;;) {
        const page = await api.eventsPage(jobId, cursor, PAGE);
        if (cancelled) return page.status;
        add(page.events);
        if (!page.has_more) return page.status;
      }
    };

    /** Terminal status is committed just before the final "completed" event: read once more. */
    const settleIfTerminal = async (status: JobStatus): Promise<boolean> => {
      if (!isTerminal(status)) return false;
      if (!sawCompleted) await catchUp();
      finish(status);
      return true;
    };

    const poll = async () => {
      if (cancelled || finished) return;
      try {
        const status = await catchUp();
        setError(null);
        if (await settleIfTerminal(status)) return;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Cannot reach the backend.");
      }
      if (!cancelled && !finished) pollTimer = setTimeout(poll, POLL_MS);
    };

    const startPolling = () => {
      es?.close();
      es = null;
      setConnection("polling");
      void poll();
    };

    const openStream = () => {
      if (typeof EventSource === "undefined") return startPolling();
      es = new EventSource(api.eventsUrl(jobId, cursor));
      es.onopen = () => {
        sseErrors = 0;
        setError(null);
        setConnection("live");
      };
      es.onerror = () => {
        if (finished || cancelled) return;
        sseErrors += 1;
        if (es?.readyState === EventSource.CLOSED || sseErrors >= MAX_SSE_ERRORS) startPolling();
        else setConnection("reconnecting");
      };
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (raw) => {
          const msg = raw as MessageEvent<string>;
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(msg.data);
          } catch {
            return;
          }
          const id = Number(msg.lastEventId);
          if (!Number.isFinite(id)) return;
          add([{ id, type, data, created_at: String(data.created_at ?? "") }]);
          if (type === "completed") finish(String(data.status ?? "succeeded") as JobStatus);
        });
      }
    };

    (async () => {
      try {
        const status = await catchUp();
        if (cancelled) return;
        if (await settleIfTerminal(status)) return;
        watchedLive = true;
        openStream();
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Cannot load the job.");
        watchedLive = true;
        startPolling();
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [jobId]);

  return { events, connection, error, ...derive(events) };
}
