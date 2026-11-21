"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { ErrorState } from "@/components/states";
import { JobStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Job } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";

export function RecentJobs({
  projectId,
  selectedId,
  limit = 8,
  showProject,
}: {
  projectId?: string;
  selectedId?: string | null;
  limit?: number;
  showProject?: boolean;
}) {
  const q = useQuery({
    queryKey: qk.jobs(projectId),
    queryFn: () => api.jobs({ projectId, limit }),
    refetchInterval: (query) =>
      (query.state.data as Job[] | undefined)?.some((j) => j.status === "running" || j.status === "queued")
        ? 4000
        : false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Recent jobs</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading jobs…</p>
        ) : q.isError ? (
          <ErrorState title="Cannot load jobs" message={(q.error as Error).message} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <ul className="divide-y">
            {q.data.map((j) => (
              <li
                key={j.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-2 py-2.5",
                  selectedId === j.id && "-ml-3 border-l-4 border-l-primary pl-2",
                )}
              >
                <div className="min-w-0 space-y-0.5">
                  <JobStatusBadge status={j.status} cancelling={j.cancel_requested} />
                  <p className="text-sm text-muted-foreground">
                    {showProject ? <span className="font-medium text-foreground">{j.project_id} · </span> : null}
                    {j.type} · {formatRelative(j.started_at ?? j.created_at)}
                  </p>
                </div>
                <Link
                  href={`/projects/${encodeURIComponent(j.project_id)}?job=${j.id}`}
                  className="rounded text-sm font-medium text-primary hover:underline"
                  aria-current={selectedId === j.id ? "true" : undefined}
                >
                  View logs<span className="sr-only"> for {j.type} job started {formatRelative(j.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
