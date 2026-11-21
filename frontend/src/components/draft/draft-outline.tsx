import type { Outline } from "@/lib/api";
import { formatClock } from "@/lib/format";

export function sectionAnchor(id: string): string {
  return `section-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function DraftOutline({ outline }: { outline: Outline }) {
  return (
    <nav aria-labelledby="outline-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="outline-title" className="text-lg font-semibold">
          Outline
        </h2>
        {outline.thesis_or_question ? (
          <p className="text-sm text-muted-foreground" lang={outline.language ?? undefined}>
            <span className="font-medium text-foreground">Central question: </span>
            {outline.thesis_or_question}
          </p>
        ) : null}
      </div>
      <ol className="space-y-2" lang={outline.language ?? undefined}>
        {outline.sections.map((s, i) => (
          <li key={s.id} className="rounded-lg border bg-surface">
            <a
              href={`#${sectionAnchor(s.id)}`}
              className="block rounded-t-lg px-3 py-2 font-medium hover:bg-surface-muted"
            >
              <span className="text-muted-foreground tabular-nums">{i + 1}. </span>
              {s.heading || s.id}
              {s.estimated_duration_seconds ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ~{formatClock(s.estimated_duration_seconds)}
                </span>
              ) : null}
            </a>
            {s.purpose || s.key_points.length || s.claims_to_investigate.length ? (
              <details className="border-t px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Details</summary>
                <div className="mt-2 space-y-2">
                  {s.role ? <p className="text-xs text-muted-foreground">Role: {s.role}</p> : null}
                  {s.purpose ? <p>{s.purpose}</p> : null}
                  {s.key_points.length ? (
                    <div>
                      <p className="font-medium">Key points</p>
                      <ul className="list-disc space-y-0.5 pl-5">
                        {s.key_points.map((k, j) => (
                          <li key={j}>{k}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {s.claims_to_investigate.length ? (
                    <div>
                      <p className="font-medium">Claims to investigate (unverified)</p>
                      <ul className="list-disc space-y-0.5 pl-5">
                        {s.claims_to_investigate.map((k, j) => (
                          <li key={j}>{k}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
