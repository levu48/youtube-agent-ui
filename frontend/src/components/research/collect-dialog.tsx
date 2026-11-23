"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useRef, useState } from "react";

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
import { qk } from "@/lib/queries";
import { displayUrl } from "@/lib/status";

/**
 * Search and fetch, with an explicit confirmation of every host (engine D-118). The engine
 * previews the plan without contacting anything; the reviewer confirms that exact list; the
 * backend checks it again before the job starts, and the engine refuses any other host.
 *
 * A preview belongs to one research revision. When the parent's revision changes (a job,
 * the CLI or another tab changed the research), the preview and its confirmation no longer
 * count: both are derived from the current revision, so a stale list can never be confirmed.
 *
 * The same holds for the parameters: each check is numbered and keyed by the revision and the
 * exact parameters it was sent with. Only the latest check's answer is kept, and only while
 * its key matches the current revision and parameters; changing a parameter, checking again
 * or closing the dialog drops any answer still in flight.
 */

type Checked = { key: string; params: CollectParams; preview: CollectPreview };

function previewKey(revision: string, p: CollectParams): string {
  return JSON.stringify([revision, [...p.languages].sort(), p.claim_ids, p.max_queries, p.max_results_per_query, p.max_pages]);
}
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
  const qc = useQueryClient();
  const [checked, setChecked] = useState<Checked | null>(null);
  // The plan the reviewer ticked; it counts only for that exact plan.
  const [confirmedPlan, setConfirmedPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Number of the latest check; an answer to any earlier one is ignored.
  const latest = useRef(0);
  const [checking, setChecking] = useState<number | null>(null); // the check in flight, if current
  const params: CollectParams = { languages: langs, claim_ids: [], max_queries: 8, max_results_per_query: 5, max_pages: maxPages };
  const key = previewKey(revision, params);
  const current =
    checked && checked.key === key && checked.preview.revision === revision ? checked : null;
  const preview = current?.preview ?? null;
  // Only a research change is explained: a parameter change already cleared the preview.
  const outdated = checked !== null && checked.preview.revision !== revision;
  const confirmed = preview !== null && confirmedPlan === preview.plan_sha256;

  const reset = () => {
    latest.current += 1; // drop any check still in flight
    setChecking(null);
    setChecked(null);
    setConfirmedPlan(null);
    setError(null);
  };
  const check = useMutation({
    mutationFn: (v: { seq: number; key: string; params: CollectParams; revision: string }) =>
      api.collectPreview(projectId, { ...v.params, expected_revision: v.revision }),
    onSuccess: (p, v) => {
      if (v.seq !== latest.current) return; // a later check, a parameter change or a close
      setChecked({ key: v.key, params: v.params, preview: p });
      setConfirmedPlan(null);
      setError(null);
    },
    onError: (e, v) => {
      if (v.seq === latest.current) setError((e as Error).message);
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
      api.collect(projectId, {
        ...c.params,
        expected_revision: c.preview.revision,
        network: true,
        plan_sha256: c.preview.plan_sha256,
        allow_hosts: c.preview.hosts,
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      reset();
      onStarted(r.job_id);
    },
    onError: (e, c) => {
      if (e instanceof ApiError && e.code === "network_not_confirmed" && e.details?.preview) {
        const fresh = e.details.preview as CollectPreview; // what changed: confirm again
        latest.current += 1;
        setChecked({ key: previewKey(fresh.revision, c.params), params: c.params, preview: fresh });
        setConfirmedPlan(null);
        // The research may have a newer revision: reload it so this preview can count.
        void qc.invalidateQueries({ queryKey: qk.research(projectId) });
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
                onChange={(e) => setConfirmedPlan(e.target.checked ? preview.plan_sha256 : null)}
                disabled={!preview.hosts.length}
              />
              I confirm that these hosts may be contacted for this search.
            </label>
          </section>
        ) : null}
        {outdated ? (
          <p role="alert" className="text-sm text-warning">
            The research changed since this check (a job, the CLI or another tab). The previous list of hosts no longer
            applies: check again what would be contacted.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={startCheck} disabled={!langs.length || checking !== null}>
            {checking !== null ? "Checking…" : checked ? "Check again" : "Check what would be contacted"}
          </Button>
          <Button
            onClick={() => current && run.mutate(current)}
            disabled={!current || !confirmed || checking !== null || run.isPending}
          >
            <Globe aria-hidden /> {run.isPending ? "Starting…" : "Start search"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
