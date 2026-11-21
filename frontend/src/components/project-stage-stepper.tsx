import { StageStatusBadge } from "@/components/status-badge";
import type { StatusSummary } from "@/lib/api";
import { stageName } from "@/lib/status";
import { cn } from "@/lib/utils";

// Later workflow steps (docs/ui-design.md §8): noninteractive preview labels only.
const FUTURE = ["research", "visuals", "narration", "render", "review"];

export function ProjectStageStepper({ status }: { status: StatusSummary | undefined }) {
  if (!status) return null;
  if (!status.available) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
        Status unavailable{status.error ? `: ${status.error}` : ""}
      </p>
    );
  }
  const reported = new Set(status.stages.map((s) => s.stage));
  const future = FUTURE.filter((f) => !reported.has(f));
  const current = status.current_stage?.stage;
  return (
    <div>
      <h2 className="sr-only">Production stages (reported by the engine)</h2>
      <ol className="flex flex-wrap gap-2">
        {status.stages.map((s, i) => (
          <li
            key={s.stage}
            aria-current={s.stage === current ? "step" : undefined}
            className={cn(
              "flex min-w-36 flex-1 flex-col gap-1.5 rounded-lg border bg-surface p-3",
              s.stage === current && "border-primary ring-1 ring-primary",
            )}
          >
            <span className="text-xs text-muted-foreground">Step {i + 1}</span>
            <span className="font-medium">{stageName(s.stage)}</span>
            <StageStatusBadge status={s.status} className="self-start" />
            {s.detail ? <span className="text-xs text-muted-foreground">{s.detail}</span> : null}
          </li>
        ))}
        {future.map((f) => (
          <li
            key={f}
            className="flex min-w-28 flex-1 flex-col gap-1.5 rounded-lg border border-dashed bg-surface-muted/50 p-3 text-slate-600"
          >
            <span className="text-xs">Coming later</span>
            <span className="font-medium">{stageName(f)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
