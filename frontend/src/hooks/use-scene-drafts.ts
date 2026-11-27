"use client";

import { useCallback, useState } from "react";

import type { ShotChoice, VisualsView } from "@/lib/api";

export function savedShots(view: VisualsView | undefined, sceneId: string): ShotChoice[] {
  return view?.selection?.scenes.find((s) => s.scene_id === sceneId)?.shots ?? [];
}

const key = (shots: ShotChoice[]) => JSON.stringify(shots);

/** One scene's shot list as the reviewer sees it. */
export interface SceneDraft {
  /** What the editor shows: the reviewer's unsaved list, or the engine's saved selection. */
  shots: ShotChoice[];
  /** The engine's saved selection in the current view. */
  saved: ShotChoice[];
  /** The shown list differs from the saved selection. */
  dirty: boolean;
  /** The saved selection changed (a save elsewhere, the CLI, a job) after the reviewer started
   * editing: their list is kept, and nothing is saved until they choose what to keep. */
  conflict: boolean;
  /** A save of this scene is running: every edit is disabled until it ends. */
  saving: boolean;
}

interface Entry {
  base: string; // the saved selection the reviewer started from
  shots: ShotChoice[];
}

/**
 * Unsaved shot lists for every scene, kept by the page (not by each scene card), so they
 * survive switching tabs and refreshes of the view. A refresh never replaces a reviewer's
 * edits: when the saved selection changed underneath them, the scene reports `conflict` and
 * the reviewer either keeps their list or loads the saved one. Nothing here decides what is
 * valid; the engine does, when the list is saved.
 */
export function useSceneDrafts(view: VisualsView | undefined) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saving, setSavingMap] = useState<Record<string, boolean>>({});

  const get = useCallback(
    (sceneId: string): SceneDraft => {
      const saved = savedShots(view, sceneId);
      const now = key(saved);
      const e = entries[sceneId];
      const busy = Boolean(saving[sceneId]);
      // No edits of the reviewer's own (or they equal the saved selection): follow the engine.
      if (!e || key(e.shots) === e.base || key(e.shots) === now) {
        return { shots: saved, saved, dirty: false, conflict: false, saving: busy };
      }
      return { shots: e.shots, saved, dirty: true, conflict: e.base !== now, saving: busy };
    },
    [entries, saving, view],
  );

  const set = useCallback(
    (sceneId: string, shots: ShotChoice[]) =>
      setEntries((all) => {
        const e = all[sceneId];
        const now = key(savedShots(view, sceneId));
        const editing = e && key(e.shots) !== e.base && key(e.shots) !== now;
        return { ...all, [sceneId]: { base: editing ? e.base : now, shots } };
      }),
    [view],
  );

  /** Drop the reviewer's list: the scene shows the saved selection again. */
  const discard = useCallback(
    (sceneId: string) =>
      setEntries((all) => {
        const rest = { ...all };
        delete rest[sceneId];
        return rest;
      }),
    [],
  );

  /** Keep the reviewer's list over a saved selection that changed meanwhile. The next save
   * then replaces the new saved selection, by the reviewer's explicit choice. */
  const keepMine = useCallback(
    (sceneId: string) =>
      setEntries((all) => (all[sceneId] ? { ...all, [sceneId]: { ...all[sceneId], base: key(savedShots(view, sceneId)) } } : all)),
    [view],
  );

  const setSaving = useCallback((sceneId: string, on: boolean) => setSavingMap((m) => ({ ...m, [sceneId]: on })), []);

  const unsaved = (view?.scenes ?? []).map((s) => s.scene_id).filter((id) => get(id).dirty);

  return { get, set, discard, keepMine, setSaving, unsaved };
}

export type SceneDrafts = ReturnType<typeof useSceneDrafts>;
