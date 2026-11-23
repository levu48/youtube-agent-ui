"use client";

import { useMutation } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Add a researcher-chosen URL: queue it (nothing is contacted), or fetch it now, confined to
 * its own host, which the reviewer confirms.
 *
 * The confirmation is for one host at one research revision, in one sitting: it no longer
 * counts once the URL's host or the revision changes, and every close (Cancel, Escape, the
 * close button, an outside click, or the parent closing the dialog) clears it and returns the
 * fetch mode to the safe default, queue. The typed URL is kept. */
export function AddUrlDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  networkEnabled,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  revision: string;
  networkEnabled: boolean;
  onStarted: (jobId: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [live, setLive] = useState(false);
  const [confirmedFor, setConfirmedFor] = useState<{ host: string; revision: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const id = useId();
  const host = hostOf(url.trim());
  const confirmed = live && host !== null && confirmedFor?.host === host && confirmedFor.revision === revision;

  // Any close, however it happens, ends the confirmation (adjusting state on a prop change).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setLive(false);
      setConfirmedFor(null);
      setError(null);
    }
  }

  const add = useMutation({
    mutationFn: () =>
      api.addSource(projectId, {
        expected_revision: revision,
        url: url.trim(),
        fetch: live ? "live" : "queue",
        ...(live ? { network: true, allow_hosts: host ? [host] : [] } : {}),
      }),
    onSuccess: (r) => {
      onOpenChange(false);
      setUrl("");
      setLive(false);
      setConfirmedFor(null);
      setError(null);
      onStarted(r.job_id);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a URL</DialogTitle>
          <DialogDescription>A page you chose. It becomes a candidate source, not evidence.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-url`}>Page address (https)</Label>
          <Input
            id={`${id}-url`}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setConfirmedFor(null);
            }}
            placeholder="https://"
            aria-invalid={url.trim() && !host ? true : undefined}
            aria-describedby={`${id}-url-help`}
          />
          <p id={`${id}-url-help`} className="text-xs text-muted-foreground">
            {url.trim() && !host ? "Use a full https address." : "Only https addresses on public hosts are accepted."}
          </p>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">When</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-when`} checked={!live} onChange={() => {
                setLive(false);
                setConfirmedFor(null);
              }}
            />
            Queue it: nothing is contacted now (a later search fetches it, after you confirm its host)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-when`}
              checked={live}
              onChange={() => setLive(true)}
              disabled={!networkEnabled}
            />
            Fetch it now{networkEnabled ? "" : " (network research is turned off)"}
          </label>
        </fieldset>
        {live && host ? (
          <label className="flex items-start gap-2 rounded-lg border bg-surface-muted p-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmedFor(e.target.checked ? { host, revision } : null)}
            />
            <span>
              I confirm that <span className="font-mono">{host}</span> may be contacted. Redirects to other hosts are
              refused.
            </span>
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!host || (live && !confirmed) || add.isPending}>
            <Link2 aria-hidden /> {add.isPending ? "Adding…" : live ? "Fetch page" : "Queue URL"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
