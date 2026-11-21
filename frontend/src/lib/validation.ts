import { SLUG_RE } from "@/lib/format";

/** Client-side mirror of backend/app/schemas.py ProjectCreate rules. */
export interface CreateFormValues {
  idea: string;
  slug: string;
  language: "vi" | "en";
  durationMinutes: string;
  audience: string;
  tone: string;
  guidance: string;
}

export type FieldErrors = Partial<Record<keyof CreateFormValues, string>>;

export const LIMITS = { idea: [5, 2000], audience: 500, tone: 200, guidance: 4000 } as const;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateCreate(v: CreateFormValues): FieldErrors {
  const e: FieldErrors = {};
  const idea = v.idea.trim();
  if (!idea) e.idea = "Enter the documentary topic.";
  else if (idea.length < LIMITS.idea[0]) e.idea = "Use at least 5 characters.";
  else if (idea.length > LIMITS.idea[1]) e.idea = "Use at most 2,000 characters.";
  else if (CONTROL.test(idea)) e.idea = "Remove control characters.";

  if (!v.slug) e.slug = "Enter a project slug.";
  else if (!SLUG_RE.test(v.slug))
    e.slug = "Use lowercase letters, digits and hyphens, starting with a letter or digit (max 63).";

  const minutes = Number(v.durationMinutes);
  if (v.durationMinutes.trim() === "" || !Number.isFinite(minutes)) e.durationMinutes = "Enter a duration in minutes.";
  else if (minutes < 1 || minutes > 60) e.durationMinutes = "Choose between 1 and 60 minutes.";
  else if (!Number.isInteger(Math.round(minutes * 60)) || Math.round(minutes * 60) !== minutes * 60)
    e.durationMinutes = "Use whole seconds (e.g. 1.5 minutes).";

  if (v.audience.trim().length > LIMITS.audience) e.audience = "Use at most 500 characters.";
  if (v.tone.trim().length > LIMITS.tone) e.tone = "Use at most 200 characters.";
  if (v.guidance.trim().length > LIMITS.guidance) e.guidance = "Use at most 4,000 characters.";
  for (const k of ["audience", "tone", "guidance"] as const) {
    if (!e[k] && CONTROL.test(v[k])) e[k] = "Remove control characters.";
  }
  return e;
}

export function minutesToSeconds(m: string): number {
  return Math.round(Number(m) * 60);
}

/** Map backend field names (API) to form field names. */
export const SERVER_FIELD: Record<string, keyof CreateFormValues> = {
  idea: "idea",
  slug: "slug",
  language: "language",
  duration_seconds: "durationMinutes",
  audience: "audience",
  tone: "tone",
  guidance: "guidance",
};
