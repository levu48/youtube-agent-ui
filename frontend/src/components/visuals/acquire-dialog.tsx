"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api, type AcquireParams, type AcquirePreviewResult, type VisualPlanScene } from "@/lib/api";
import { qk } from "@/lib/queries";

/**
 * An image search on Wikimedia Commons, bound to the engine's acquisition preview (D-122).
 * The engine previews the exact scenes, queries and hosts without contacting anything; the
 * reviewer confirms that preview, identified by its `preview_sha256`; the backend computes it
 * again before the job starts and the engine once more before any request
 * (`--expect-preview`), so a search can only run as it was shown.
 *
 * A preview belongs to one visuals revision and one set of parameters. Each check is numbered
 * and keyed by both; only the latest answer counts, and only while its key still matches.
 * Changing a parameter, checking again, closing the dialog or a new revision drops it.
 */

type Checked = { key: string; params: AcquireParams; result: AcquirePreviewResult };

function previewKey(revision: string, p: AcquireParams): string {
  return JSON.stringify([revision, [...p.scene_ids].sort(), p.max_candidates_per_scene]);
}

export function AcquireDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  scenes,
  provider,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  revision: string;
  scenes: VisualPlanScene[];
  provider: string;
  onStarted: (jobId: string) => void;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]); // empty: every planned scene
  const [limit, setLimit] = useState(4);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [confirmedSha, setConfirmedSha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const [checking, setChecking] = useState<number | null>(null);
  const params: AcquireParams = { scene_ids: chosen, max_candidates_per_scene: limit };
  const key = previewKey(revision, params);
  const current = checked && checked.key === key && checked.result.preview.revision === revision ? checked : null;
  const preview = current?.result.preview ?? null;
  const outdated = checked !== null && checked.result.preview.revision !== revision;
  const confirmed = current !== null && confirmedSha === current.result.preview_sha256;
  const searchable = scenes.filter((s) => s.search_enabled);
  const name = provider === "fixture" ? "test images (offline fixture)" : "Wikimedia Commons";

  const reset = () => {
    latest.current += 1;
    setChecking(null);
    setChecked(null);
    setConfirmedSha(null);
    setError(null);
  };
  const check = useMutation({
    mutationFn: (v: { seq: number; key: string; params: AcquireParams; revision: string }) =>
      api.acquirePreview(projectId, { ...v.params, expected_revision: v.revision }),
    onSuccess: (r, v) => {
      if (v.seq !== latest.current) return;
      setChecked({ key: v.key, params: v.params, result: r });
      setConfirmedSha(null);
      setError(null);
    },
    onError: (e, v) => {
      if (v.seq !== latest.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && ["revision_conflict", "recovery_required"].includes(e.code)) {
        void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
      }
    },
    onSettled: (_d, _e, v) => setChecking((s) => (s === v.seq ? null : s)),
  });
  const startCheck = () => {
    reset();
    const seq = latest.current;
    setChecking(seq);
    check.mutate({ seq, key, params, revision });
  };
  const run = useMutation({
    mutationFn: (c: Checked) =>
      api.acquire(projectId, {
        ...c.params,
        expected_revision: c.result.preview.revision,
        network: true,
        preview_sha256: c.result.preview_sha256,
        allow_hosts: c.result.preview.hosts,
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      reset();
      onStarted(r.job_id);
    },
    onError: (e, c) => {
      if (e instanceof ApiError && e.code === "preview_mismatch" && e.details?.preview) {
        // What would run now: shown for a new confirmation, never confirmed for the reviewer.
        const fresh = { preview: e.details.preview, preview_sha256: e.details.preview_sha256 } as AcquirePreviewResult;
        latest.current += 1;
        setChecked({ key: previewKey(fresh.preview.revision, c.params), params: c.params, result: fresh });
        setConfirmedSha(null);
      }
      if (e instanceof ApiError && ["preview_mismatch", "revision_conflict", "recovery_required"].includes(e.code)) {
        void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
      }
      setError((e as Error).message);
    },
  });

  const toggle = (id: string) => {
    reset();
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Search for images</DialogTitle>
          <DialogDescription>
            The engine searches {name} for the planned scenes. First check what it would search and contact; nothing is
            contacted until you confirm. No image is generated and nothing is paid for.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Scenes</legend>
          <p className="text-xs text-muted-foreground">
            {chosen.length ? `${chosen.length} chosen.` : "None chosen: every planned scene with search enabled."}
          </p>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
            {searchable.map((s) => (
              <label key={s.scene_id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.includes(s.scene_id)} onChange={() => toggle(s.scene_id)} />
                {s.scene_id}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          Candidates per scene at most
          <input
            type="number"
            min={1}
            max={20}
            value={limit}
            onChange={(e) => {
              reset();
              setLimit(Math.max(1, Math.min(20, Number(e.target.value) || 1)));
            }}
            className="w-20 rounded-md border bg-surface px-2 py-1"
          />
        </label>
        {preview ? (
          <section aria-labelledby="acq-hosts-h" className="space-y-2 rounded-lg border bg-surface-muted p-3">
            <h3 id="acq-hosts-h" className="text-sm font-semibold">
              May contact {preview.hosts.length} host{preview.hosts.length === 1 ? "" : "s"}
            </h3>
            <ul className="space-y-1" aria-label="Hosts that may be contacted">
              {preview.hosts.map((h) => (
                <li key={h} className="font-mono text-xs">
                  {h}
                </li>
              ))}
            </ul>
            <details className="text-xs">
              <summary className="cursor-pointer">
                {preview.queries.length} search{preview.queries.length === 1 ? "" : "es"} for {preview.scene_ids.length} scene
                {preview.scene_ids.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5" aria-label="Searches">
                {preview.queries.map((q) => (
                  <li key={q.scene_id}>
                    <span className="text-muted-foreground">{q.scene_id}:</span> {q.query}
                  </li>
                ))}
              </ul>
            </details>
            <p className="text-xs">
              At most {preview.max_candidates_per_scene} candidate(s) per scene; any other host, or a redirect to one, is
              refused. Preview <code className="font-mono">{current!.result.preview_sha256.slice(0, 12)}</code>.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmedSha(e.target.checked ? current!.result.preview_sha256 : null)}
                disabled={!preview.hosts.length}
              />
              I confirm this search, and that these hosts may be contacted for it.
            </label>
            {!preview.hosts.length ? <p className="text-xs text-warning">There is nothing to search for these scenes.</p> : null}
          </section>
        ) : null}
        {outdated ? (
          <p role="alert" className="text-sm text-warning">
            The visuals changed since this check (a job, the CLI or another tab). The previous preview no longer applies:
            check again what would be searched.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={startCheck} disabled={checking !== null || !searchable.length}>
            {checking !== null ? "Checking…" : checked ? "Check again" : "Check what would be searched"}
          </Button>
          <Button onClick={() => current && run.mutate(current)} disabled={!current || !confirmed || checking !== null || run.isPending}>
            <Globe aria-hidden /> {run.isPending ? "Starting…" : "Start search"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
