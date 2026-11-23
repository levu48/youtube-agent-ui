"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileOutput, ListChecks, ShieldCheck, Workflow } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditError } from "@/components/research/edit-error";
import { LineField, REVIEWER_HINT, TextField } from "@/components/research/fields";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api, type ResearchExportResult, type ResearchView } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { RESEARCH_APPROVAL, gatePresentation } from "@/lib/status";

const MEANING =
  "A named reviewer's audit attestation that the recorded evidence was reviewed for these exact claims and narration. It is not a " +
  "guarantee of historical truth, not a cryptographic signature, and not permission to publish.";

/** One validation: the engine's check at `revision`. `spent` once the loaded research changed
 * afterwards, even if it later returns to the same revision: then it never counts again. */
type Validated = { projectId: string; revision: string; at: Date; approvable: boolean; spent: boolean };

/**
 * Gate G2 and what follows it, each step one explicit engine command (engine D-85/D-118):
 * validate (research-check), approve with the revision that was validated (research-approve
 * --expect-revision), apply the approved claim IDs to the scenes (research-apply, which makes G1
 * out of date), and export (research-export). The engine decides every step; this panel only
 * shows what it reports and never infers an approval.
 */
export function G2Panel({ projectId, view, disabled }: { projectId: string; view: ResearchView; disabled: string | null }) {
  const qc = useQueryClient();
  const report = view.report;
  const [validated, setValidated] = useState<Validated | null>(null);
  const [validating, setValidating] = useState(false);
  const attempt = useRef(0); // only the latest validation attempt may record its result
  // The revision the approval dialog was opened for; it never changes while the dialog is open.
  const [approveFor, setApproveFor] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  // The latest export attempt's result, for the revision it ran at; cleared when a new one starts.
  const [exported, setExported] = useState<{ revision: string | null; result: ResearchExportResult } | null>(null);

  // Every update of this project's research in the cache (a refresh, an edit, a job's result)
  // spends a validation made for another revision. Subscribing sees each update, even ones
  // that land in the same render.
  useEffect(() => {
    const key = JSON.stringify(qk.research(projectId));
    return qc.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "success" || JSON.stringify(e.query.queryKey) !== key) return;
      const revision = (e.query.state.data as ResearchView | undefined)?.revision ?? null;
      setValidated((v) => (v && !v.spent && v.revision !== revision ? { ...v, spent: true } : v));
    });
  }, [qc, projectId]);
  const loaded = qc.getQueryData<ResearchView>(qk.research(projectId))?.revision ?? view.revision ?? "";

  const done = (r: { research: ResearchView }) => {
    qc.setQueryData(qk.research(projectId), r.research);
    // G1 and the project's next step can change (apply makes G1 out of date).
    void qc.invalidateQueries({ queryKey: qk.projectStatus(projectId) });
    void qc.invalidateQueries({ queryKey: qk.draft(projectId) });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const apply = useMutation({
    mutationFn: () => api.researchApply(projectId, view.revision!),
    onSuccess: (r) => {
      done(r);
      setApplyOpen(false);
      toast.success(r.result.status === "already_current" ? "Claim IDs were already applied" : `Claim IDs applied to ${r.result.scenes_changed.length} scene(s)`);
    },
  });
  const exp = useMutation({
    mutationFn: () => api.researchExport(projectId, view.revision!),
    onMutate: () => setExported(null), // a failed attempt never shows an earlier success
    onSuccess: (r) => {
      done(r);
      setExported({ revision: r.research.revision, result: r.result });
      toast.success(r.result.written.length ? "Research records exported" : "Research records already up to date");
    },
  });

  if (!report) return null;
  const status = report.approval_status;
  const current = validated && !validated.spent && validated.projectId === projectId && validated.revision === loaded ? validated : null;
  const exportShown = exported && exported.revision === loaded ? exported.result : null;
  const g1 = view.gates?.g1 ?? null;
  const g2 = view.gates?.g2 ?? null;

  /** Runs the engine's check now. The result counts only if it is still the latest attempt
   * and nothing else changed the loaded research while it ran (an edit, a job, a refresh);
   * otherwise the reviewer is asked to validate again. */
  const validate = async () => {
    const n = ++attempt.current;
    const key = qk.research(projectId);
    const before = qc.getQueryData<ResearchView>(key)?.revision ?? null;
    setValidating(true);
    try {
      const fresh = await api.research(projectId);
      if (n !== attempt.current) return;
      const record = (revision: string, approvable: boolean, spent: boolean) =>
        setValidated({ projectId, revision, at: new Date(), approvable, spent });
      if (!fresh.revision || !fresh.report) {
        setValidated(null);
      } else if ((qc.getQueryData<ResearchView>(key)?.revision ?? null) !== before) {
        record(fresh.revision, false, true); // the research changed while the check ran
      } else {
        qc.setQueryData(key, fresh);
        record(fresh.revision, fresh.report.approvable, false);
      }
    } catch {
      if (n !== attempt.current) return;
      setValidated(null);
      toast.error("The engine's research check could not be run.");
    } finally {
      if (n === attempt.current) setValidating(false);
    }
  };

  return (
    <section aria-labelledby="g2-h" className="space-y-4 rounded-lg border p-4">
      <h3 id="g2-h" className="flex items-center gap-1.5 text-sm font-semibold">
        <ShieldCheck aria-hidden className="size-4" /> Research approval (G2), apply and export
      </h3>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">G2 (research-check)</dt>
        <dd>
          <StatusBadge presentation={RESEARCH_APPROVAL[status] ?? gatePresentation(status)} />
          {status === "approved" ? <span className="ml-2">{report.applied ? "Claim IDs applied to the scenes" : "Claim IDs not applied yet"}</span> : null}
        </dd>
        <dt className="text-muted-foreground">G2 (production status)</dt>
        <dd>
          <StatusBadge presentation={gatePresentation(g2)} />
        </dd>
        <dt className="text-muted-foreground">G1 editorial</dt>
        <dd>
          <StatusBadge presentation={gatePresentation(g1)} />
        </dd>
      </dl>
      {status === "stale" ? (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-warning">
          The G2 approval is out of date: the research or the narration changed after it was recorded. Validate and approve again.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Nothing here runs automatically, and nothing advances to visuals.</p>

      {status !== "approved" ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">1. Validate, then approve</h4>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={validate} disabled={validating || Boolean(disabled)}>
              <ListChecks aria-hidden /> {validating ? "Validating…" : "Validate research"}
            </Button>
            <Button size="sm" onClick={() => current && setApproveFor(current.revision)} disabled={!current?.approvable || Boolean(disabled)}>
              <ShieldCheck aria-hidden /> Approve research (G2)…
            </Button>
          </div>
          <p className="text-sm" aria-live="polite">
            {current
              ? current.approvable
                ? `Validated at ${formatDateTime(current.at.toISOString())}: the engine reports the research is approvable.`
                : `Validated at ${formatDateTime(current.at.toISOString())}: not approvable. Resolve the blocking items above, then validate again.`
              : validated
                ? "The research changed since you validated it: validate again before approving."
                : "Validate to run the engine's check now. Approval uses the exact revision you validated."}
          </p>
          {disabled ? <p className="text-xs text-muted-foreground">{disabled}</p> : null}
        </div>
      ) : null}

      {status === "approved" && !report.applied ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">2. Apply claim IDs to the scenes</h4>
          <Button size="sm" onClick={() => setApplyOpen(true)} disabled={Boolean(disabled) || !view.revision}>
            <Workflow aria-hidden /> Apply claim IDs to scenes…
          </Button>
          <ConfirmDialog
            open={applyOpen}
            onOpenChange={setApplyOpen}
            title="Apply claim IDs to the scenes?"
            description="The engine writes the approved claim IDs into the storyboard's scenes; nothing else in the draft changes. The editorial approval (G1) then goes out of date, and the draft must be approved again before it moves on."
            confirmLabel="Apply claim IDs"
            cancelLabel="Not now"
            pending={apply.isPending}
            onConfirm={() => apply.mutate()}
          >
            <EditError error={applyOpen ? apply.error : null} onReload={() => qc.invalidateQueries({ queryKey: qk.research(projectId) })} />
          </ConfirmDialog>
        </div>
      ) : null}

      {status === "approved" && report.applied ? (
        <div className="space-y-2">
          {g1 && g1 !== "approved" ? (
            <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-warning">
              G1 is out of date after apply.{" "}
              <Link href={`/projects/${encodeURIComponent(projectId)}/draft`} className="font-medium underline">
                Approve the draft again
              </Link>{" "}
              in its Validation tab.
            </p>
          ) : null}
          <h4 className="text-sm font-medium">3. Export the research records</h4>
          <p className="text-xs text-muted-foreground">
            Writes sources.md, the citation plan and the research report. These are research records, not publication clearance. The
            engine never overwrites a file you edited by hand.
          </p>
          <Button size="sm" variant="outline" onClick={() => exp.mutate()} disabled={exp.isPending || Boolean(disabled) || !view.revision}>
            <FileOutput aria-hidden /> {exp.isPending ? "Exporting…" : "Export research records"}
          </Button>
          <div aria-live="polite" className="space-y-1 text-sm">
            {exp.isPending ? <p className="text-muted-foreground">Exporting: the engine is writing the records…</p> : null}
            {exp.isError ? (
              <div className="space-y-1">
                <p className="font-medium text-danger">Export failed: nothing was overwritten.</p>
                <EditError error={exp.error} onReload={() => qc.invalidateQueries({ queryKey: qk.research(projectId) })} />
              </div>
            ) : null}
            {exportShown ? (
              <div className="space-y-1">
                <p className="font-medium text-success">
                  {exportShown.written.length ? `Exported: ${exportShown.written.length} file(s) written.` : "Exported: every file was already up to date."}
                </p>
                <ExportList label="Written" paths={exportShown.written} />
                <ExportList label="Unchanged" paths={exportShown.unchanged} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Bound to the revision it was opened for, for as long as it is open. If the research
          changes meanwhile, it says so and offers no approval; the input is kept. */}
      {approveFor ? (
        <ApproveDialog
          projectId={projectId}
          revision={approveFor}
          changed={approveFor !== loaded}
          onClose={() => setApproveFor(null)}
          onDone={(r) => {
            done(r);
            setApproveFor(null);
            setValidated(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ExportList({ label, paths }: { label: string; paths: string[] }) {
  if (!paths.length) return null;
  return (
    <div>
      <p>{label}:</p>
      <ul className="ml-4 list-disc">
        {paths.map((p) => (
          <li key={p}>
            <code className="text-xs">{p}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApproveDialog({
  projectId,
  revision,
  changed,
  onClose,
  onDone,
}: {
  projectId: string;
  revision: string;
  changed: boolean;
  onClose: () => void;
  onDone: (r: { research: ResearchView }) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [attest, setAttest] = useState(false);
  const m = useMutation({
    mutationFn: () => api.researchApprove(projectId, { expected_revision: revision, reviewer: reviewer.trim(), ...(comment.trim() ? { comment: comment.trim() } : {}), confirm: true }),
    onSuccess: (r) => {
      onDone(r);
      toast.success(r.result.status === "already_approved" ? "The research was already approved" : `Research approved by ${r.result.approval.reviewer}`);
    },
  });
  const items =
    m.error instanceof ApiError && m.error.code === "not_approvable" && Array.isArray(m.error.details?.items)
      ? (m.error.details.items as { code: string; detail: string }[])
      : [];
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Approve the research (G2)?</DialogTitle>
          <DialogDescription>
            You approve the research exactly as you validated it. If anything changed since, from this page, the CLI or a job, the engine
            refuses and nothing is recorded.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded border bg-surface-muted/50 p-2 text-sm">{MEANING}</p>
        <LineField label="Reviewer" value={reviewer} onChange={setReviewer} required hint={REVIEWER_HINT} />
        <TextField label="Comment (optional)" value={comment} onChange={setComment} rows={2} max={2000} />
        <label htmlFor={`${id}-attest`} className="flex items-start gap-2 text-sm">
          <input id={`${id}-attest`} type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-1" />
          I reviewed every claim, its evidence and its decision myself.
        </label>
        {items.length ? (
          <ul className="space-y-1 text-sm">
            {items.map((i, n) => (
              <li key={n} className="rounded border border-red-200 bg-red-50/60 px-2 py-1">
                <code className="text-xs">{i.code}</code> {i.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {changed ? (
          <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-warning">
            The research changed after you validated it, so this approval would not cover it. Close this dialog, validate again, then
            approve.
          </p>
        ) : null}
        <EditError error={m.error} onReload={() => qc.invalidateQueries({ queryKey: qk.research(projectId) })} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={!reviewer.trim() || !attest || m.isPending || changed}>
            {m.isPending ? "Approving…" : "Approve research"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
