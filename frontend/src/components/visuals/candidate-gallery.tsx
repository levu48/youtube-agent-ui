"use client";

import { ExternalLink, Maximize2 } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { candidateImageUrl, type VisualCandidate, type VisualsView } from "@/lib/api";
import { IMAGE_INTEGRITY, humanize, rightsPresentation } from "@/lib/status";

interface Clearance {
  candidate_id?: string;
  reviewer?: string;
  evidence?: string;
}

function clearanceFor(view: VisualsView, id: string): Clearance | null {
  const list = (view.selection as { rights_clearances?: Clearance[] } | null)?.rights_clearances ?? [];
  return list.find((c) => c.candidate_id === id) ?? null;
}

/** Labels that must never be missed: test data is never publishable, generated images are
 * synthetic. */
function Labels({ c }: { c: VisualCandidate }) {
  return (
    <div className="flex flex-wrap gap-1">
      {c.placeholder ? (
        <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-xs font-medium text-warning">Test image: never publishable</span>
      ) : null}
      {c.synthetic ? (
        <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-xs font-medium text-warning">
          Generated image{c.disclosure_label ? `: ${c.disclosure_label}` : ""}
        </span>
      ) : null}
      {c.source_type === "import" ? <span className="rounded border px-1.5 text-xs">Imported by you</span> : null}
      {!c.selectable ? <span className="rounded border px-1.5 text-xs">Not selectable ({humanize(c.status)})</span> : null}
    </div>
  );
}

function altText(c: VisualCandidate, brief: string | undefined) {
  return `${c.title ?? c.id}${brief ? ` — candidate for: ${brief}` : ""}`;
}

function Details({ c, view }: { c: VisualCandidate; view: VisualsView }) {
  const r = c.rights ?? { status: "" };
  const integrity = view.integrity[c.id];
  const cleared = clearanceFor(view, c.id);
  const evidence = cleared?.evidence?.trim();
  const local = evidence && !/^https?:\/\//i.test(evidence);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      <dt className="text-muted-foreground">Source</dt>
      <dd className="min-w-0 break-words">
        {c.source_page_url ? (
          <a href={c.source_page_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            {humanize(c.source_type)} page <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          humanize(c.source_type)
        )}
      </dd>
      <dt className="text-muted-foreground">Creator</dt>
      <dd className="min-w-0 break-words">{r.creator || "Not recorded"}</dd>
      <dt className="text-muted-foreground">Licence</dt>
      <dd className="min-w-0 break-words">
        {r.license_name ? (
          r.license_url ? (
            <a href={r.license_url} target="_blank" rel="noopener noreferrer" className="underline">
              {r.license_name}
            </a>
          ) : (
            r.license_name
          )
        ) : (
          "Not recorded"
        )}
      </dd>
      {r.credit_line ? (
        <>
          <dt className="text-muted-foreground">Credit</dt>
          <dd className="min-w-0 break-words">{r.credit_line}</dd>
        </>
      ) : null}
      {r.restrictions?.length ? (
        <>
          <dt className="text-muted-foreground">Restrictions</dt>
          <dd className="min-w-0 break-words">{r.restrictions.join("; ")}</dd>
        </>
      ) : null}
      {r.reasons?.length ? (
        <>
          <dt className="text-muted-foreground">Engine</dt>
          <dd className="min-w-0 break-words">{r.reasons.join("; ")}</dd>
        </>
      ) : null}
      {[...(c.review_reasons ?? []), ...(c.warnings ?? [])].length ? (
        <>
          <dt className="text-muted-foreground">Notes</dt>
          <dd className="min-w-0 break-words">{[...(c.review_reasons ?? []), ...(c.warnings ?? [])].join("; ")}</dd>
        </>
      ) : null}
      {integrity ? (
        <>
          <dt className="text-muted-foreground">File</dt>
          <dd className={integrity === "ok" ? "" : "font-medium text-danger"}>{IMAGE_INTEGRITY[integrity]}</dd>
        </>
      ) : null}
      {cleared ? (
        <>
          <dt className="text-muted-foreground">Clearance</dt>
          <dd className="min-w-0 break-words">
            Recorded{cleared.reviewer ? ` by ${cleared.reviewer}` : ""} (in the CLI).
            {local
              ? ` Evidence ${evidence}: ${view.evidence_inputs[evidence!] ? "found" : "missing or refused"}. The engine does not yet check whether this document changed since the clearance.`
              : ""}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function CandidateGallery({
  view,
  projectId,
  sceneId,
  brief,
  onImageError,
}: {
  view: VisualsView;
  projectId: string;
  sceneId: string;
  brief?: string;
  onImageError: (url: string) => void;
}) {
  const [open, setOpen] = useState<VisualCandidate | null>(null);
  const cands = view.candidates[sceneId] ?? [];
  if (!cands.length) return <p className="text-sm text-muted-foreground">No candidates yet.</p>;
  const openUrl = open ? candidateImageUrl(projectId, open) : null;
  return (
    <>
      <ul aria-label={`Candidates for ${sceneId}`} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cands.map((c) => {
          const url = view.catalog_trusted ? candidateImageUrl(projectId, c) : null;
          return (
            <li key={c.id} className="flex flex-col gap-2 rounded-lg border bg-surface p-2">
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-surface-muted">
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- verified bytes from the backend, by hash
                  <img src={url} alt={altText(c, brief)} loading="lazy" className="max-h-full object-contain" onError={() => onImageError(url)} />
                ) : (
                  <span className="px-2 text-center text-xs text-muted-foreground">
                    {view.catalog_trusted ? "No stored image" : "Catalogue not trusted: not shown"}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-sm font-medium break-words">{c.title ?? c.id}</p>
              <StatusBadge presentation={rightsPresentation(c.rights?.status)} prefix="Rights evidence" className="self-start" />
              <Labels c={c} />
              <Details c={c} view={view} />
              {url ? (
                <Button size="sm" variant="outline" className="mt-auto self-start" onClick={() => setOpen(c)}>
                  <Maximize2 aria-hidden /> View larger<span className="sr-only">: {c.title ?? c.id}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog open={open !== null} onOpenChange={(o) => (o ? null : setOpen(null))}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{open?.title ?? open?.id}</DialogTitle>
            <DialogDescription>
              {open?.width && open?.height ? `${open.width}×${open.height} pixels. ` : ""}
              The engine&apos;s stored image, verified against its recorded hash.
            </DialogDescription>
          </DialogHeader>
          {open && openUrl ? (
            <div className="space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- verified bytes from the backend, by hash */}
              <img src={openUrl} alt={altText(open, brief)} className="mx-auto max-h-[60vh] object-contain" onError={() => onImageError(openUrl)} />
              <Labels c={open} />
              <Details c={open} view={view} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
