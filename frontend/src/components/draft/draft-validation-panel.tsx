import { AlertTriangle, CheckCircle2, ShieldAlert, UserCheck, XCircle } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { DraftCheck } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { humanize } from "@/lib/status";

function List({
  title,
  items,
  icon: Icon,
  tone,
}: {
  title: string;
  items: string[];
  icon: typeof XCircle;
  tone: string;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className={`flex items-center gap-1.5 text-sm font-semibold ${tone}`}>
        <Icon aria-hidden className="size-4" />
        {title} ({items.length})
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** Results of the engine's `draft-check --json`, shown as reported. */
export function DraftValidationPanel({ check, error }: { check: DraftCheck | null; error?: string | null }) {
  return (
    <section aria-labelledby="validation-title" className="space-y-4 rounded-[var(--radius-card)] border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="validation-title" className="text-lg font-semibold">
          Validation (draft-check)
        </h2>
        {check ? (
          <StatusBadge
            presentation={
              check.ok
                ? { label: "Checks passed", tone: "success", icon: CheckCircle2 }
                : { label: "Checks failed", tone: "danger", icon: XCircle }
            }
          />
        ) : null}
      </div>
      {!check ? (
        <p className="text-sm text-warning">The engine check could not be run{error ? `: ${error}` : "."}</p>
      ) : (
        <>
          <List title="Errors" items={check.errors} icon={XCircle} tone="text-danger" />
          <List title="Warnings" items={check.warnings} icon={AlertTriangle} tone="text-warning" />
          <List title="Needs human review" items={check.review_blockers} icon={ShieldAlert} tone="text-warning" />
          <div className="space-y-1.5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <UserCheck aria-hidden className="size-4" /> Editorial approval (G1)
            </h3>
            <p className="text-sm">
              Engine reports: <strong>{humanize(check.approval_status)}</strong>.{" "}
              {check.approval_status !== "approved"
                ? "Approval is recorded with the engine CLI (draft-approve); this viewer is read-only."
                : null}
            </p>
          </div>
          {check.timing ? (
            <p className="text-sm text-muted-foreground">
              Estimated narration {formatClock(check.timing.estimated_seconds)} for a{" "}
              {formatClock(check.timing.target_seconds)} target ({check.timing.deviation >= 0 ? "+" : ""}
              {(check.timing.deviation * 100).toFixed(1)}%,{" "}
              {check.timing.within_tolerance ? "within" : "outside"} ±{Math.round(check.timing.tolerance * 100)}%).
            </p>
          ) : null}
          {check.flag_counts && Object.keys(check.flag_counts).length ? (
            <p className="text-sm text-muted-foreground">
              Review flags:{" "}
              {Object.entries(check.flag_counts)
                .map(([k, n]) => `${humanize(k)} ${n}`)
                .join(" · ")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
