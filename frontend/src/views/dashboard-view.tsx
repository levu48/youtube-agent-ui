"use client";

import { Plus } from "lucide-react";
import Link from "next/link";

import { EngineHealthBadge, OllamaHealthBadge } from "@/components/health-badges";
import { PageHeader } from "@/components/page-header";
import { RecentJobs } from "@/components/recent-jobs";
import { Button } from "@/components/ui/button";
import { useEngine } from "@/lib/queries";
import { DiscoverableProjects, ProjectGrid } from "@/views/project-list";

export function EngineAlert() {
  const engine = useEngine();
  const offline = engine.isError;
  if (engine.isLoading || (engine.data?.available && !offline)) return null;
  return (
    <div role="alert" className="space-y-2 rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 p-4 text-sm">
      <p className="font-semibold text-warning">
        {offline ? "The local backend is not responding" : "The youtube-agent engine is unavailable"}
      </p>
      <p className="text-slate-800">
        {offline
          ? "Start it with ./scripts/dev.sh from the youtube-agent-ui folder."
          : engine.data?.reason}
      </p>
      {!offline ? (
        <p className="text-slate-700">
          Check <code>YTA_ENGINE_REPO</code> in <code>.env</code> (currently {engine.data?.repo}) and run{" "}
          <code>uv sync</code> in the engine repository once.
        </p>
      ) : null}
      <Button variant="outline" size="sm" className="bg-white" onClick={() => engine.refetch()} disabled={engine.isFetching}>
        {engine.isFetching ? "Checking…" : "Retry connection"}
      </Button>
    </div>
  );
}

export function DashboardView() {
  return (
    <>
      <PageHeader
        title="My Projects"
        subtitle="Documentary production workspace"
        actions={
          <Button asChild size="lg">
            <Link href="/projects/new">
              <Plus aria-hidden /> New Project
            </Link>
          </Button>
        }
      />
      <div className="space-y-6">
        <section aria-label="Local services" className="flex flex-wrap items-center gap-2">
          <EngineHealthBadge />
          <OllamaHealthBadge />
        </section>
        <EngineAlert />
        <DiscoverableProjects />
        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <section aria-labelledby="projects-heading" className="min-w-0 space-y-3">
            <h2 id="projects-heading" className="text-xl font-semibold">
              Projects
            </h2>
            <ProjectGrid />
          </section>
          <aside aria-label="Recent jobs" className="min-w-0">
            <RecentJobs showProject limit={8} />
          </aside>
        </div>
      </div>
    </>
  );
}
