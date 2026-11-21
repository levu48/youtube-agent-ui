"use client";

import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { JobLogViewer } from "@/components/job-log-viewer";
import { ErrorState } from "@/components/states";
import { JobStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useJobEvents, type CompletionInfo } from "@/hooks/use-job-events";
import { ApiError, api, isTerminal, type Job, type JobStatus } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { JOB_STATUS } from "@/lib/status";

export function JobActions({
  job,
  status,
  cancelRequested,
}: {
  job: Job;
  status: JobStatus;
  cancelRequested: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(job.id),
    onSuccess: (j) => {
      setOpen(false);
      qc.setQueryData(qk.job(job.id), (old: unknown) => (old ? { ...(old as object), ...j } : old));
      if (j.status === "cancelled") toast.success("Job cancelled");
    },
    onError: (e) => {
      setOpen(false);
      toast.error(e instanceof ApiError ? e.message : "Could not cancel the job");
    },
  });
  if (isTerminal(status)) return null;
  const cancelling = cancelRequested || cancel.isPending;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={cancelling}>
        <Square aria-hidden />
        {cancelling ? "Cancelling…" : "Cancel job"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Stop this draft generation?"
        description="The engine process will be interrupted. Files already published by the engine stay as they are, and you can start a new draft later."
        confirmLabel="Stop generation"
        destructive
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </>
  );
}

/** Refetch the job and invalidate every query derived from its project. */
export async function refreshAfterJob(qc: QueryClient, jobId: string) {
  const job = await qc.fetchQuery({ queryKey: qk.job(jobId), queryFn: () => api.job(jobId, 1), staleTime: 0 });
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.project(job.project_id) }),
    qc.invalidateQueries({ queryKey: ["jobs"] }),
    qc.invalidateQueries({ queryKey: qk.projects }),
  ]);
  return job;
}

/** Status, real logs and actions for one job; survives refresh (state comes from the API). */
export function JobCard({ jobId, title = "Draft job" }: { jobId: string; title?: string }) {
  const qc = useQueryClient();
  const jobQ = useQuery({ queryKey: qk.job(jobId), queryFn: () => api.job(jobId, 1) });
  const [announcement, setAnnouncement] = useState("");

  // One idempotent handler for both "already finished at load" and "finished while
  // watching": refresh everything derived from the job (project status, draft availability,
  // job lists). Only a completion observed live is announced to screen readers.
  const onCompleted = useCallback(
    async (info: CompletionInfo) => {
      const job = await refreshAfterJob(qc, jobId);
      if (info.live) setAnnouncement(`Draft job ${JOB_STATUS[job.status].label.toLowerCase()}.`);
    },
    [jobId, qc],
  );

  const live = useJobEvents(jobId, onCompleted);
  const job = jobQ.data;

  if (jobQ.isError) {
    return <ErrorState title="Cannot load this job" message={(jobQ.error as Error).message} onRetry={() => jobQ.refetch()} />;
  }
  if (!job) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">Loading job…</CardContent>
      </Card>
    );
  }
  // Prefer the latest real lifecycle event; fall back to the persisted job record.
  const status = (live.status ?? job.status) as JobStatus;
  const cancelRequested = live.cancelRequested || job.cancel_requested;
  const terminal = isTerminal(status);
  const final = terminal && isTerminal(job.status) ? job : null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-lg">{title}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {job.provider === "fixture" ? "Offline fixture provider" : `Ollama · ${job.model ?? "default model"}`}
            {job.from_stage ? ` · from ${job.from_stage}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <JobStatusBadge status={status} cancelling={cancelRequested} />
          <JobActions job={job} status={status} cancelRequested={cancelRequested} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Queued</dt>
            <dd>{formatDateTime(job.created_at)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{job.started_at ? formatDateTime(job.started_at) : status === "queued" ? "Waiting" : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>{final?.finished_at ? formatDateTime(final.finished_at) : "—"}</dd>
          </div>
        </dl>
        {final ? <JobOutcome job={final} /> : null}
        {live.error ? <p className="text-sm text-warning">{live.error}</p> : null}
        <JobLogViewer events={live.events} connection={live.connection} />
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </CardContent>
    </Card>
  );
}

function JobOutcome({ job }: { job: Job }) {
  const exit = job.exit_code == null ? null : `Engine exit code ${job.exit_code}`;
  if (job.status === "succeeded" && job.error_code === "human_gate") {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
        The engine stopped at a human review gate. {job.error_message}
      </p>
    );
  }
  if (job.status === "succeeded") {
    return <p className="text-sm text-success">{job.message}. {exit}.</p>;
  }
  const tone =
    job.status === "failed" ? "border-red-200 bg-red-50 text-danger" : "border-amber-200 bg-amber-50 text-warning";
  return (
    <div className={`space-y-1 rounded-lg border p-3 text-sm ${tone}`}>
      <p className="font-medium">{job.message}</p>
      {job.error_message ? <p className="break-words">{job.error_message}</p> : null}
      {exit ? <p className="text-xs opacity-80">{exit}</p> : null}
    </div>
  );
}
