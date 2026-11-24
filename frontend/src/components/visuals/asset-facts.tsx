import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { assetImageUrl, type VisualsView } from "@/lib/api";
import { BINDING_LABEL, IMAGE_INTEGRITY, RIGHTS_REASON } from "@/lib/status";

import { NOT_CERTIFIED } from "./gates-panel";

/** The engine's per-asset facts for the images the draft shows, checked as release checks
 * them. Shown as reported; never combined into another readiness. */
export function AssetFacts({
  view,
  projectId,
  onImageError,
}: {
  view: VisualsView;
  projectId: string;
  onImageError: (url: string) => void;
}) {
  if (!view.assets.length) {
    return <p className="text-sm text-muted-foreground">The draft shows no applied images yet.</p>;
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {view.assets.map((a) => {
        const url = a.image === "ok" && a.record_intact ? assetImageUrl(projectId, a) : null;
        const good = a.problem === null && a.rights_current && a.image === "ok" && a.record_intact;
        return (
          <li key={a.asset_id} className="flex gap-3 rounded-lg border bg-surface p-3 text-sm">
            <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-muted">
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- verified bytes from the backend, by hash
                <img src={url} alt={`Applied image ${a.asset_id}, shown in ${a.scene_ids.join(", ")}`} className="max-h-24 object-contain" onError={() => onImageError(url)} />
              ) : (
                <span className="px-1 text-center text-xs text-muted-foreground">No verified image to show</span>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-1.5 font-medium">
                {good ? <CheckCircle2 aria-hidden className="size-4 text-success" /> : <AlertTriangle aria-hidden className="size-4 text-warning" />}
                <code className="text-xs">{a.asset_id}</code>
                {view.recovery_required ? <span className="text-xs text-danger">({NOT_CERTIFIED})</span> : null}
              </p>
              <p className="text-xs">Scenes: {a.scene_ids.join(", ")}</p>
              <p className="text-xs">
                {a.image ? IMAGE_INTEGRITY[a.image] : "No image file recorded"}
                {a.record_intact ? "" : " · its record is not the one visuals-apply wrote"}
              </p>
              <p className="text-xs">
                Rights: {a.rights_current ? "current" : `not current — ${RIGHTS_REASON[a.rights_reason ?? ""] ?? a.rights_reason ?? "unknown"}`}
              </p>
              <p className="text-xs text-muted-foreground">
                Candidate{a.candidate_ids.length === 1 ? "" : "s"}: {a.candidate_ids.join(", ") || "none"} ({BINDING_LABEL[a.candidate_binding] ?? a.candidate_binding})
              </p>
              {a.problem ? <p className="text-xs text-warning">Release check: {a.problem}</p> : null}
              {a.credit_problems.length ? <p className="text-xs text-warning">Credits: {a.credit_problems.join("; ")}</p> : null}
              {a.fixture ? <p className="text-xs font-medium text-warning">Test image: never publishable</p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
