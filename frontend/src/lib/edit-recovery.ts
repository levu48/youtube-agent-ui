/**
 * Per-tab recovery of unsaved draft edits (sessionStorage). Browser Back/Forward inside the
 * app cannot be intercepted reliably with the Next.js App Router, so instead of warning we
 * make leaving harmless: the unsaved edits, and the draft version they were based on, are
 * kept for this tab and restored when the draft page opens again. Nothing here is sent to
 * the engine until the reviewer presses Save, and the engine still checks the revision.
 */
import type { EditableDraft } from "@/lib/api";
import type { Edits } from "@/lib/draft-edit";

export interface StoredEdits {
  v: 1;
  savedAt: string;
  base: EditableDraft;
  edits: Edits;
}

const key = (projectId: string) => `yta:unsaved-draft-edits:${projectId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadEdits(projectId: string): StoredEdits | null {
  try {
    const raw = storage()?.getItem(key(projectId));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredEdits;
    const ok =
      s?.v === 1 &&
      typeof s.savedAt === "string" &&
      typeof s.base?.editing?.revision === "string" &&
      typeof s.edits?.outline?.sections === "object" &&
      typeof s.edits?.script?.sections === "object";
    return ok ? s : null;
  } catch {
    return null;
  }
}

export function storeEdits(projectId: string, base: EditableDraft, edits: Edits): void {
  try {
    const s: StoredEdits = { v: 1, savedAt: new Date().toISOString(), base, edits };
    storage()?.setItem(key(projectId), JSON.stringify(s));
  } catch {
    // Storage full or blocked: the beforeunload/link guard still applies.
  }
}

export function clearEdits(projectId: string): void {
  try {
    storage()?.removeItem(key(projectId));
  } catch {
    // ignore
  }
}
