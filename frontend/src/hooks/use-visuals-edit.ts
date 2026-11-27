"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, api, type VisualsEditResult, type VisualsOperation, type VisualsView } from "@/lib/api";
import { qk } from "@/lib/queries";

/** Codes after which the page must show the engine's current state instead of the old one. */
const REFRESH = new Set(["revision_conflict", "recovery_required", "image_integrity", "image_changed", "engine_conflict", "history_tampered", "catalog_untrusted"]);

/**
 * One `visuals-edit` publication under the revision the page loaded (engine D-123). The engine
 * checks the revision, verifies every image it selects or clears under its lock, and applies
 * every operation or none. A change made meanwhile (the CLI, a job, another tab) is refused and
 * nothing is written; the caller's form keeps its input. On success the page shows the
 * engine's new state from the same response.
 */
export function useVisualsEdit(projectId: string, revision: string | null | undefined) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (operations: VisualsOperation[]) =>
      api.visualsEdit(projectId, { expected_revision: revision ?? "", operations }),
    onSuccess: (r) => {
      if (r.visuals) qc.setQueryData<VisualsView>(qk.visuals(projectId), r.visuals);
    },
    onError: (e) => {
      if (e instanceof ApiError && REFRESH.has(e.code)) void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
    },
  });
  return {
    run: (operations: VisualsOperation[]): Promise<VisualsEditResult> => m.mutateAsync(operations).then((r) => r.result),
    pending: m.isPending,
    error: m.error as Error | null,
    reset: m.reset,
    reload: () => qc.invalidateQueries({ queryKey: qk.visuals(projectId) }),
  };
}

/** The engine's own words for a refused visuals edit or apply, one line per item. */
export function visualsErrorLines(e: unknown): { conflict: boolean; message: string; lines: string[] } {
  if (!(e instanceof ApiError)) return { conflict: false, message: e instanceof Error ? e.message : "The edit failed.", lines: [] };
  const d = e.details ?? {};
  const items = Array.isArray(d.errors) ? (d.errors as unknown[]) : [];
  const lines = items
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as { msg?: unknown }).msg ?? "") : ""))
    .filter((x) => x && x !== e.message);
  const conflicts = Array.isArray(d.conflicts) ? (d.conflicts as unknown[]).map(String) : [];
  const fields = Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`);
  return { conflict: e.code === "revision_conflict", message: e.message, lines: [...lines, ...conflicts, ...fields] };
}
