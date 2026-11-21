"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, FolderSearch } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ProjectCard } from "@/components/project-card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { qk } from "@/lib/queries";

export function ProjectGrid() {
  const q = useQuery({
    queryKey: qk.projects,
    queryFn: api.projects,
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.active_job) ? 5000 : false,
  });

  if (q.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LoadingSkeleton rows={1} className="[&>div]:h-52" label="Loading projects" />
        <LoadingSkeleton rows={1} className="hidden md:block [&>div]:h-52" />
        <LoadingSkeleton rows={1} className="hidden xl:block [&>div]:h-52" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <ErrorState
        title="Projects could not be loaded"
        message={q.error instanceof ApiError ? q.error.message : String(q.error)}
        onRetry={() => q.refetch()}
      />
    );
  }
  const projects = q.data ?? [];
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderPlus}
        title="No projects yet"
        description="A project holds one documentary: its idea, draft, and later research, visuals and narration."
        action={
          <Button asChild size="lg">
            <Link href="/projects/new">Create your first project</Link>
          </Button>
        }
      />
    );
  }
  const unavailable = projects.filter((p) => !p.status.available).length;
  return (
    <div className="space-y-3">
      {unavailable > 0 ? (
        <p className="text-sm text-warning">
          Engine status could not be loaded for {unavailable} project{unavailable === 1 ? "" : "s"}; showing known
          details only.
        </p>
      ) : null}
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((p) => (
          <li key={p.id}>
            <ProjectCard project={p} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Existing engine projects in the projects folder that the UI has not registered. */
export function DiscoverableProjects() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.discoverable, queryFn: api.discoverable, retry: false });
  const reg = useMutation({
    mutationFn: (slug: string) => api.register(slug),
    onSuccess: (p) => {
      toast.success(`Registered ${p.slug}`);
      void qc.invalidateQueries({ queryKey: qk.discoverable });
      void qc.invalidateQueries({ queryKey: qk.projects });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not register"),
  });
  if (!q.data?.length) return null;
  return (
    <section aria-labelledby="discover-title" className="rounded-[var(--radius-card)] border bg-surface p-4">
      <h2 id="discover-title" className="mb-2 flex items-center gap-2 text-base font-semibold">
        <FolderSearch aria-hidden className="size-4" /> Existing engine projects found
      </h2>
      <ul className="divide-y">
        {q.data.map((d) => (
          <li key={d.slug} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>
              <span className="font-mono font-medium">{d.slug}</span>{" "}
              <span className="text-muted-foreground">{d.location}</span>
            </span>
            <Button size="sm" variant="outline" disabled={reg.isPending} onClick={() => reg.mutate(d.slug)}>
              Add to studio<span className="sr-only"> {d.slug}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
