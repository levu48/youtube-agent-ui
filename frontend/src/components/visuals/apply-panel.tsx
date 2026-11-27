"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { LineField, REVIEWER_HINT } from "@/components/research/fields";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NOT_CERTIFIED } from "@/components/visuals/gates-panel";
import { VisualsError } from "@/components/visuals/visuals-error";
import { ApiError, api, type VisualsApplyResult, type VisualsView } from "@/lib/api";
import { qk } from "@/lib/queries";
import { applyStatePresentation, humanize } from "@/lib/status";

interface SceneReport {
  scene_id: string;
  render_ready?: boolean;
  ready_via?: string | null;
  publication_blockers?: string[];
  next_action?: string;
}

const asText = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));

/** Validation and apply (M4-04). "Validate visuals" reads the engine's evaluation again and
 * records the revision it describes; apply is bound to that revision, so any later change, from
 * this page, the CLI or a job, spends the validation (the engine refuses `revision_mismatch`).
 * The page never decides readiness itself: everything shown is the engine's report. */
export function ApplyPanel({
  view,
  projectId,
  block,
  onValidate,
  validated,
  unsaved = [],
}: {
  view: VisualsView;
  projectId: string;
  block: string | null;
  onValidate: () => Promise<{ revision: string | null; error: string | null }>;
  validated: string | null;
  /** Scenes with an unsaved shot list: validation and apply only ever see the saved one. */
  unsaved?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [result, setResult] = useState<VisualsApplyResult | null>(null);
  const r = view.report;
  const scenes = (r.scenes as SceneReport[]) ?? [];
  const states = new Map(view.scenes.map((s) => [s.scene_id, s.apply_state]));
  const current = validated !== null && validated === view.revision;
  const errors = (r.errors ?? []).length;
  const nothing = !view.selection?.scenes.some((s) => s.shots?.length);
  const reason =
    block ??
    (checking
      ? "Validating…"
      : unsaved.length
        ? "Save or discard the unsaved shot changes first."
        : nothing
      ? "Nothing is selected yet."
      : !validated
        ? "Validate the visuals first."
        : !current
          ? "The visuals changed since you validated them: validate again."
          : errors
            ? "The engine reports errors: resolve them first."
            : null);
  const validate = async () => {
    setChecking(true);
    setFailed(null);
    try {
      const r = await onValidate();
      setFailed(r.error);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Validation failed.");
    } finally {
      setChecking(false);
    }
  };
  const list = (label: string, items: unknown[], tone: string) =>
    items.length ? (
      <section className="space-y-1">
        <h4 className="text-sm font-semibold">
          {label} ({items.length})
        </h4>
        <ul className="space-y-1 text-sm">
          {items.map((x, i) => (
            <li key={i} className={`rounded border px-2 py-1 break-words ${tone}`}>
              {asText(x)}
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void validate()} disabled={Boolean(block) || checking}>
          <ClipboardCheck aria-hidden /> {checking ? "Validating…" : "Validate visuals"}
        </Button>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={Boolean(reason)} aria-describedby="apply-reason">
          <CheckCheck aria-hidden /> Apply selection…
        </Button>
        <p id="apply-reason" className="text-xs text-muted-foreground">
          {reason ??
            `Validated at revision ${validated!.slice(0, 12)}: apply writes the selection into the draft's shots and assets.`}
        </p>
      </div>
      {unsaved.length ? (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-warning">
          Unsaved shot changes in {unsaved.join(", ")}. Validation and apply use only the saved selection: save or discard those
          changes in Scenes and candidates first.
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-danger">
          Validation failed: {failed} Nothing is validated; the report below may be out of date.
        </p>
      ) : null}
      {view.recovery_required ? <p className="text-sm text-danger">The report below is {NOT_CERTIFIED}.</p> : null}
      <p className="text-sm">
        Render ready (engine evaluation): <strong>{r.render_ready ? "yes" : "no"}</strong>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="sr-only">Readiness per scene, as the engine reports it</caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">Scene</th>
              <th scope="col" className="py-1 pr-2 font-medium">Ready</th>
              <th scope="col" className="py-1 pr-2 font-medium">Apply state</th>
              <th scope="col" className="py-1 font-medium">Engine</th>
            </tr>
          </thead>
          <tbody>
            {scenes.map((s) => (
              <tr key={s.scene_id} className="border-b align-top">
                <th scope="row" className="py-1 pr-2 font-medium">
                  {s.scene_id}
                </th>
                <td className="py-1 pr-2">{s.render_ready ? `Yes (${humanize(String(s.ready_via ?? ""))})` : "No"}</td>
                <td className="py-1 pr-2">
                  <StatusBadge presentation={applyStatePresentation(states.get(s.scene_id) ?? "none")} />
                </td>
                <td className="py-1 break-words">
                  {[...(s.publication_blockers ?? []), s.next_action ?? ""].filter(Boolean).join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list("Errors", r.errors ?? [], "border-red-200 bg-red-50/60")}
      {list("Unpublishable images", r.unpublishable ?? [], "border-amber-200 bg-amber-50/60")}
      {list("Image integrity", r.image_integrity ?? [], "border-red-200 bg-red-50/60")}
      {list("Warnings", r.warnings ?? [], "")}
      {result ? <ApplyResultNote result={result} projectId={projectId} /> : null}
      {open && validated ? (
        <ApplyDialog
          view={view}
          projectId={projectId}
          revision={validated}
          block={block}
          onClose={() => setOpen(false)}
          onApplied={(res) => {
            setResult(res);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ApplyResultNote({ result, projectId }: { result: VisualsApplyResult; projectId: string }) {
  const changedDraft = result.status === "published";
  return (
    <section role="status" aria-labelledby="apply-result-h" className="space-y-2 rounded-lg border bg-surface-muted p-3 text-sm">
      <h4 id="apply-result-h" className="font-semibold">
        Apply: {humanize(result.status)}
      </h4>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>Scenes changed: {result.scenes_changed.join(", ") || "none"}</li>
        <li>Assets added: {result.assets_added.join(", ") || "none"}</li>
        {result.images_restored.length ? <li>Missing images restored: {result.images_restored.join(", ")}</li> : null}
        {result.rights_unverified.length ? (
          <li className="text-warning">Applied without verified rights (review renders only): {result.rights_unverified.join(", ")}</li>
        ) : null}
      </ul>
      {changedDraft ? (
        <p>
          The draft changed, so its editorial approval (G1) is out of date.{" "}
          <Link href={`/projects/${encodeURIComponent(projectId)}/draft`} className="font-medium underline">
            Re-approve the draft (G1)
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function ApplyDialog({
  view,
  projectId,
  revision,
  block,
  onClose,
  onApplied,
}: {
  view: VisualsView;
  projectId: string;
  revision: string;
  block: string | null;
  onClose: () => void;
  onApplied: (r: VisualsApplyResult) => void;
}) {
  const qc = useQueryClient();
  const [reviewer, setReviewer] = useState("");
  const m = useMutation({
    mutationFn: () => api.visualsApply(projectId, { expected_revision: revision, reviewer: reviewer.trim(), confirm: true }),
    onSuccess: (r) => {
      qc.setQueryData(qk.visuals(projectId), r.visuals);
      void qc.invalidateQueries({ queryKey: qk.draft(projectId) });
      void qc.invalidateQueries({ queryKey: qk.projectStatus(projectId) });
      toast.success(r.result.status === "already_current" ? "Already applied: nothing changed" : "Selection applied to the draft");
      onApplied(r.result);
    },
    onError: (e) => {
      if (e instanceof ApiError && ["revision_conflict", "recovery_required", "image_integrity", "engine_conflict"].includes(e.code)) {
        void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
      }
    },
  });
  const changed = view.revision !== revision ? "The visuals changed since you validated them: close this and validate again." : null;
  const reason = block ?? changed ?? (!reviewer.trim() ? "Enter your name." : null);
  // The shared-image explanation only when the engine's own items name that conflict; any other
  // not_ready is shown in the engine's words alone.
  const items = m.error instanceof ApiError && Array.isArray(m.error.details?.errors) ? (m.error.details.errors as unknown[]).map(String) : [];
  const shared = m.error instanceof ApiError && m.error.code === "not_ready" && items.some((x) => x.includes("different provenance"));
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Apply the selection to the draft</DialogTitle>
          <DialogDescription>
            The engine writes the chosen images into the draft&apos;s shots and its asset list, from the validated revision{" "}
            {revision.slice(0, 12)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="rounded border border-amber-200 bg-amber-50 p-2 text-warning">
            Applying changes the draft, so its editorial approval (G1) goes out of date. Approve the draft again afterwards; release
            needs it. Shots in the draft that the engine did not write are never replaced: apply is refused instead.
          </p>
          {changed ? (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-danger">
              {changed}
            </p>
          ) : null}
          <LineField label="Reviewer" value={reviewer} onChange={setReviewer} required hint={REVIEWER_HINT} />
          {shared ? (
            <p className="text-sm">
              Two candidates share the same image bytes under different provenance or rights. Choose a compatible candidate, or new
              shots for every scene the engine names below.
            </p>
          ) : null}
          <VisualsError error={m.error} onReload={() => void qc.invalidateQueries({ queryKey: qk.visuals(projectId) })} />
        </div>
        <DialogFooter>
          {reason ? <p className="mr-auto text-xs text-muted-foreground">{reason}</p> : null}
          <Button onClick={() => m.mutate()} disabled={Boolean(reason) || m.isPending}>
            <CheckCheck aria-hidden /> {m.isPending ? "Applying…" : "Apply selection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
