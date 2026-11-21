import { ArrowRight, Compass } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Job, StatusSummary } from "@/lib/api";
import { nextAction } from "@/lib/status";

export function NextActionPanel({
  projectId,
  status,
  activeJob,
  draftAvailable,
}: {
  projectId: string;
  status: StatusSummary | undefined;
  activeJob: Job | null | undefined;
  draftAvailable: boolean;
}) {
  const a = nextAction(status, activeJob);
  return (
    <section
      aria-labelledby="next-action-title"
      className="rounded-[var(--radius-panel)] border border-blue-200 bg-blue-50/60 p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-blue-800 uppercase">
            <Compass aria-hidden className="size-4" /> Next action
          </p>
          <h2 id="next-action-title" className="text-xl font-semibold">
            {a.title}
          </h2>
          <p className="max-w-prose text-sm text-slate-700">{a.description}</p>
          {a.engineHint ? (
            <p className="text-xs text-muted-foreground">
              Engine suggests: <code className="rounded bg-white px-1 py-0.5 break-all">{a.engineHint}</code>
            </p>
          ) : null}
        </div>
        {a.kind === "review_draft" && draftAvailable ? (
          <Button asChild size="lg">
            <Link href={`/projects/${encodeURIComponent(projectId)}/draft`}>
              View Draft <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : a.kind === "generate_draft" ? (
          <Button asChild size="lg">
            <a href="#generate-draft">
              Generate Draft <ArrowRight aria-hidden />
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
