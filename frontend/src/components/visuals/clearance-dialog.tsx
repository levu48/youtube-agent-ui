"use client";

import { ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { LineField, REVIEWER_HINT, TextField } from "@/components/research/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { VisualsError } from "@/components/visuals/visuals-error";
import { useVisualsEdit } from "@/hooks/use-visuals-edit";
import { candidateImageUrl, type VisualCandidate, type VisualsView } from "@/lib/api";
import { CLEARANCE_BASIS } from "@/lib/status";

/** What the dialog was opened on. It never follows a later view: a change to any of these
 * locks it, so a clearance is recorded only for the exact bytes and evidence shown. */
export interface ClearanceTarget {
  candidate: VisualCandidate;
  sha256: string;
  rights_fingerprint: string;
  revision: string;
}

export function clearanceTarget(c: VisualCandidate, view: VisualsView): ClearanceTarget | null {
  if (!c.sha256 || !c.rights_fingerprint) return null;
  return { candidate: c, sha256: c.sha256, rights_fingerprint: c.rights_fingerprint, revision: view.revision };
}

function current(view: VisualsView, id: string): VisualCandidate | null {
  for (const items of Object.values(view.candidates)) for (const c of items) if (c.id === id) return c;
  return null;
}

/** Why the bound target is no longer the one in the current view, or null. */
export function targetChange(t: ClearanceTarget, view: VisualsView): string | null {
  const now = current(view, t.candidate.id);
  if (!now || now.sha256 !== t.sha256 || now.rights_fingerprint !== t.rights_fingerprint || !view.catalog_trusted) {
    return "This image or its evidence changed since the dialog opened. Close it, check the image again, then record the clearance.";
  }
  if (view.revision !== t.revision) {
    return "The visuals changed since the dialog opened (the CLI, a job or another tab). Close it and open it again.";
  }
  return null;
}

/** Evidence fields the engine needs before a human attestation counts as verified rights. */
function missingEvidence(c: VisualCandidate): string[] {
  if (c.source_type === "generated") return [];
  const out = [];
  if (!c.rights?.license_name) out.push("licence name");
  if (!c.rights?.creator) out.push("creator");
  if (!c.source_page_url) out.push("source URL");
  return out;
}

const words = (s: string) => s.split(/\s+/).filter((w) => w.length > 1).length;

export function ClearanceDialog({
  target,
  view,
  projectId,
  block,
  onClose,
}: {
  target: ClearanceTarget;
  view: VisualsView;
  projectId: string;
  block: string | null;
  onClose: () => void;
}) {
  const id = useId();
  const edit = useVisualsEdit(projectId, target.revision);
  const c = target.candidate;
  const generated = c.source_type === "generated";
  const bases = (view.editing.bases ?? []).filter((b) => (b === "provider_terms_reviewed") === generated);
  const ack = view.editing.acknowledgement ?? "";
  const [f, setF] = useState({ reviewer: "", basis: "", justification: "", evidence: "" });
  const [agreed, setAgreed] = useState(false);
  const changed = targetChange(target, view);
  const missing = missingEvidence(c);
  const url = candidateImageUrl(projectId, { id: c.id, sha256: target.sha256 });
  const problem = !f.reviewer.trim()
    ? "Enter your name."
    : !f.basis
      ? "Choose the basis of your decision."
      : words(f.justification) < 6
        ? "Explain the decision (the engine expects at least about six words)."
        : !f.evidence.trim()
          ? "Name the evidence: a document in the project or an https link."
          : !agreed
            ? "Confirm the statement above."
            : null;
  const reason = block ?? changed ?? problem;

  const submit = async () => {
    try {
      await edit.run([
        {
          op: "clearance.set",
          candidate_id: c.id,
          expected_candidate_sha256: target.sha256,
          expected_rights_fingerprint: target.rights_fingerprint,
          reviewer: f.reviewer.trim(),
          basis: f.basis,
          justification: f.justification.trim(),
          evidence: f.evidence.trim(),
          acknowledgement: ack,
        },
      ]);
      toast.success(`Rights clearance recorded for ${c.id}`);
      onClose();
    } catch {
      // shown below, in the engine's words
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record a rights clearance</DialogTitle>
          <DialogDescription>
            For {c.title ?? c.id}. The engine binds the clearance to this exact image and its rights evidence, and keeps it
            in the clearance history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-surface-muted">
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- verified bytes from the backend, by hash
              <img src={url} alt={`${c.title ?? c.id}: the image being cleared`} className="max-h-full object-contain" />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Image <code className="font-mono">{target.sha256.slice(0, 12)}</code>. Source:{" "}
            {c.source_page_url ? (
              <a href={c.source_page_url} target="_blank" rel="noopener noreferrer" className="underline">
                {c.source_page_url}
              </a>
            ) : (
              "not recorded"
            )}
            . Licence: {c.rights?.license_name || "not recorded"}. Creator: {c.rights?.creator || "not recorded"}.
          </p>
          {changed ? (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-danger">
              {changed}
            </p>
          ) : null}
          {missing.length ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-warning">
              The engine counts a clearance as verified rights only with complete evidence. This image is missing:{" "}
              {missing.join(", ")}. Re-import it with these fields if you have them.
            </p>
          ) : null}
          <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
          <div className="space-y-1">
            <Label htmlFor={`${id}-basis`}>
              Basis<span className="text-danger"> *</span>
            </Label>
            <select
              id={`${id}-basis`}
              value={f.basis}
              onChange={(e) => setF({ ...f, basis: e.target.value })}
              className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">Choose…</option>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {CLEARANCE_BASIS[b] ?? b}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Justification"
            value={f.justification}
            onChange={(v) => setF({ ...f, justification: v })}
            required
            hint={`Why you may use this exact image (${words(f.justification)} words; the engine expects about six or more).`}
          />
          <LineField
            label="Evidence"
            value={f.evidence}
            onChange={(v) => setF({ ...f, evidence: v })}
            required
            max={2000}
            placeholder="permissions/letter.pdf or https://…"
            hint="A document inside the project, or an https link (never fetched). A document's bytes are bound: if it changes, the clearance stops counting."
          />
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Statement (the engine&apos;s exact words)</p>
            <blockquote className="border-l-4 pl-3 text-sm">{ack}</blockquote>
            <div className="flex items-start gap-2">
              <input id={`${id}-ack`} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 size-4" />
              <Label htmlFor={`${id}-ack`} className="font-normal">
                I make this statement, as written above.
              </Label>
            </div>
          </div>
          <VisualsError error={edit.error} onReload={() => void edit.reload()} />
        </div>
        <DialogFooter>
          {reason ? <p className="mr-auto text-xs text-muted-foreground">{reason}</p> : null}
          <Button onClick={() => void submit()} disabled={Boolean(reason) || edit.pending}>
            <ShieldCheck aria-hidden /> {edit.pending ? "Recording…" : "Record clearance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevokeDialog({
  candidate,
  view,
  projectId,
  block,
  onClose,
}: {
  candidate: VisualCandidate;
  view: VisualsView;
  projectId: string;
  block: string | null;
  onClose: () => void;
}) {
  const [revision] = useState(view.revision);
  const edit = useVisualsEdit(projectId, revision);
  const [f, setF] = useState({ reviewer: "", reason: "" });
  const changed = view.revision !== revision ? "The visuals changed since the dialog opened. Close it and open it again." : null;
  const problem = !f.reviewer.trim()
    ? "Enter your name."
    : words(f.reason) < 6
      ? "Explain why (the engine expects at least about six words)."
      : null;
  const reason = block ?? changed ?? problem;
  const submit = async () => {
    try {
      await edit.run([{ op: "clearance.revoke", candidate_id: candidate.id, reviewer: f.reviewer.trim(), reason: f.reason.trim() }]);
      toast.success(`Clearance revoked for ${candidate.id}`);
      onClose();
    } catch {
      // shown below
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Revoke a rights clearance</DialogTitle>
          <DialogDescription>
            For {candidate.title ?? candidate.id}. The revocation is kept in the clearance history. Applied images and the draft are
            not changed, but an applied image without a current clearance blocks G3 and release until a new clearance or another
            image.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {changed ? (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-danger">
              {changed}
            </p>
          ) : null}
          <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
          <TextField label="Reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} required hint="Why the clearance no longer holds." />
          <VisualsError error={edit.error} onReload={() => void edit.reload()} />
        </div>
        <DialogFooter>
          {reason ? <p className="mr-auto text-xs text-muted-foreground">{reason}</p> : null}
          <Button variant="destructive" onClick={() => void submit()} disabled={Boolean(reason) || edit.pending}>
            {edit.pending ? "Revoking…" : "Revoke clearance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
