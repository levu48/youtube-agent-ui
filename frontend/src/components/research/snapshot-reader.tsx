"use client";

import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingSkeleton } from "@/components/states";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
import { displayUrl } from "@/lib/status";

const ACQUIRED: Record<string, string> = {
  retrieved: "Retrieved by the engine",
  imported: "Imported document: not retrieved by the engine",
  fixture: "Test data: can never support real research",
};

/** A saved snapshot's text, verified against its hash by the backend. Plain text only: the
 * page is untrusted content, never rendered as HTML. */
export function SnapshotReader({
  projectId,
  snapshotId,
  onClose,
}: {
  projectId: string;
  snapshotId: string | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: qk.snapshot(projectId, snapshotId ?? ""),
    queryFn: () => api.researchSnapshot(projectId, snapshotId!),
    enabled: Boolean(snapshotId),
  });
  const s = q.data?.snapshot;
  return (
    <Dialog open={Boolean(snapshotId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
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
              <dt className="text-muted-foreground">Retrieved</dt>
              <dd>{s.retrieved_at ?? "unknown"}</dd>
              {s.publisher || s.author ? (
                <>
                  <dt className="text-muted-foreground">By</dt>
                  <dd>{[s.author, s.publisher].filter(Boolean).join(" · ")}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Snapshot</dt>
              <dd className="font-mono">
                {s.id} · sha256 {s.text_sha256.slice(0, 12)}
              </dd>
            </dl>
            <pre
              lang={s.language ?? undefined}
              tabIndex={0}
              aria-label="Snapshot text"
              className="max-h-[55vh] overflow-auto rounded-lg border bg-surface p-3 font-sans text-sm leading-6 whitespace-pre-wrap"
            >
              {q.data!.text}
            </pre>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
