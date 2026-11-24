import { AlertOctagon, Info } from "lucide-react";

import type { VisualsView } from "@/lib/api";

/** An interrupted engine publication. While the engine reports `recovery_required`, nothing on
 * the page is certified and every action is disabled; the CLI recovers it (the engine's
 * `next_action`, shown as text). A pending production package journal alone writes only
 * `output/`: it is noted, and blocks nothing here. */
export function RecoveryBanner({ view }: { view: VisualsView }) {
  if (view.recovery_required) {
    return (
      <section
        role="alert"
        aria-labelledby="recovery-h"
        className="space-y-2 rounded-[var(--radius-card)] border border-red-300 bg-red-50 p-4 text-sm text-danger"
      >
        <h2 id="recovery-h" className="flex items-center gap-2 text-base font-semibold">
          <AlertOctagon aria-hidden className="size-5" /> An interrupted publication must be recovered first
        </h2>
        <p className="text-red-900">
          An engine write of this project was interrupted. Until it is recovered, nothing shown here is certified: the
          gates, apply states and image facts describe the files as they are, mid-publication. Every action on this page
          is disabled. Recover it in the CLI, then check the visuals again.
        </p>
        <ul className="space-y-2 text-red-900">
          {view.pending_journals.map((f, i) => (
            <li key={i} className="rounded border border-red-200 bg-white/60 p-2">
              <p>{f.detail}</p>
              {f.next_action ? (
                <p className="mt-1">
                  Next step (CLI): <code className="font-mono text-xs break-all">{f.next_action}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (view.pending_journals.length) {
    return (
      <p className="flex items-start gap-2 rounded-lg border bg-surface-muted p-3 text-sm">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          A production package publication is pending recovery. It writes only the package output, so nothing on this page
          is affected.{" "}
          {view.pending_journals[0].next_action ? (
            <code className="font-mono text-xs break-all">{view.pending_journals[0].next_action}</code>
          ) : null}
        </span>
      </p>
    );
  }
  return null;
}

/** The reason every action is disabled, or null. */
export function blockReason(view: VisualsView): string | null {
  if (view.recovery_required) return "An interrupted publication must be recovered first (see the banner above).";
  if (view.active_job_id) return "A job is running for this project.";
  return null;
}
