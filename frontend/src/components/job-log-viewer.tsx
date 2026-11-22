"use client";

import { Copy } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { Connection } from "@/hooks/use-job-events";
import type { JobEvent } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CONNECTION_TEXT: Record<Connection, string> = {
  idle: "",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Live updates unavailable; checking every few seconds",
  closed: "Finished",
};

function lineText(e: JobEvent): string {
  const d = e.data ?? {};
  if (e.type === "log") return String(d.message ?? "");
  if (e.type === "status") return `[${String(d.status ?? "status")}] ${String(d.message ?? "")}`.trim();
  if (e.type === "cancel_requested") return `[cancel requested] ${String(d.message ?? "")}`.trim();
  if (e.type === "completed") {
    const code = d.exit_code == null ? "" : ` (exit ${String(d.exit_code)})`;
    const msg = [d.message, d.error_message].filter(Boolean).join(": ");
    return `[${String(d.status)}${code}] ${msg}`.trim();
  }
  return `[${e.type}] ${String(d.message ?? "")}`.trim();
}

function lineTime(e: JobEvent): string {
  const ts = (e.data?.ts as string | undefined) ?? e.created_at;
  return formatTime(ts);
}

export function JobLogViewer({
  events,
  connection,
  emptyText = "No engine output yet. Lines appear as the engine reports each step.",
}: {
  events: JobEvent[];
  connection: Connection;
  emptyText?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const copy = async () => {
    const text = events.map((e) => `${lineTime(e)} ${lineText(e)}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Logs copied");
    } catch {
      toast.error("Could not copy logs");
    }
  };

  const hasOutput = events.some((e) => e.type === "log");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="job-log-title">
          Engine log
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{CONNECTION_TEXT[connection]}</span>
          <Button variant="outline" size="sm" onClick={copy} disabled={events.length === 0}>
            <Copy aria-hidden />
            Copy logs
          </Button>
        </div>
      </div>
      <div
        ref={ref}
        role="log"
        aria-live="off"
        aria-labelledby="job-log-title"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-96 min-h-32 overflow-auto rounded-lg border bg-slate-950 p-3 font-mono text-[13px] leading-relaxed text-slate-100 select-text"
      >
        {events.length === 0 ? (
          <p className="text-slate-400">Waiting for events…</p>
        ) : (
          <ol className="space-y-0.5">
            {events.map((e) => (
              <li
                key={e.id}
                className={cn(
                  "grid grid-cols-[auto_1fr] gap-3 break-words whitespace-pre-wrap",
                  e.type !== "log" && "text-sky-300",
                  e.type === "log" && e.data?.stream === "stderr" && "text-amber-200",
                )}
              >
                <span className="text-slate-400 tabular-nums">{lineTime(e)}</span>
                <span>{lineText(e)}</span>
              </li>
            ))}
            {!hasOutput && connection !== "closed" ? (
              <li className="text-slate-400">{emptyText}</li>
            ) : null}
          </ol>
        )}
      </div>
    </div>
  );
}
