"use client";

import { BadgeCheck, FileSearch, Pencil, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DecisionPanel } from "@/components/research/decision-panel";
import { EditError } from "@/components/research/edit-error";
import { LineField, MIN, TextField } from "@/components/research/fields";
import { NO_TRANSLATION, TranslationFields, translationOp, translationReady, type Translation } from "@/components/research/link-dialog";
import { OccurrencePicker } from "@/components/research/occurrence-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useOccurrenceSearch } from "@/hooks/use-occurrence-search";
import { useResearchEdit } from "@/hooks/use-research-edit";
import {
  CLAIM_FLAGS,
  CLAIM_KINDS,
  EVIDENCE_ROLES,
  SOURCE_TYPES,
  type ClaimFlag,
  type ClaimKind,
  type EvidenceRecord,
  type EvidenceRole,
  type PlanClaim,
  type ResearchClaim,
  type ResearchView,
  type SourceType,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { humanize } from "@/lib/status";

export function acquisitionLabel(acquisition: string | null | undefined): string {
  if (acquisition === "imported") return "Imported document — not retrieved by the engine";
  if (acquisition === "fixture") return "Test data — never real evidence";
  return "Retrieved by the engine";
}

/** Everything a reviewer needs for one claim: where it sits in the narration, its fields,
 * its evidence and the decision. Every change is one research-edit under the loaded revision. */
export function ClaimPanel({
  view,
  projectId,
  claim,
  planClaim,
  lang,
  onRead,
}: {
  view: ResearchView;
  projectId: string;
  claim: ResearchClaim;
  planClaim: PlanClaim | undefined;
  lang?: string;
  onRead: (snapshotId: string) => void;
}) {
  const editing = view.editing;
  const blocked = !editing?.supported
    ? editing?.reason ?? "Editing is not available."
    : editing.migration_required
      ? "Upgrade the research records first (Validation tab)."
      : view.active_job_id
        ? "A job is running for this project."
        : null;
  const record = view.review?.reviews.find((r) => r.claim_id === claim.id) ?? null;
  const links = (view.evidence as unknown as EvidenceRecord[]).filter((x) => x.claim_id === claim.id);
  const legacyLinks = links.some((x) => x.id === null);
  const contested = claim.contested || claim.kind === "interpretation" || claim.flags.includes("contested");
  return (
    <div className="space-y-4">
      {planClaim?.anchors.map((a, i) => (
        <figure key={i} className="rounded-md border bg-surface-muted/50 p-3 text-sm">
          <figcaption className="text-xs text-muted-foreground">Narration, {a.scene_id}</figcaption>
          {a.context ? (
            <p lang={lang} className="leading-7">
              {a.context.truncated_before ? "… " : ""}
              {a.context.before}
              <mark className="rounded bg-amber-100 px-0.5 text-foreground">{a.context.excerpt}</mark>
              {a.context.after}
              {a.context.truncated_after ? " …" : ""}
            </p>
          ) : (
            <p lang={lang}>
              <mark className="rounded bg-amber-100 px-0.5">{a.excerpt}</mark>{" "}
              <span className="text-xs text-muted-foreground">(the narration changed; this excerpt no longer matches it)</span>
            </p>
          )}
        </figure>
      ))}
      {planClaim ? <ClaimEditor projectId={projectId} revision={view.revision} claim={planClaim} lang={lang} disabled={blocked} hasRefs={links.length > 0 || Boolean(record)} /> : null}
      <EvidenceList view={view} projectId={projectId} links={links} lang={lang} onRead={onRead} disabled={blocked} />
      {legacyLinks ? (
        <p className="text-xs text-warning">
          Some links were recorded before persistent IDs: they are read-only, and no decision can be recorded until the research records are
          upgraded (Validation tab).
        </p>
      ) : null}
      <DecisionPanel
        projectId={projectId}
        revision={view.revision}
        claim={claim}
        record={record}
        contested={contested}
        lang={lang}
        disabled={blocked ?? (legacyLinks ? "Upgrade the research records first (legacy evidence links)." : null)}
      />
    </div>
  );
}

function ClaimEditor({
  projectId,
  revision,
  claim,
  lang,
  disabled,
  hasRefs,
}: {
  projectId: string;
  revision: string | null;
  claim: PlanClaim;
  lang?: string;
  disabled: string | null;
  hasRefs: boolean;
}) {
  const edit = useResearchEdit(projectId, revision);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [f, setF] = useState({ assertion: claim.assertion, kind: claim.kind, flags: claim.flags, contested: claim.contested, notes: claim.notes });
  const begin = () => {
    setF({ assertion: claim.assertion, kind: claim.kind, flags: claim.flags, contested: claim.contested, notes: claim.notes });
    edit.reset();
    setOpen(true);
  };
  const changes = {
    ...(f.assertion !== claim.assertion ? { assertion: f.assertion } : {}),
    ...(f.kind !== claim.kind ? { kind: f.kind } : {}),
    ...(JSON.stringify([...f.flags].sort()) !== JSON.stringify([...claim.flags].sort()) ? { flags: f.flags } : {}),
    ...(f.contested !== claim.contested ? { contested: f.contested } : {}),
    ...(f.notes !== claim.notes && f.notes.trim() ? { notes: f.notes } : {}),
  };
  const save = async () => {
    try {
      await edit.run([{ op: "claims.update", id: claim.id, ...changes }]);
      toast.success("Claim saved");
      setOpen(false);
    } catch {
      /* shown; input kept */
    }
  };
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Origin: {humanize(claim.origin)}</span>
        {claim.notes ? <span>· Notes: {claim.notes}</span> : null}
        <Button size="sm" variant="outline" onClick={begin} disabled={Boolean(disabled)}>
          <Pencil aria-hidden /> Edit claim
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRemoving(true)} disabled={Boolean(disabled) || hasRefs}
          title={hasRefs ? "Evidence or a decision refers to this claim" : undefined}>
          <Trash2 aria-hidden /> Remove claim
        </Button>
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title="Remove this claim?"
          description="The claim leaves the inventory. Its narration may then be reported as not covered by any claim."
          confirmLabel="Remove claim"
          cancelLabel="Keep it"
          destructive
          pending={edit.pending}
          onConfirm={async () => {
            try {
              await edit.run([{ op: "claims.remove", id: claim.id }]);
              setRemoving(false);
              toast.success("Claim removed");
            } catch {
              /* shown */
            }
          }}
        >
          <EditError error={removing ? edit.error : null} onReload={edit.reload} />
        </ConfirmDialog>
      </div>
    );
  }
  return (
    <form className="space-y-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h4 className="text-sm font-semibold">Edit claim</h4>
      <p className="text-xs text-muted-foreground">Changing the wording, kind, contested state or flags makes an earlier decision outdated.</p>
      <TextField label="Assertion" value={f.assertion} onChange={(v) => setF({ ...f, assertion: v })} required max={2000} lang={lang} />
      <div className="space-y-1">
        <Label htmlFor={`${id}-kind`}>Kind</Label>
        <select id={`${id}-kind`} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ClaimKind })}
          className="rounded-md border bg-surface px-2 py-1.5 text-sm">
          {CLAIM_KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Flags</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {CLAIM_FLAGS.map((fl) => (
            <label key={fl} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.flags.includes(fl)}
                onChange={(e) => setF({ ...f, flags: e.target.checked ? [...f.flags, fl] : f.flags.filter((x: ClaimFlag) => x !== fl) })} />
              {humanize(fl)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.contested} onChange={(e) => setF({ ...f, contested: e.target.checked })} />
        Contested
      </label>
      <TextField label="Notes" value={f.notes} onChange={(v) => setF({ ...f, notes: v })} rows={2} lang={lang} />
      <EditError error={edit.error} onReload={edit.reload} />
      <div className="flex gap-2">
        <Button type="submit" disabled={!Object.keys(changes).length || !f.assertion.trim() || edit.pending}>
          {edit.pending ? "Saving…" : "Save claim"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const GROUPS: { label: string; roles: EvidenceRole[] }[] = [
  { label: "Supports", roles: ["supports"] },
  { label: "Contradicts", roles: ["contradicts"] },
  { label: "Context", roles: ["context", "mentions_only"] },
];

function EvidenceList({
  view,
  projectId,
  links,
  lang,
  onRead,
  disabled,
}: {
  view: ResearchView;
  projectId: string;
  links: EvidenceRecord[];
  lang?: string;
  onRead: (id: string) => void;
  disabled: string | null;
}) {
  const snaps = new Map(view.snapshots.map((s) => [s.id, s]));
  const attested = new Set((view.review?.primary_source_attestations ?? []).map((a) => a.snapshot_id));
  const [editing, setEditing] = useState<EvidenceRecord | null>(null);
  const [tracing, setTracing] = useState<EvidenceRecord | null>(null);
  if (!links.length) return <p className="text-sm text-muted-foreground">No evidence linked yet. Open a snapshot and select a passage to link it.</p>;
  return (
    <div className="space-y-3">
      {GROUPS.map((g) => {
        const mine = links.filter((x) => g.roles.includes(x.role));
        if (!mine.length) return null;
        return (
          <section key={g.label} aria-label={`${g.label} evidence`}>
            <h4 className="text-sm font-semibold">
              {g.label} ({mine.length})
            </h4>
            <ul className="mt-1 space-y-2">
              {mine.map((x, i) => {
                const s = snaps.get(x.snapshot_id);
                const traced = x.translation_of && typeof x.translation_of === "object" ? x.translation_of : null;
                return (
                  <li key={x.id ?? `${x.snapshot_id}-${x.start}-${i}`} className="space-y-1 rounded-md border bg-surface p-2 text-sm">
                    <blockquote lang={s?.language ?? lang} className="border-l-2 pl-2">
                      {x.quote}
                    </blockquote>
                    <p className="text-xs text-muted-foreground">
                      {s?.title ?? x.snapshot_id} · {acquisitionLabel(s?.acquisition)}
                      {s?.acquisition === "imported" && s.document_provenance?.imported_at ? `, imported ${formatDateTime(s.document_provenance.imported_at)}` : ""}
                      {s?.acquisition === "retrieved" && s.retrieved_at ? `, ${formatDateTime(s.retrieved_at)}` : ""}
                    </p>
                    {attested.has(x.snapshot_id) ? (
                      <p className="inline-flex items-center gap-1 text-xs text-success">
                        <BadgeCheck aria-hidden className="size-3.5" /> Attested primary source (this edition)
                      </p>
                    ) : null}
                    <p className="text-xs">
                      {humanize(x.role)} · {humanize(x.source_type)}
                      {x.evidence_root ? ` · root ${x.evidence_root}` : ""}
                    </p>
                    <p className="text-xs">{x.explanation}</p>
                    {x.is_translation ? (
                      traced ? (
                        <p className="text-xs">
                          Translation of “{traced.quote}” ({traced.language}, {traced.speaker}) in {snaps.get(traced.snapshot_id)?.title ?? traced.snapshot_id}
                          {x.translator ? `; translated by ${x.translator}` : "; translator unknown"}
                        </p>
                      ) : (
                        <p className="text-xs text-warning">Translation — not traced to its original (a free-text note never counts).</p>
                      )
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => onRead(x.snapshot_id)}>
                        <FileSearch aria-hidden /> Open snapshot
                      </Button>
                      {x.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setEditing(x)} disabled={Boolean(disabled)}>
                            Edit link…
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setTracing(x)} disabled={Boolean(disabled)}>
                            {traced ? "Change original…" : x.is_translation ? "Trace to original…" : "Mark as translation…"}
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">Legacy link (read only)</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {editing ? <LinkEditDialog projectId={projectId} revision={view.revision} link={editing} onClose={() => setEditing(null)} /> : null}
      {tracing ? <TraceDialog projectId={projectId} view={view} link={tracing} onClose={() => setTracing(null)} /> : null}
    </div>
  );
}

function LinkEditDialog({ projectId, revision, link, onClose }: { projectId: string; revision: string | null; link: EvidenceRecord; onClose: () => void }) {
  const edit = useResearchEdit(projectId, revision);
  const id = useId();
  const [f, setF] = useState({ role: link.role, explanation: link.explanation, source_type: link.source_type, evidence_root: link.evidence_root ?? "" });
  const [removing, setRemoving] = useState(false);
  const changes = {
    ...(f.role !== link.role ? { role: f.role } : {}),
    ...(f.explanation !== link.explanation ? { explanation: f.explanation } : {}),
    ...(f.source_type !== link.source_type ? { source_type: f.source_type } : {}),
    ...(f.evidence_root.trim() && f.evidence_root.trim() !== (link.evidence_root ?? "") ? { evidence_root: f.evidence_root.trim() } : {}),
  };
  // The engine can change an evidence root but not remove one (`evidence.update` refuses null
  // and empty values), so an emptied field must block the save, never be dropped silently.
  const rootCleared = Boolean(link.evidence_root) && !f.evidence_root.trim();
  const run = async (ops: Record<string, unknown>[], done: string) => {
    try {
      await edit.run(ops as { op: string }[]);
      toast.success(done);
      onClose();
    } catch {
      /* shown */
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit evidence link</DialogTitle>
          <DialogDescription>The passage itself cannot change: remove the link and link the new passage instead.</DialogDescription>
        </DialogHeader>
        <blockquote className="border-l-2 pl-2 text-sm">{link.quote}</blockquote>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-role`}>Role</Label>
            <select id={`${id}-role`} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as EvidenceRole })}
              className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
              {EVIDENCE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-type`}>Source type</Label>
            <select id={`${id}-type`} value={f.source_type} onChange={(e) => setF({ ...f, source_type: e.target.value as SourceType })}
              className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <TextField label="Explanation" value={f.explanation} onChange={(v) => setF({ ...f, explanation: v })} min={MIN.explanation} required />
        <LineField label="Evidence root" value={f.evidence_root} onChange={(v) => setF({ ...f, evidence_root: v })} />
        {rootCleared ? (
          <p role="alert" className="text-sm text-danger">
            An evidence root cannot be removed, only changed. To link this passage without a root, remove the link and link the passage
            again; a decision that relied on it then becomes outdated.
          </p>
        ) : null}
        <EditError error={edit.error} onReload={edit.reload} />
        <DialogFooter className="sm:justify-between">
          <Button variant="destructive" onClick={() => setRemoving(true)} disabled={edit.pending}>
            <Trash2 aria-hidden /> Remove link
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => run([{ op: "evidence.update", link_id: link.id, ...changes }], "Link saved")}
              disabled={!Object.keys(changes).length || rootCleared || !f.explanation.trim() || edit.pending}>
              {edit.pending ? "Saving…" : "Save link"}
            </Button>
          </div>
        </DialogFooter>
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title="Remove this evidence link?"
          description="A decision that relied on it becomes outdated."
          confirmLabel="Remove link"
          cancelLabel="Keep it"
          destructive
          pending={edit.pending}
          onConfirm={() => run([{ op: "evidence.remove", link_id: link.id }], "Link removed")}
        />
      </DialogContent>
    </Dialog>
  );
}

const ORIGINAL = ["original_quote"] as const;

/** Trace a translated passage to its original (`evidence.set_translation`), or stop marking
 * it as a translation (`evidence.clear_translation`). */
function TraceDialog({ projectId, view, link, onClose }: { projectId: string; view: ResearchView; link: EvidenceRecord; onClose: () => void }) {
  const edit = useResearchEdit(projectId, view.revision);
  const traced = link.translation_of && typeof link.translation_of === "object" ? link.translation_of : null;
  const [tr, setTr] = useState<Translation>(
    traced
      ? { ...NO_TRANSLATION, snapshot_id: traced.snapshot_id, quote: traced.quote, language: traced.language, speaker: traced.speaker,
          equivalence_note: traced.equivalence_note, translator: link.translator ?? "" }
      : NO_TRANSLATION,
  );
  const op = (n: number | null) => ({
    op: "evidence.set_translation",
    link_id: link.id,
    translation_of: translationOp(tr, n),
    ...(tr.translator.trim() ? { translator: tr.translator.trim() } : {}),
    ...(tr.language.trim() ? { original_language: tr.language.trim() } : {}),
  });
  // Results belong to this exact operation under this revision; any edit to the form hides them.
  const occs = useOccurrenceSearch(JSON.stringify([view.revision, op(null)]), ORIGINAL);
  const found = occs.found ? occs.occurrences("original_quote") : null;
  const occ = occs.pick("original_quote");
  const find = () => occs.search(() => edit.dryRun([op(null)]));
  const save = async (ops: Record<string, unknown>[], msg: string) => {
    try {
      await edit.run(ops as { op: string }[]);
      toast.success(msg);
      onClose();
    } catch {
      /* shown */
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Trace the translation to its original</DialogTitle>
          <DialogDescription>An untraced translation never supports a quotation.</DialogDescription>
        </DialogHeader>
        <blockquote className="border-l-2 pl-2 text-sm">{link.quote}</blockquote>
        <TranslationFields value={tr} onChange={setTr} snapshots={view.snapshots.filter((s) => s.id !== link.snapshot_id)} />
        {found ? <OccurrencePicker label="Original passage" occurrences={found} value={occ} onChange={(n) => occs.setPick("original_quote", n)} /> : null}
        <EditError error={edit.error} onReload={edit.reload} />
        <DialogFooter className="sm:justify-between">
          {link.is_translation ? (
            <Button variant="outline" onClick={() => save([{ op: "evidence.clear_translation", link_id: link.id }], "No longer marked as a translation")}
              disabled={edit.pending}>
              Not a translation
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {!found ? (
              <Button onClick={find} disabled={!translationReady(tr) || occs.searching || !view.revision}>
                {occs.searching ? "Finding…" : "Find the original"}
              </Button>
            ) : (
              <Button onClick={() => save([op(occ)], "Translation traced")} disabled={!occ || edit.pending}>
                {edit.pending ? "Saving…" : "Save translation"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
