"use client";

import { AlertTriangle, ArrowUpCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { HistoryDisclosure } from "@/components/research/decision-panel";
import { EditError } from "@/components/research/edit-error";
import { LineField, MIN, REVIEWER_HINT, TextField } from "@/components/research/fields";
import { Button } from "@/components/ui/button";
import { useResearchEdit } from "@/hooks/use-research-edit";
import type { RecheckRecord, ResearchItem, ResearchView } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/** `m5-review-0.1` records (and legacy links/rechecks without IDs) are upgraded only on an
 * explicit request. Decisions are kept, shown as outdated, and must be confirmed again. */
export function UpgradeBanner({ projectId, view }: { projectId: string; view: ResearchView }) {
  const edit = useResearchEdit(projectId, view.revision);
  const [open, setOpen] = useState(false);
  const needFile = Boolean(view.editing?.migration_required);
  const needIds = Boolean(view.editing?.legacy_ids);
  if (!needFile && !needIds) return null;
  const ops = [...(needFile ? [{ op: "migrate_review_file" }] : []), ...(needIds || needFile ? [{ op: "migrate_ids" }] : [])];
  return (
    <section aria-labelledby="upgrade-h" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <h3 id="upgrade-h" className="flex items-center gap-1 font-semibold text-warning">
        <ArrowUpCircle aria-hidden className="size-4" /> Upgrade research records
      </h3>
      <p>
        {needFile
          ? "The review decisions use the older format (m5-review-0.1). Nothing can be edited until they are upgraded."
          : "Some evidence links or source rechecks were recorded before persistent IDs; they stay read-only until upgraded."}
      </p>
      <Button size="sm" onClick={() => setOpen(true)} disabled={Boolean(view.active_job_id) || !view.revision}>
        Upgrade research records…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Upgrade the research records?"
        description="The engine rewrites the review records in the current format and gives legacy links and rechecks persistent IDs."
        confirmLabel="Upgrade"
        cancelLabel="Not now"
        pending={edit.pending}
        onConfirm={async () => {
          try {
            await edit.run(ops);
            setOpen(false);
            toast.success("Research records upgraded");
          } catch {
            /* shown */
          }
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Every decision is kept, word for word, but counts as outdated until a reviewer confirms it again.</li>
          <li>The completeness attestation is kept and must be confirmed again.</li>
          <li>The files change, so an existing research approval (G2) goes out of date.</li>
          <li>The upgrade is recorded as the first entry of the review history.</li>
        </ul>
        <EditError error={open ? edit.error : null} onReload={edit.reload} />
      </ConfirmDialog>
    </section>
  );
}

const COMPLETENESS_CODES = ["completeness_missing", "completeness_stale", "completeness_invalid"];

export function CompletenessPanel({ projectId, view, disabled }: { projectId: string; view: ResearchView; disabled: string | null }) {
  const edit = useResearchEdit(projectId, view.revision);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ reviewer: "", statement: "" });
  const comp = view.review?.completeness ?? null;
  const problems = (view.report?.items ?? []).filter((i) => COMPLETENESS_CODES.includes(i.code));
  const save = async () => {
    try {
      await edit.run([{ op: "completeness.set", reviewer: f.reviewer.trim(), statement: f.statement }]);
      toast.success("Completeness attested");
      setOpen(false);
    } catch {
      /* shown */
    }
  };
  return (
    <section aria-labelledby="completeness-h" className="space-y-2 rounded-lg border p-4 text-sm">
      <h3 id="completeness-h" className="font-semibold">
        Completeness
      </h3>
      {comp ? (
        <p>
          Attested by {comp.reviewer}, {formatDateTime(comp.confirmed_at)}: {comp.statement}
        </p>
      ) : (
        <p className="text-muted-foreground">Not attested yet.</p>
      )}
      {problems.map((p, i) => (
        <p key={i} className="flex items-start gap-1 text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {p.code === "completeness_stale" ? "Out of date: the narration or the claim inventory changed since it was attested. " : ""}
            {p.detail}
          </span>
        </p>
      ))}
      {!open ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={Boolean(disabled)}>
          {comp ? "Attest again…" : "Attest completeness…"}
        </Button>
      ) : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <p className="text-xs text-muted-foreground">
            You confirm that every factual sentence of the narration is covered by a claim or marked as nonfactual. The attestation is bound to
            the current narration and claim inventory.
          </p>
          <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
          <TextField label="Statement" value={f.statement} onChange={(v) => setF({ ...f, statement: v })} required min={MIN.statement} rows={2} />
          <EditError error={edit.error} onReload={edit.reload} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!f.reviewer.trim() || !f.statement.trim() || edit.pending}>
              {edit.pending ? "Saving…" : "Attest"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <HistoryDisclosure projectId={projectId} kind="completeness" label="Earlier attestations" />
    </section>
  );
}

type Group = { source_id: string; cited: string; current: string; claims: string[]; items: ResearchItem[] };

/** research-check reports `source_changed` / `source_recheck_stale` per (claim, cited snapshot);
 * one recheck covers a (source, cited snapshot, current snapshot) group. */
function groups(items: ResearchItem[]): Group[] {
  const out = new Map<string, Group>();
  for (const i of items) {
    if (i.code !== "source_changed" && i.code !== "source_recheck_stale") continue;
    const r = (i.refs ?? {}) as Record<string, string>;
    if (!r.source_id || !r.cited_snapshot_id || !r.current_snapshot_id) continue;
    const key = `${r.source_id}|${r.cited_snapshot_id}|${r.current_snapshot_id}`;
    const g = out.get(key) ?? { source_id: r.source_id, cited: r.cited_snapshot_id, current: r.current_snapshot_id, claims: [], items: [] };
    if (i.claim_id && !g.claims.includes(i.claim_id)) g.claims.push(i.claim_id);
    g.items.push(i);
    out.set(key, g);
  }
  return [...out.values()];
}

export function RechecksPanel({ projectId, view, disabled }: { projectId: string; view: ResearchView; disabled: string | null }) {
  const pending = groups(view.report?.items ?? []);
  const existing = view.review?.source_rechecks ?? [];
  const title = (id: string) => view.snapshots.find((s) => s.id === id)?.title ?? id;
  return (
    <section aria-labelledby="rechecks-h" className="space-y-3 rounded-lg border p-4 text-sm">
      <h3 id="rechecks-h" className="font-semibold">
        Source rechecks
      </h3>
      <p className="text-xs text-muted-foreground">
        When a cited source changed, a reviewer either links the new version instead, or records that the cited version still holds for these
        claims. One recheck covers one source, cited snapshot and current snapshot.
      </p>
      {!pending.length && !existing.length ? <p className="text-muted-foreground">No source changed since it was cited.</p> : null}
      {pending.map((g) => (
        <RecheckForm key={`${g.source_id}|${g.cited}|${g.current}`} projectId={projectId} view={view} group={g} title={title} disabled={disabled} />
      ))}
      {existing.map((r, i) => (
        <RecheckRecordItem key={r.id ?? i} projectId={projectId} view={view} record={r} title={title} disabled={disabled} />
      ))}
      <HistoryDisclosure projectId={projectId} kind="source_recheck" label="Recheck history" />
    </section>
  );
}

function SideBySide({ cited, current, title }: { cited: string; current: string; title: (id: string) => string }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      <div className="rounded border p-2">
        <dt className="text-xs text-muted-foreground">Cited snapshot</dt>
        <dd>
          {title(cited)} <code className="text-xs">{cited}</code>
        </dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-xs text-muted-foreground">Current snapshot</dt>
        <dd>
          {title(current)} <code className="text-xs">{current}</code>
        </dd>
      </div>
    </dl>
  );
}

function RecheckForm({ projectId, view, group, title, disabled }: { projectId: string; view: ResearchView; group: Group; title: (id: string) => string; disabled: string | null }) {
  const edit = useResearchEdit(projectId, view.revision);
  const [f, setF] = useState({ reviewer: "", rationale: "" });
  const save = async () => {
    try {
      await edit.run([
        {
          op: "source_rechecks.add",
          source_id: group.source_id,
          cited_snapshot_id: group.cited,
          expected_current_snapshot_id: group.current,
          claim_ids: group.claims,
          reviewer: f.reviewer.trim(),
          rationale: f.rationale,
        },
      ]);
      toast.success("Recheck recorded");
    } catch {
      /* shown */
    }
  };
  return (
    <form className="space-y-2 rounded-md border border-amber-300 p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="font-medium text-warning">Needs a recheck: {group.claims.join(", ")}</p>
      <SideBySide cited={group.cited} current={group.current} title={title} />
      <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
      <TextField label="Why the cited version still holds" value={f.rationale} onChange={(v) => setF({ ...f, rationale: v })} required min={MIN.long} rows={2} />
      <EditError error={edit.error} onReload={edit.reload} />
      <Button type="submit" size="sm" disabled={Boolean(disabled) || !f.reviewer.trim() || !f.rationale.trim() || edit.pending}>
        {edit.pending ? "Saving…" : "Keep the cited version"}
      </Button>
    </form>
  );
}

function RecheckRecordItem({ projectId, view, record, title, disabled }: { projectId: string; view: ResearchView; record: RecheckRecord; title: (id: string) => string; disabled: string | null }) {
  const edit = useResearchEdit(projectId, view.revision);
  const [mode, setMode] = useState<"view" | "update" | "remove">("view");
  const [f, setF] = useState({ reviewer: "", rationale: record.rationale, reason: "", claims: record.claim_ids });
  const claimIds = (view.plan?.claims ?? []).map((c) => c.id);
  const run = async (op: Record<string, unknown>, msg: string) => {
    try {
      await edit.run([op as { op: string }]);
      toast.success(msg);
      setMode("view");
    } catch {
      /* shown */
    }
  };
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p>
        <span className="font-medium">Kept cited version</span> for {record.claim_ids.join(", ")} · by {record.reviewer},{" "}
        {formatDateTime(record.reviewed_at)} {record.id ? <code className="text-xs">{record.id}</code> : <span className="text-xs">(legacy, read only)</span>}
      </p>
      <SideBySide cited={record.cited_snapshot_id} current={record.current_snapshot_id} title={title} />
      <p className="text-xs">{record.rationale}</p>
      {mode === "view" && record.id ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setMode("update")} disabled={Boolean(disabled)}>
            Correct…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("remove")} disabled={Boolean(disabled)}>
            Remove…
          </Button>
        </div>
      ) : null}
      {mode !== "view" ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void (mode === "update"
              ? run({ op: "source_rechecks.update", recheck_id: record.id, reviewer: f.reviewer.trim(),
                      ...(f.rationale !== record.rationale ? { rationale: f.rationale } : {}),
                      ...(JSON.stringify(f.claims) !== JSON.stringify(record.claim_ids) ? { claim_ids: f.claims } : {}) }, "Recheck corrected")
              : run({ op: "source_rechecks.remove", recheck_id: record.id, reviewer: f.reviewer.trim(), reason: f.reason }, "Recheck removed; it is kept in the history"));
          }}
        >
          <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
          {mode === "update" ? (
            <>
              <fieldset>
                <legend className="text-sm font-medium">Claims covered</legend>
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {claimIds.map((c) => (
                    <label key={c} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={f.claims.includes(c)}
                        onChange={(e) => setF({ ...f, claims: e.target.checked ? [...f.claims, c] : f.claims.filter((x) => x !== c) })} />
                      {c}
                    </label>
                  ))}
                </div>
              </fieldset>
              <TextField label="Rationale" value={f.rationale} onChange={(v) => setF({ ...f, rationale: v })} min={MIN.long} rows={2} />
            </>
          ) : (
            <TextField label="Reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} required rows={2} />
          )}
          <EditError error={edit.error} onReload={edit.reload} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={mode === "remove" ? "destructive" : "default"}
              disabled={!f.reviewer.trim() || (mode === "remove" ? !f.reason.trim() : !f.claims.length) || edit.pending}>
              {edit.pending ? "Saving…" : mode === "update" ? "Save correction" : "Remove recheck"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
