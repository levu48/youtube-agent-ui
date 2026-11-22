"use client";

import { useMutation } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, api, type CollectParams, type CollectPreview } from "@/lib/api";
import { displayUrl } from "@/lib/status";

/**
 * Search and fetch, with an explicit confirmation of every host (engine D-118). The engine
 * previews the plan without contacting anything; the reviewer confirms that exact list; the
 * backend checks it again before the job starts, and the engine refuses any other host.
 */
export function CollectDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  revision: string;
  onStarted: (jobId: string) => void;
}) {
  const [langs, setLangs] = useState<("vi" | "en")[]>(["vi", "en"]);
  const [maxPages, setMaxPages] = useState(15);
  const [preview, setPreview] = useState<CollectPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params: CollectParams = { languages: langs, claim_ids: [], max_queries: 8, max_results_per_query: 5, max_pages: maxPages };

  const reset = () => {
    setPreview(null);
    setConfirmed(false);
    setError(null);
  };
  const check = useMutation({
    mutationFn: () => api.collectPreview(projectId, { ...params, expected_revision: revision }),
    onSuccess: (p) => {
      setPreview(p);
      setConfirmed(false);
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });
  const run = useMutation({
    mutationFn: () =>
      api.collect(projectId, {
        ...params,
        expected_revision: preview!.revision,
        network: true,
        plan_sha256: preview!.plan_sha256,
        allow_hosts: preview!.hosts,
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      reset();
      onStarted(r.job_id);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "network_not_confirmed" && e.details?.preview) {
        setPreview(e.details.preview as CollectPreview); // what changed: confirm again
        setConfirmed(false);
      }
      setError((e as Error).message);
    },
  });

  const toggle = (l: "vi" | "en") => {
    reset();
    setLangs((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Search for sources</DialogTitle>
          <DialogDescription>
            The engine searches and fetches pages for the claims. First check what it would contact; nothing is
            contacted until you confirm.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Languages</legend>
          <div className="flex gap-4">
            {(["vi", "en"] as const).map((l) => (
              <label key={l} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(l)} />
                {l === "vi" ? "Vietnamese" : "English"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          Pages to fetch at most
          <input
            type="number"
            min={0}
            max={100}
            value={maxPages}
            onChange={(e) => {
              reset();
              setMaxPages(Math.max(0, Math.min(100, Number(e.target.value) || 0)));
            }}
            className="w-20 rounded-md border bg-surface px-2 py-1"
          />
        </label>
        {preview ? (
          <section aria-labelledby="hosts-h" className="space-y-2 rounded-lg border bg-surface-muted p-3">
            <h3 id="hosts-h" className="text-sm font-semibold">
              May contact {preview.hosts.length} host{preview.hosts.length === 1 ? "" : "s"}
            </h3>
            <ul className="space-y-1 text-sm" aria-label="Hosts that may be contacted">
              {preview.hosts.map((h) => (
                <li key={h} className="font-mono text-xs">
                  {h}
                </li>
              ))}
            </ul>
            {preview.known_targets.length ? (
              <p className="text-xs text-muted-foreground">
                Includes {preview.known_targets.length} page(s) already known, such as URLs you queued:{" "}
                {preview.known_targets.slice(0, 3).map((t) => displayUrl(t.url)).join(", ")}
                {preview.known_targets.length > 3 ? "…" : ""}
              </p>
            ) : null}
            <p className="text-xs text-foreground">
              This is the most it may contact; a run may contact fewer. Any other host, or a redirect to one, is refused.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={!preview.hosts.length}
              />
              I confirm that these hosts may be contacted for this search.
            </label>
          </section>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => check.mutate()} disabled={!langs.length || check.isPending}>
            {check.isPending ? "Checking…" : preview ? "Check again" : "Check what would be contacted"}
          </Button>
          <Button onClick={() => run.mutate()} disabled={!preview || !confirmed || run.isPending}>
            <Globe aria-hidden /> {run.isPending ? "Starting…" : "Start search"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
