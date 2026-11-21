"use client";

import { useEffect, useRef, useState } from "react";

import { api, isTerminal, type JobEvent, type JobStatus } from "@/lib/api";

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "polling" | "closed";

const EVENT_TYPES = ["status", "log", "log_truncated", "cancel_requested", "completed"] as const;
const MAX_EVENTS = 5000;
const POLL_MS = 2000;
const MAX_SSE_ERRORS = 3;

export interface JobEventsState {
  events: JobEvent[];
  connection: Connection;
  /** Latest status reported by a real lifecycle event (never synthesised). */
  status: JobStatus | null;
  cancelRequested: boolean;
  error: string | null;
}

function merge(prev: JobEvent[], incoming: JobEvent[]): JobEvent[] {
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
 * Subscribe to a job's persisted events: seed from `GET /jobs/{id}`, then SSE from the
 * last seen id. The browser resumes with Last-Event-ID; after repeated failures we fall
 * back to polling. Disconnects never reset the displayed status.
 * Mount one instance per job (e.g. `key={jobId}`) so state starts fresh.
 */
export function useJobEvents(jobId: string | null, onCompleted?: () => void): JobEventsState {
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
    let lastId = 0;
    let finished = false;
    let sseErrors = 0;

    const add = (batch: JobEvent[]) => {
      if (batch.length === 0) return;
      lastId = Math.max(lastId, ...batch.map((e) => e.id));
      setEvents((prev) => merge(prev, batch));
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
      setConnection("closed");
      completedRef.current?.();
    };

    const poll = async () => {
      if (cancelled || finished) return;
      try {
        const job = await api.job(jobId, 1000);
        if (cancelled) return;
        add(job.events.filter((e) => e.id > lastId));
        setError(null);
        if (isTerminal(job.status)) return finish();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Cannot reach the backend.");
      }
      pollTimer = setTimeout(poll, POLL_MS);
    };

    const startPolling = () => {
      es?.close();
      es = null;
      setConnection("polling");
      void poll();
    };

    const openStream = () => {
      if (typeof EventSource === "undefined") return startPolling();
      setConnection((c) => (c === "idle" ? "connecting" : c));
      es = new EventSource(api.eventsUrl(jobId, lastId));
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
          if (type === "completed") finish();
        });
      }
    };

    api
      .job(jobId, 1000)
      .then((job) => {
        if (cancelled) return;
        add(job.events);
        if (isTerminal(job.status)) {
          finished = true;
          setConnection("closed");
          return;
        }
        openStream();
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Cannot load the job.");
        startPolling();
      });

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [jobId]);

  return { events, connection, error, ...derive(events) };
}
