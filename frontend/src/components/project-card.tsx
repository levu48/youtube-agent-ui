import { Clock, Languages, Loader2 } from "lucide-react";
import Link from "next/link";

import { StageStatusBadge } from "@/components/status-badge";
import type { ProjectSummary } from "@/lib/api";
import { formatDuration, formatRelative, languageName } from "@/lib/format";
import { nextAction, stageName } from "@/lib/status";

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const cur = project.status.available ? project.status.current_stage : null;
  const action = nextAction(project.status, project.active_job);
  const active = project.active_job;
  return (
    <article className="relative flex h-full flex-col gap-3 rounded-[var(--radius-card)] border bg-surface p-5 transition-colors focus-within:ring-2 focus-within:ring-focus hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-lg leading-snug font-semibold">
          <Link
            href={`/projects/${encodeURIComponent(project.id)}`}
            className="outline-none after:absolute after:inset-0 after:rounded-[var(--radius-card)] hover:underline"
          >
            {project.display_name}
          </Link>
        </h2>
        {active ? (
          <span className="relative inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
            <Loader2 aria-hidden className="size-3 motion-safe:animate-spin" />
            {active.status === "queued" ? "Job queued" : "Job running"}
          </span>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">{project.slug}</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <dt>
            <Languages aria-hidden className="size-4" />
            <span className="sr-only">Language</span>
          </dt>
          <dd>{languageName(project.language)}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>
            <Clock aria-hidden className="size-4" />
            <span className="sr-only">Target duration</span>
          </dt>
          <dd>{formatDuration(project.duration_seconds)}</dd>
        </div>
      </dl>
      <div className="mt-auto space-y-2 border-t pt-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Stage:</span>
          {cur ? (
            <>
              <span className="font-medium">{stageName(cur.stage)}</span>
              <StageStatusBadge status={cur.status} />
            </>
          ) : (
            <span className="text-warning">Status unavailable</span>
          )}
        </div>
        <p>
          <span className="text-muted-foreground">Next: </span>
          {action.title}
        </p>
        <p className="text-xs text-muted-foreground">Last activity {formatRelative(project.last_activity)}</p>
      </div>
    </article>
  );
}
