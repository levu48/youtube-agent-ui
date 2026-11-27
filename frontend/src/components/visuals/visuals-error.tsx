"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { visualsErrorLines } from "@/hooks/use-visuals-edit";

/** A refused visuals edit or apply, in the engine's words. A conflict keeps the input and
 * offers to load the latest visuals; nothing is retried automatically. */
export function VisualsError({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (!error) return null;
  const { conflict, message, lines } = visualsErrorLines(error);
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
      <p className="font-medium">
        {conflict ? "The visuals changed since you loaded them (the CLI, a job or another tab). Nothing was saved." : message}
      </p>
      {lines.length ? (
        <ul className="list-disc pl-5">
          {lines.map((l, i) => (
            <li key={i} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-foreground">Your input is kept. Load the latest visuals, check them, then save again.</span>
          <Button size="sm" variant="outline" onClick={onReload}>
            <RefreshCw aria-hidden /> Reload latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
