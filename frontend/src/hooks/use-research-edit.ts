"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, api, type EditOperation, type EditResult, type ResearchView } from "@/lib/api";
import { qk } from "@/lib/queries";

/**
 * One research-edit publication under the revision the page loaded (engine D-119). The engine
 * checks the revision and applies every operation or none; a change made meanwhile (the CLI,
 * a job, another tab) is refused as `revision_conflict` and nothing is written. The caller's
 * form keeps its input either way; on success the page shows the engine's new state.
 */
export function useResearchEdit(projectId: string, revision: string | null | undefined) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { operations: EditOperation[]; dryRun?: boolean }) =>
      api.researchEdit(projectId, { expected_revision: revision ?? "", operations: v.operations, dry_run: v.dryRun || undefined }),
    onSuccess: (r) => {
      if (r.research) {
        qc.setQueryData<ResearchView>(qk.research(projectId), r.research);
        void qc.invalidateQueries({ queryKey: ["project", projectId, "research-history"] });
      }
    },
  });
  return {
    run: (operations: EditOperation[]): Promise<EditResult> => m.mutateAsync({ operations }).then((r) => r.result),
    dryRun: (operations: EditOperation[]): Promise<EditResult> => m.mutateAsync({ operations, dryRun: true }).then((r) => r.result),
    pending: m.isPending,
    error: m.error as Error | null,
    reset: m.reset,
    reload: () => qc.invalidateQueries({ queryKey: qk.research(projectId) }),
  };
}

/** The engine's own words for a refused edit, one line per refused operation. */
export function editErrorLines(e: unknown): { conflict: boolean; message: string; lines: string[] } {
  if (!(e instanceof ApiError)) return { conflict: false, message: e instanceof Error ? e.message : "The edit failed.", lines: [] };
  const errors = Array.isArray(e.details?.errors) ? (e.details.errors as { msg?: string; code?: string | null }[]) : [];
  const lines = errors.map((x) => x.msg ?? "").filter((x) => x && x !== e.message);
  const fields = e.fields ? Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`) : [];
  return { conflict: e.code === "revision_conflict", message: e.message, lines: [...lines, ...fields] };
}
