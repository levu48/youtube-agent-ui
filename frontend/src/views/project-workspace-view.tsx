"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, ImageIcon, Search, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { DraftPanel } from "@/components/draft-panel";
import { JobCard } from "@/components/job-card";
import { NextActionPanel } from "@/components/next-action-panel";
import { PageHeader } from "@/components/page-header";
import { ProjectStageStepper } from "@/components/project-stage-stepper";
import { RecentJobs } from "@/components/recent-jobs";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api } from "@/lib/api";
import { formatDuration, languageName } from "@/lib/format";
import { qk } from "@/lib/queries";
import { JOB_STATUS, stageSummary } from "@/lib/status";

export function ProjectWorkspaceView() {
  const { projectId } = useParams<{ projectId: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => api.project(projectId) });
  const status = useQuery({
    queryKey: qk.projectStatus(projectId),
    queryFn: () => api.projectStatus(projectId),
    enabled: project.isSuccess,
  });
  const draftAvail = useQuery({
    queryKey: qk.draftAvailable(projectId),
    queryFn: () => api.draftAvailable(projectId),
    enabled: project.isSuccess,
  });
  const jobs = useQuery({
    queryKey: qk.jobs(projectId),
    queryFn: () => api.jobs({ projectId, limit: 8 }),
    enabled: project.isSuccess,
  });

  if (project.isLoading) return <LoadingSkeleton rows={3} label="Loading project" />;
  if (project.isError) {
    const e = project.error;
    if (e instanceof ApiError && e.status === 404) {
      return (
        <EmptyState
          title="Project not found"
          description="This project is not registered in the studio."
          action={
            <Button asChild>
              <Link href="/">Back to Dashboard</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState title="Cannot load the project" message={(e as Error).message} onRetry={() => project.refetch()} />;
  }
  const p = project.data!;
  const active = p.active_job;
  const selectedJobId = search.get("job") ?? active?.id ?? jobs.data?.[0]?.id ?? null;
  const draftExists = !!draftAvail.data?.available;
  const lastJob = jobs.data?.[0];

  return (
    <>
      <PageHeader
        title={p.display_name}
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: p.display_name }]}
        actions={
          draftExists ? (
            <>
              <Button asChild variant="outline" size="lg">
                <Link href={`/projects/${encodeURIComponent(p.id)}/draft`}>
                  <BookOpen aria-hidden /> Edit Draft
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link href={`/projects/${encodeURIComponent(p.id)}/research`}>
                  <Search aria-hidden /> Research
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link href={`/projects/${encodeURIComponent(p.id)}/visuals`}>
                  <ImageIcon aria-hidden /> Visuals
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <dl className="-mt-3 mb-6 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Language</dt>
          <dd className="font-medium">{languageName(p.language)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="font-medium">{formatDuration(p.duration_seconds)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="font-mono font-medium">{p.slug}</dd>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Location</dt>
          <dd className="font-mono break-all">{p.location}</dd>
        </div>
      </dl>
      {p.input_error ? (
        <ErrorState className="mb-6" title="Project input could not be read" message={p.input_error} />
      ) : null}

      <div className="space-y-6">
        <section aria-labelledby="stage-title" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="stage-title" className="text-xl font-semibold">
              Production stages
            </h2>
            {/* Stage state (engine) and job state (UI process) are labelled separately. */}
            <p className="text-sm text-muted-foreground">
              Engine stage: <span className="font-medium text-foreground">{status.isLoading ? "Loading…" : stageSummary(status.data)}</span>
              {lastJob ? (
                <>
                  {" "}
                  · Last draft job:{" "}
                  <span className="font-medium text-foreground">{JOB_STATUS[lastJob.status].label.toLowerCase()}</span>
                </>
              ) : null}
            </p>
          </div>
          {status.isLoading ? <LoadingSkeleton rows={1} label="Loading engine status" /> : <ProjectStageStepper status={status.data} />}
          {status.isError ? (
            <ErrorState title="Engine status unavailable" message={(status.error as Error).message} onRetry={() => status.refetch()} />
          ) : null}
        </section>

        <NextActionPanel projectId={p.id} status={status.data} activeJob={active} draftAvailable={draftExists} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-6">
            {selectedJobId ? (
              <JobCard key={selectedJobId} jobId={selectedJobId} title={active?.id === selectedJobId ? "Active job" : "Draft job"} />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Jobs</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  No jobs yet. Start one with Generate Draft. Logs from the engine appear here.
                </CardContent>
              </Card>
            )}
            {draftExists ? <DraftCheckSummary projectId={p.id} /> : null}
          </div>
          <div className="min-w-0 space-y-6">
            <DraftPanel
              projectId={p.id}
              hasActiveJob={!!active}
              draftExists={draftExists}
              onStarted={(jobId) => router.replace(`/projects/${encodeURIComponent(p.id)}?job=${jobId}`, { scroll: false })}
            />
            <RecentJobs projectId={p.id} selectedId={selectedJobId} />
          </div>
        </div>
      </div>
    </>
  );
}

function DraftCheckSummary({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: [...qk.project(projectId), "draft-check"],
    queryFn: () => api.draftCheck(projectId),
  });
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-lg">Draft check</CardTitle>
        {q.data ? (
          <StatusBadge
            presentation={
              q.data.ok
                ? { label: "Checks passed", tone: "success", icon: CheckCircle2 }
                : { label: "Checks failed", tone: "danger", icon: XCircle }
            }
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading ? (
          <p className="text-muted-foreground">Running draft-check…</p>
        ) : q.isError ? (
          <p className="text-warning">{(q.error as Error).message}</p>
        ) : q.data ? (
          <>
            <p>
              {q.data.errors.length} error(s), {q.data.warnings.length} warning(s), {q.data.review_blockers.length} item(s)
              needing human review. Approval: <strong>{q.data.approval_status.replace(/_/g, " ")}</strong>.
            </p>
            <Link href={`/projects/${encodeURIComponent(projectId)}/draft`} className="font-medium text-primary hover:underline">
              Read the draft and full validation
            </Link>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
