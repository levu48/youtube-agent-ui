import type { EditLimits } from "@/lib/api";

/** The engine's draft-edit limits (D-117), as the backend reports them. */
export const LIMITS: EditLimits = {
  title: 300,
  thesis_or_question: 2000,
  heading: 300,
  purpose: 2000,
  key_point: 1000,
  key_points: 50,
  claims_to_investigate: 50,
  narration: 50_000,
  summary: 2000,
  editorial_note: 2000,
  editorial_notes: 50,
};
