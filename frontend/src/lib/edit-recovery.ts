/**
 * Per-tab recovery of unsaved draft edits. Browser Back/Forward inside the app cannot be
 * intercepted reliably with the Next.js App Router, so instead of warning we make leaving
 * harmless: the unsaved edits, and the draft version they were based on, are kept and
 * restored when the draft page opens again. Nothing here is sent to the engine until the
 * reviewer presses Save, and the engine still checks the revision.
 *
 * Two copies are kept:
 * - in memory, for this tab's JavaScript session. In-app navigation (including Back and
 *   Forward) keeps it, and it cannot fail;
 * - in sessionStorage, which also survives a reload or a crash of the page. When the browser
 *   refuses to store it (blocked storage, quota), the failure is reported through
 *   `useBackupFailed` so the page can warn that only the in-memory copy exists.
 */
import { useSyncExternalStore } from "react";

import type { Outline, Script } from "@/lib/api";
import type { Edits } from "@/lib/draft-edit";

/** Only what is needed to rebuild the editing base: no Markdown, checks or job data. */
export interface EditBaseSnapshot {
  revision: string;
  outline: Outline | null;
  script: Script | null;
}

export interface StoredEdits extends EditBaseSnapshot {
  v: 2;
  savedAt: string;
  edits: Edits;
}

const key = (projectId: string) => `yta:unsaved-draft-edits:${projectId}`;
const memory = new Map<string, StoredEdits>();

// Whether the last sessionStorage write failed, per project; observed by the draft page.
const failed = new Set<string>();
const listeners = new Set<() => void>();
function setFailed(projectId: string, value: boolean) {
  if (failed.has(projectId) === value) return;
  if (value) failed.add(projectId);
  else failed.delete(projectId);
  listeners.forEach((l) => l());
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function valid(s: unknown): s is StoredEdits {
  const x = s as StoredEdits | null;
  return (
    x?.v === 2 &&
    typeof x.savedAt === "string" &&
    typeof x.revision === "string" &&
    typeof x.edits?.outline?.sections === "object" &&
    typeof x.edits?.script?.sections === "object"
  );
}

export function loadEdits(projectId: string): StoredEdits | null {
  const inMemory = memory.get(projectId);
  if (inMemory) return inMemory;
  try {
    const raw = storage()?.getItem(key(projectId));
    if (!raw) return null;
    const s: unknown = JSON.parse(raw);
    return valid(s) ? s : null;
  } catch {
    return null;
  }
}

/** Keeps the edits; returns false when only the in-memory copy could be kept. */
export function storeEdits(projectId: string, base: EditBaseSnapshot, edits: Edits): boolean {
  const s: StoredEdits = { v: 2, savedAt: new Date().toISOString(), ...base, edits };
  memory.set(projectId, s);
  let ok = false;
  try {
    const st = storage();
    if (st) {
      st.setItem(key(projectId), JSON.stringify(s));
      ok = true;
    }
  } catch {
    ok = false;
  }
  setFailed(projectId, !ok);
  return ok;
}

export function clearEdits(projectId: string): void {
  memory.delete(projectId);
  try {
    storage()?.removeItem(key(projectId));
  } catch {
    // Nothing stored durably, or storage blocked: the in-memory copy is gone either way.
  }
  setFailed(projectId, false);
}

/** True while the unsaved edits of this project could not be written to sessionStorage. */
export function useBackupFailed(projectId: string): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => failed.has(projectId),
    () => false,
  );
}
