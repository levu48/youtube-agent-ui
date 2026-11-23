"use client";

import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, FilePlus2, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EditError } from "@/components/research/edit-error";
import { LineField, MIN, REVIEWER_HINT, TextField } from "@/components/research/fields";
import { LinkDialog } from "@/components/research/link-dialog";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useResearchEdit } from "@/hooks/use-research-edit";
import { api, type ResearchSnapshot, type ResearchView } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { displayUrl } from "@/lib/status";

const ACQUIRED: Record<string, string> = {
  retrieved: "Retrieved by the engine",
  imported: "Imported document — not retrieved by the engine",
  fixture: "Test data: can never support real research",
};

const PROVENANCE: [string, string][] = [
  ["citation", "Citation"],
  ["imported_by", "Imported by"],
  ["edition", "Edition"],
  ["original_published_at", "Original date"],
  ["license", "Licence"],
  ["declared_url", "Declared URL (never fetched)"],
  ["note", "Note"],
];

/** A saved snapshot's text, verified against its hash by the backend. Plain text only: the
 * page is untrusted content, never rendered as HTML. A selected passage can be linked to a
 * claim; an imported edition shows its provenance and can be attested as a primary source. */
export function SnapshotReader({
  projectId,
  snapshotId,
  onClose,
  view,
  onOpen,
  onNewEdition,
}: {
  projectId: string;
  snapshotId: string | null;
  onClose: () => void;
  view?: ResearchView;
  onOpen?: (snapshotId: string) => void;
  onNewEdition?: (sourceId: string, edition: ResearchSnapshot) => void;
}) {
  const q = useQuery({
    queryKey: qk.snapshot(projectId, snapshotId ?? ""),
    queryFn: () => api.researchSnapshot(projectId, snapshotId!),
    enabled: Boolean(snapshotId),
  });
  const [selected, setSelected] = useState("");
  const [linking, setLinking] = useState(false);
  const s = q.data?.snapshot;
  const canEdit = Boolean(view?.editing?.supported && !view.editing.migration_required && !view.active_job_id && view.plan?.claims.length);
  const record = view?.snapshots.find((x) => x.id === s?.id);
  const newer = view?.snapshots.filter((x) => x.document_provenance?.supersedes_snapshot_id === s?.id) ?? [];
  const prov = s?.document_provenance ?? null;

  const capture = () => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "";
    if (text.trim()) setSelected(text);
  };

  return (
    <Dialog
      open={Boolean(snapshotId)}
      onOpenChange={(o) => {
        if (!o) {
          setSelected("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{s?.title ?? "Snapshot"}</DialogTitle>
          <DialogDescription>
            {s ? `${ACQUIRED[s.acquisition] ?? s.acquisition} · ${s.chars.toLocaleString("en")} characters` : "Loading"}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <LoadingSkeleton rows={4} label="Loading snapshot" />
        ) : q.isError ? (
          <ErrorState title="The snapshot cannot be shown" message={(q.error as Error).message} />
        ) : s ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {s.final_url ? (
                <>
                  <dt className="text-muted-foreground">Address</dt>
                  <dd className="break-all">{displayUrl(s.final_url)}</dd>
                </>
              ) : null}
              {s.canonical_url && s.canonical_url !== s.final_url ? (
                <>
                  <dt className="text-muted-foreground">Canonical</dt>
                  <dd className="break-all">{displayUrl(s.canonical_url)} (declared by the page, not verified)</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{s.acquisition === "imported" ? "Imported" : "Retrieved"}</dt>
              <dd>{s.retrieved_at ? formatDateTime(s.retrieved_at) : "unknown"}</dd>
              {s.publisher || s.author ? (
                <>
                  <dt className="text-muted-foreground">By</dt>
                  <dd>{[s.author, s.publisher].filter(Boolean).join(" · ")}</dd>
                </>
              ) : null}
              {prov
                ? PROVENANCE.filter(([k]) => prov[k]).map(([k, label]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="break-words">{k === "declared_url" ? displayUrl(prov[k]!) : prov[k]}</dd>
                    </div>
                  ))
                : null}
              <dt className="text-muted-foreground">Snapshot</dt>
              <dd className="font-mono">
                {s.id} · sha256 {s.text_sha256.slice(0, 12)}
              </dd>
            </dl>
            {prov?.supersedes_snapshot_id || newer.length ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {prov?.supersedes_snapshot_id ? (
                  <Button size="sm" variant="outline" onClick={() => onOpen?.(prov.supersedes_snapshot_id!)}>
                    Open the edition it supersedes
                  </Button>
                ) : null}
                {newer.map((n) => (
                  <Button key={n.id} size="sm" variant="outline" onClick={() => onOpen?.(n.id)}>
                    Open the newer edition ({n.id})
                  </Button>
                ))}
              </div>
            ) : null}
            {view && canEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setLinking(true)}>
                  <Link2 aria-hidden /> {selected ? "Link the selected passage to a claim…" : "Link a passage to a claim…"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {selected ? `Selected: “${selected.slice(0, 60)}${selected.length > 60 ? "…" : ""}”` : "Select text below, or type the passage in the next step."}
                </span>
                {s.acquisition === "imported" && record && onNewEdition ? (
                  <Button size="sm" variant="outline" onClick={() => onNewEdition(s.source_id, record)}>
                    <FilePlus2 aria-hidden /> Import a new edition…
                  </Button>
                ) : null}
              </div>
            ) : null}
            <pre
              lang={s.language ?? undefined}
              tabIndex={0}
              aria-label="Snapshot text"
              onMouseUp={capture}
              onKeyUp={capture}
              className="max-h-[50vh] overflow-auto rounded-lg border bg-surface p-3 font-sans text-sm leading-6 whitespace-pre-wrap"
            >
              {q.data!.text}
            </pre>
            {view && s.acquisition === "imported" ? (
              <PrimaryAttestation projectId={projectId} view={view} snapshotId={s.id} canEdit={canEdit || Boolean(view.editing?.supported && !view.editing.migration_required && !view.active_job_id)} />
            ) : null}
            {view && linking ? (
              <LinkDialog
                open={linking}
                onOpenChange={setLinking}
                projectId={projectId}
                revision={view.revision}
                snapshot={record ?? s}
                snapshots={view.snapshots.filter((x) => x.id !== s.id)}
                initialQuote={selected}
                claims={(view.plan?.claims ?? []).map((c) => ({ id: c.id, assertion: c.assertion }))}
              />
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Attest one imported edition as a primary source (`documents.attest_primary`), or revoke it.
 * It applies to this edition only and goes out of date if its text or provenance changes. */
function PrimaryAttestation({ projectId, view, snapshotId, canEdit }: { projectId: string; view: ResearchView; snapshotId: string; canEdit: boolean }) {
  const edit = useResearchEdit(projectId, view.revision);
  const current = view.review?.primary_source_attestations.find((a) => a.snapshot_id === snapshotId) ?? null;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ reviewer: "", text: "" });
  const run = async () => {
    try {
      await edit.run([
        current
          ? { op: "documents.revoke_primary", snapshot_id: snapshotId, reviewer: f.reviewer.trim(), reason: f.text }
          : { op: "documents.attest_primary", snapshot_id: snapshotId, reviewer: f.reviewer.trim(), statement: f.text },
      ]);
      toast.success(current ? "Attestation revoked; it is kept in the history" : "Edition attested as a primary source");
      setOpen(false);
      setF({ reviewer: "", text: "" });
    } catch {
      /* shown */
    }
  };
  return (
    <section aria-label="Primary source attestation" className="space-y-2 rounded-lg border p-3 text-sm">
      {current ? (
        <p className="flex flex-wrap items-center gap-1">
          <BadgeCheck aria-hidden className="size-4 text-success" />
          <span className="font-medium">Attested primary source</span>
          <span className="text-muted-foreground">
            by {current.reviewer}, {formatDateTime(current.at)}: {current.statement}
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground">
          Not attested as a primary source. Without an attestation this edition can support a claim as user-supplied evidence, but never as a
          primary source.
        </p>
      )}
      {!open ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!canEdit}>
          {current ? "Revoke attestation…" : "Attest as primary source…"}
        </Button>
      ) : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <LineField label="Reviewer" value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v })} required hint={REVIEWER_HINT} />
          <TextField
            label={current ? "Reason" : "Statement"}
            value={f.text}
            onChange={(v) => setF({ ...f, text: v })}
            required
            min={current ? undefined : MIN.statement}
            hint={current ? undefined : "Why this edition is a primary source (applies to this edition only)."}
            rows={2}
          />
          <EditError error={edit.error} onReload={edit.reload} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!f.reviewer.trim() || !f.text.trim() || edit.pending}>
              {edit.pending ? "Saving…" : current ? "Revoke" : "Attest"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
