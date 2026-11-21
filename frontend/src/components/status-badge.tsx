import type { JobStatus } from "@/lib/api";
import { JOB_STATUS, TONE_CLASSES, stagePresentation, type Presentation } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusBadge({
  presentation,
  prefix,
  className,
}: {
  presentation: Presentation;
  prefix?: string;
  className?: string;
}) {
  const Icon = presentation.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[presentation.tone],
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-3.5", presentation.spin && "motion-safe:animate-spin")} />
      {prefix ? <span className="sr-only">{prefix}: </span> : null}
      {presentation.label}
    </span>
  );
}

export function JobStatusBadge({
  status,
  cancelling,
  className,
}: {
  status: JobStatus;
  cancelling?: boolean;
  className?: string;
}) {
  const p = JOB_STATUS[status];
  const shown =
    cancelling && status === "running" ? { ...p, label: "Cancelling…", tone: "warning" as const } : p;
  return <StatusBadge presentation={shown} prefix="Job status" className={className} />;
}

export function StageStatusBadge({ status, className }: { status: string; className?: string }) {
  return <StatusBadge presentation={stagePresentation(status)} prefix="Stage status" className={className} />;
}
