"use client";

import { useEffect, useRef, useState } from "react";

import type { EditResult, Occurrence } from "@/lib/api";

type Found = { key: string; byField: Record<string, Occurrence[]>; picks: Record<string, number | null> };

/**
 * Occurrence lookup by research-edit dry run, bound to the exact operation and revision it
 * searched (`key`). A result only counts while the form still produces that key: editing any
 * input, or the page loading a new revision, discards it and its picks. A response that arrives
 * after a newer search started, or for a key the form no longer has, is dropped, so a slow
 * earlier search can never repopulate the picker with outdated occurrences.
 */
export function useOccurrenceSearch(key: string, fields: readonly string[]) {
  const seq = useRef(0);
  const [found, setFound] = useState<Found | null>(null);
  const [inflight, setInflight] = useState<string | null>(null);

  const search = async (dryRun: () => Promise<EditResult>) => {
    const n = ++seq.current;
    const k = key;
    setInflight(k);
    try {
      const r = await dryRun();
      if (n !== seq.current) return;
      const byField: Record<string, Occurrence[]> = {};
      const picks: Record<string, number | null> = {};
      for (const f of fields) {
        byField[f] = r.occurrences.find((o) => o.op_index === 0 && o.field === f)?.occurrences ?? [];
        picks[f] = byField[f].length === 1 ? 1 : null;
      }
      setFound({ key: k, byField, picks });
    } catch {
      if (n === seq.current) setFound(null);
    } finally {
      if (n === seq.current) setInflight(null);
    }
  };

  // Any change to the form discards the result for good (not just hides it), so restoring the
  // old input never brings back a pick made for it, and abandons a search still running.
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setFound(null);
    setInflight(null);
  }
  useEffect(() => {
    seq.current++; // answers to searches started before this change are ignored
  }, [key]);
  const current = found && found.key === key ? found : null;
  return {
    /** Results for the form as it is now, or null. */
    found: current,
    occurrences: (f: string): Occurrence[] => current?.byField[f] ?? [],
    pick: (f: string): number | null => current?.picks[f] ?? null,
    setPick: (f: string, v: number | null) =>
      setFound((s) => (s && s.key === key ? { ...s, picks: { ...s.picks, [f]: v } } : s)),
    /** A search for the form as it is now is running (an outdated one does not block). */
    searching: inflight === key,
    search,
  };
}
