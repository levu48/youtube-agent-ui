"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, UserCheck } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, type ApproveResult, type DraftView } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { approvalPresentation } from "@/lib/status";

const REVIEWER_KEY = "yta.reviewerName";
const MAX_REVIEWER = 200;
const MAX_COMMENT = 2000;

function rememberedReviewer(): string {
  try {
    return window.localStorage.getItem(REVIEWER_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberReviewer(name: string) {
  try {
    window.localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Storage may be unavailable (private window); the name is only a convenience.
  }
}

/** Why approval cannot be requested right now, or null if it can. Server checks again. */
export function approvalBlocker(d: DraftView): string | null {
  if (d.active_job_id) return "A draft job is running for this project. Wait for it to finish.";
  if (!d.draft_check) return "The engine check could not be run, so the draft cannot be approved.";
  if (!d.draft_check.ok)
    return "The engine refuses approval while the draft has errors. Fix the errors listed above first.";
  if (!d.review_token) return "The draft changed while it was being checked. Validate it again.";
  return null;
}

export function ApprovalPanel({
  projectId,
  draft,
  onValidate,
  validating,
}: {
  projectId: string;
  draft: DraftView;
  onValidate: () => void;
  validating: boolean;
}) {
  const qc = useQueryClient();
  const uid = useId();
  const reviewerRef = useRef<HTMLInputElement>(null);
  const [reviewer, setReviewer] = useState(rememberedReviewer);
  const [comment, setComment] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [mismatch, setMismatch] = useState(false);

  const check = draft.draft_check;
  const status = check?.approval_status;
  const record = draft.approval;
  const blocker = approvalBlocker(draft);

  const approve = useMutation({
    mutationFn: () =>
      api.approveDraft(projectId, {
        reviewer: reviewer.trim(),
        comment: comment.trim() || null,
        confirm: true,
        review_token: draft.review_token!,
      }),
    onSuccess: (res: ApproveResult) => {
      setConfirming(false);
      setFailure(null);
      setMismatch(!res.approved_version_matches);
      rememberReviewer(reviewer.trim());
      qc.setQueryData<DraftView>(qk.draft(projectId), (old) =>
        old
          ? {
              ...old,
              draft_check: res.draft_check,
              draft_check_error: res.draft_check_error,
              review_token: res.review_token,
              approval: res.approval,
            }
          : old,
      );
      qc.setQueryData(qk.projectStatus(projectId), res.status);
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: qk.draft(projectId) });
      const now = res.draft_check?.approval_status;
      if (now === "approved") {
        toast.success(res.already_approved ? "The draft was already approved" : "Editorial draft approved (G1)");
      } else {
        toast.warning("The engine did not report the draft as approved. See the approval panel.");
      }
    },
    onError: (e) => {
      setConfirming(false);
      setFailure(e instanceof ApiError ? e : new ApiError(0, "error", (e as Error).message));
    },
  });

  const requestApproval = () => {
    const name = reviewer.trim();
    if (!name) {
      setFieldError("Enter the reviewer's name.");
      reviewerRef.current?.focus();
      return;
    }
    if (name.length > MAX_REVIEWER) {
      setFieldError(`Use at most ${MAX_REVIEWER} characters.`);
      reviewerRef.current?.focus();
      return;
    }
    setFieldError(null);
    setFailure(null);
    setConfirming(true);
  };

  const ids = { reviewer: `${uid}-reviewer`, comment: `${uid}-comment`, help: `${uid}-help`, err: `${uid}-err` };
  const showForm = status !== "approved";
  const failureErrors = Array.isArray(failure?.details?.errors) ? (failure.details.errors as string[]) : [];

  return (
    <section aria-labelledby="approval-title" className="space-y-4 rounded-[var(--radius-card)] border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="approval-title" className="flex items-center gap-2 text-lg font-semibold">
          <UserCheck aria-hidden className="size-5" /> Editorial approval (G1)
        </h2>
        <StatusBadge presentation={approvalPresentation(status)} prefix="Engine approval status" />
      </div>

      {/* Engine-recorded approval, current or stale. */}
      {record && (status === "approved" || status === "stale") ? (
        <div
          className={
            status === "approved"
              ? "rounded-lg border border-green-200 bg-green-50 p-3 text-sm"
              : "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
          }
        >
          <p className="font-medium">
            {status === "approved" ? (
              <CheckCircle2 aria-hidden className="mr-1 inline size-4 text-success" />
            ) : (
              <AlertTriangle aria-hidden className="mr-1 inline size-4 text-warning" />
            )}
            {status === "approved" ? "Approved" : "Previously approved"} by {record.reviewer ?? "unknown"}
            {record.approved_at ? ` on ${formatDateTime(record.approved_at)}` : ""}.
          </p>
          {record.comment ? <p className="mt-1 whitespace-pre-wrap">Comment: {record.comment}</p> : null}
          {status === "stale" ? (
            <p className="mt-1">
              This approval is out of date: the engine reports that{" "}
              {check?.approval_changed?.length ? check.approval_changed.join(", ") : "a reviewed file"} changed after it
              was approved. Review the draft and approve it again.
            </p>
          ) : (
            <p className="mt-1 text-slate-700">
              Any later change to the input, outline, script or storyboard makes this approval out of date.
            </p>
          )}
        </div>
      ) : null}

      {mismatch ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <strong>Check the approved version.</strong> A file changed between your validation and the engine&apos;s
          approval, so the engine approved a slightly different version than the one you checked. Review the draft
          again.
        </div>
      ) : null}

      {showForm ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            requestApproval();
          }}
          className="space-y-4"
        >
          <p id={ids.help} className="text-sm text-slate-700">
            Approval records that a named reviewer accepts this draft editorially. The engine records it and binds it to
            the exact current files. It does not verify historical claims, rights or release readiness, and it does not
            start any other stage.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.reviewer} className="text-sm font-medium">
                Reviewer name
                <span className="text-danger" aria-hidden>
                  {" "}
                  *
                </span>
              </Label>
              <Input
                id={ids.reviewer}
                ref={reviewerRef}
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                maxLength={MAX_REVIEWER}
                autoComplete="name"
                required
                aria-required
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? ids.err : undefined}
              />
              {fieldError ? (
                <p id={ids.err} className="text-sm text-danger">
                  {fieldError}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.comment} className="text-sm font-medium">
                Comment <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id={ids.comment}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={MAX_COMMENT}
                rows={2}
              />
            </div>
          </div>

          {blocker ? (
            <p className="flex items-start gap-1.5 text-sm text-warning" id={`${uid}-blocker`}>
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {blocker}
            </p>
          ) : null}

          {failure ? (
            <div role="alert" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
              <p className="font-medium">{failure.message}</p>
              {failureErrors.length ? (
                <ul className="list-disc pl-5">
                  {failureErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
              {failure.code === "draft_changed" ? (
                <Button type="button" variant="outline" size="sm" onClick={onValidate} disabled={validating}>
                  <RefreshCw aria-hidden /> Load the latest draft
                </Button>
              ) : null}
            </div>
          ) : null}

          <Button
            type="submit"
            size="lg"
            disabled={Boolean(blocker) || approve.isPending}
            aria-describedby={blocker ? `${uid}-blocker` : ids.help}
          >
            <ShieldCheck aria-hidden />
            {approve.isPending ? "Approving…" : "Approve Editorial Draft (G1)"}
          </Button>
        </form>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => !approve.isPending && setConfirming(o)}
        title="Approve this editorial draft (G1)?"
        description={
          <>
            You are recording that <strong>{reviewer.trim()}</strong> accepts this draft editorially. This does{" "}
            <strong>not</strong> verify historical claims, rights or release readiness.
          </>
        }
        confirmLabel={approve.isPending ? "Approving…" : "Approve draft"}
        cancelLabel="Go back"
        pending={approve.isPending}
        onConfirm={() => approve.mutate()}
      >
        {check?.review_blockers.length ? (
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">
              These {check.review_blockers.length} item(s) still need human review and will be recorded with the
              approval:
            </p>
            {/* Focusable so keyboard users can scroll a long list. */}
            <ul
              tabIndex={0}
              aria-label="Items still needing human review"
              className="max-h-48 list-disc space-y-1 overflow-auto rounded pl-5 focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:outline-none"
            >
              {check.review_blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
