import { StatusBadge } from "@/components/status-badge";
import type { VisualsView } from "@/lib/api";
import { g3Presentation, gatePresentation } from "@/lib/status";

const NOT_CERTIFIED = "not certified: recovery pending";

/** G1 and G3 exactly as this snapshot reports them. There is no G3 approval: the engine has
 * none. Since engine D-124 (owner decision 5), G3 itself requires every selection to be
 * applied and every image the draft shows to be intact and currently cleared, so its
 * findings (`visuals_not_applied`, `applied_image_problem`, ...) are shown as reported. */
export function GatesPanel({ view }: { view: VisualsView }) {
  const g1 = view.gates.g1;
  const g3 = view.gates.g3;
  const g1p = gatePresentation(g1.status);
  const pending = view.recovery_required;
  return (
    <section aria-labelledby="gates-h" className="space-y-3 rounded-[var(--radius-card)] border bg-surface p-4">
      <h2 id="gates-h" className="text-sm font-semibold">
        Gates (engine)
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge presentation={{ ...g1p, label: `G1 ${g1p.label.toLowerCase()}` }} prefix="Editorial approval" />
        <StatusBadge presentation={g3Presentation(g3.status)} prefix="Visuals gate" />
        {pending ? <span className="text-xs font-medium text-danger">({NOT_CERTIFIED})</span> : null}
      </div>
      {g3.findings.length ? (
        <ul className="space-y-1 text-sm">
          {g3.findings.map((f, i) => (
            <li key={i} className="rounded border px-2 py-1">
              <code className="text-xs">{f.code}</code> {f.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        G3 has no approval step: it is computed by the engine from the plan, the selection and the images. Nothing here
        changes a gate.
      </p>
    </section>
  );
}

export { NOT_CERTIFIED };
