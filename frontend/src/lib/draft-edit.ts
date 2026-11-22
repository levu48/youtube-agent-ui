/**
 * Pure editing logic for the draft workspace. Nothing here is authoritative: the engine's
 * draft-edit validates and publishes every edit. These helpers only track what the reviewer
 * typed, show field problems early, and build the minimal patch the engine receives.
 */
import type { DraftPatch, EditLimits, Outline, Script } from "@/lib/api";

/** Raw input. List fields hold one item per line. Absent key = untouched. */
export interface OutlineSectionEdits {
  heading?: string;
  purpose?: string;
  key_points?: string;
  claims_to_investigate?: string;
}
export interface ScriptSectionEdits {
  heading?: string;
  narration?: string;
  summary?: string;
  editorial_notes?: string;
}
export interface Edits {
  outline: { title?: string; thesis_or_question?: string; sections: Record<string, OutlineSectionEdits> };
  script: { sections: Record<string, ScriptSectionEdits> };
}

export const emptyEdits = (): Edits => ({ outline: { sections: {} }, script: { sections: {} } });

export const OUTLINE_LIST_FIELDS = ["key_points", "claims_to_investigate"] as const;
export const SCRIPT_LIST_FIELDS = ["editorial_notes"] as const;

export function listToText(items: readonly string[] | null | undefined): string {
  return (items ?? []).join("\n");
}

export function textToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

type Field = { kind: "text" | "list"; base: string | readonly string[] | null | undefined; value: string | undefined };

function changed({ kind, base, value }: Field): boolean {
  if (value === undefined) return false;
  if (kind === "list") {
    const a = textToList(value);
    const b = (base as readonly string[] | null | undefined) ?? [];
    return a.length !== b.length || a.some((x, i) => x !== b[i]);
  }
  return value.trim() !== ((base as string | null | undefined) ?? "").trim();
}

function outlineSection(outline: Outline, id: string) {
  return outline.sections.find((s) => s.id === id);
}

function scriptSection(script: Script, id: string) {
  return script.sections.find((s) => s.outline_section_id === id);
}

/** The engine patch: only fields whose value differs from the loaded draft. */
export function buildPatch(edits: Edits, outline: Outline | null, script: Script | null): DraftPatch {
  const patch: DraftPatch = {};
  if (outline) {
    const o: NonNullable<DraftPatch["outline"]> = {};
    if (changed({ kind: "text", base: outline.title, value: edits.outline.title })) o.title = edits.outline.title!.trim();
    if (changed({ kind: "text", base: outline.thesis_or_question, value: edits.outline.thesis_or_question }))
      o.thesis_or_question = edits.outline.thesis_or_question!.trim();
    const sections = [];
    for (const sec of outline.sections) {
      const e = edits.outline.sections[sec.id];
      if (!e) continue;
      const p: NonNullable<NonNullable<DraftPatch["outline"]>["sections"]>[number] = { id: sec.id };
      if (changed({ kind: "text", base: sec.heading, value: e.heading })) p.heading = e.heading!.trim();
      if (changed({ kind: "text", base: sec.purpose, value: e.purpose })) p.purpose = e.purpose!.trim();
      for (const f of OUTLINE_LIST_FIELDS)
        if (changed({ kind: "list", base: sec[f], value: e[f] })) p[f] = textToList(e[f]!);
      if (Object.keys(p).length > 1) sections.push(p);
    }
    if (sections.length) o.sections = sections;
    if (Object.keys(o).length) patch.outline = o;
  }
  if (script) {
    const sections = [];
    for (const sec of script.sections) {
      const e = edits.script.sections[sec.outline_section_id];
      if (!e) continue;
      const p: NonNullable<DraftPatch["script"]>["sections"][number] = { outline_section_id: sec.outline_section_id };
      if (changed({ kind: "text", base: sec.heading, value: e.heading })) p.heading = e.heading!.trim();
      // Narration keeps its paragraphs; the engine normalises whitespace like generation.
      if (changed({ kind: "text", base: sec.narration, value: e.narration })) p.narration = e.narration!;
      if (changed({ kind: "text", base: sec.summary, value: e.summary })) p.summary = e.summary!.trim();
      if (changed({ kind: "list", base: sec.editorial_notes, value: e.editorial_notes }))
        p.editorial_notes = textToList(e.editorial_notes!);
      if (Object.keys(p).length > 1) sections.push(p);
    }
    if (sections.length) patch.script = { sections };
  }
  return patch;
}

export function isEmptyPatch(p: DraftPatch): boolean {
  return !p.outline && !p.script;
}

/** IDs of sections with changes, for "Edited" markers in the navigator. */
export function editedSections(patch: DraftPatch): { outline: Set<string>; script: Set<string> } {
  return {
    outline: new Set((patch.outline?.sections ?? []).map((s) => s.id)),
    script: new Set((patch.script?.sections ?? []).map((s) => s.outline_section_id)),
  };
}

/** Field key, e.g. "outline.title", "outline.sec-02.key_points", "script.sec-02.narration". */
export type FieldErrors = Record<string, string>;

function checkText(errors: FieldErrors, key: string, v: string, max: number, required: boolean) {
  const t = v.trim();
  if (required && !t) errors[key] = "This field cannot be empty.";
  else if (t.length > max) errors[key] = `Use at most ${max.toLocaleString("en")} characters (now ${t.length.toLocaleString("en")}).`;
}

function checkList(errors: FieldErrors, key: string, v: string, maxItems: number, maxLen: number, min: number) {
  const items = textToList(v);
  if (items.length < min) errors[key] = "Add at least one item (one per line).";
  else if (items.length > maxItems) errors[key] = `Use at most ${maxItems} items (now ${items.length}).`;
  else {
    const long = items.findIndex((x) => x.length > maxLen);
    if (long >= 0) errors[key] = `Item ${long + 1} is longer than ${maxLen.toLocaleString("en")} characters.`;
  }
}

/** Early checks matching the engine's limits. The engine validates again on save. */
export function validatePatch(patch: DraftPatch, limits: EditLimits): FieldErrors {
  const errors: FieldErrors = {};
  const o = patch.outline;
  if (o?.title !== undefined) checkText(errors, "outline.title", o.title, limits.title, true);
  if (o?.thesis_or_question !== undefined)
    checkText(errors, "outline.thesis_or_question", o.thesis_or_question, limits.thesis_or_question, true);
  for (const s of o?.sections ?? []) {
    if (s.heading !== undefined) checkText(errors, `outline.${s.id}.heading`, s.heading, limits.heading, true);
    if (s.purpose !== undefined) checkText(errors, `outline.${s.id}.purpose`, s.purpose, limits.purpose, true);
    if (s.key_points !== undefined)
      checkList(errors, `outline.${s.id}.key_points`, s.key_points.join("\n"), limits.key_points, limits.key_point, 1);
    if (s.claims_to_investigate !== undefined)
      checkList(
        errors,
        `outline.${s.id}.claims_to_investigate`,
        s.claims_to_investigate.join("\n"),
        limits.claims_to_investigate,
        limits.key_point,
        0,
      );
  }
  for (const s of patch.script?.sections ?? []) {
    const id = s.outline_section_id;
    if (s.heading !== undefined) checkText(errors, `script.${id}.heading`, s.heading, limits.heading, true);
    if (s.narration !== undefined) {
      checkText(errors, `script.${id}.narration`, s.narration, limits.narration, true);
      if (!errors[`script.${id}.narration`] && !/\p{L}/u.test(s.narration))
        errors[`script.${id}.narration`] = "Narration must contain words.";
    }
    if (s.summary !== undefined) checkText(errors, `script.${id}.summary`, s.summary, limits.summary, false);
    if (s.editorial_notes !== undefined)
      checkList(
        errors,
        `script.${id}.editorial_notes`,
        s.editorial_notes.join("\n"),
        limits.editorial_notes,
        limits.editorial_note,
        0,
      );
  }
  return errors;
}

const LABELS: Record<string, string> = {
  title: "Title",
  thesis_or_question: "Central question",
  heading: "Heading",
  purpose: "Purpose",
  key_points: "Key points",
  claims_to_investigate: "Claims to investigate",
  narration: "Narration",
  summary: "Summary",
  editorial_notes: "Editorial notes",
};

/** Plain-text copy of unsaved edits, so nothing is lost when the draft changed meanwhile. */
export function editsAsText(patch: DraftPatch, outline: Outline | null, script: Script | null): string {
  const out: string[] = [];
  const val = (v: string | string[]) => (Array.isArray(v) ? v.map((x) => `- ${x}`).join("\n") : v);
  const o = patch.outline;
  for (const k of ["title", "thesis_or_question"] as const)
    if (o?.[k] !== undefined) out.push(`[Outline] ${LABELS[k]}:\n${val(o[k]!)}`);
  for (const s of o?.sections ?? []) {
    const name = (outline && outlineSection(outline, s.id)?.heading) || s.id;
    for (const [k, v] of Object.entries(s))
      if (k !== "id") out.push(`[Outline · ${name} (${s.id})] ${LABELS[k] ?? k}:\n${val(v as string | string[])}`);
  }
  for (const s of patch.script?.sections ?? []) {
    const id = s.outline_section_id;
    const name = (script && scriptSection(script, id)?.heading) || id;
    for (const [k, v] of Object.entries(s))
      if (k !== "outline_section_id") out.push(`[Script · ${name} (${id})] ${LABELS[k] ?? k}:\n${val(v as string | string[])}`);
  }
  return out.join("\n\n");
}

/** Keys of every changed field ("outline.title", "script.sec-02.narration", …). */
export function changedKeys(patch: DraftPatch): Set<string> {
  const keys = new Set<string>();
  for (const k of ["title", "thesis_or_question"] as const) if (patch.outline?.[k] !== undefined) keys.add(`outline.${k}`);
  for (const s of patch.outline?.sections ?? [])
    for (const k of Object.keys(s)) if (k !== "id") keys.add(`outline.${s.id}.${k}`);
  for (const s of patch.script?.sections ?? [])
    for (const k of Object.keys(s)) if (k !== "outline_section_id") keys.add(`script.${s.outline_section_id}.${k}`);
  return keys;
}

/**
 * What is still unsaved after a save succeeded. `submitted` is the raw input the save was
 * built from; anything typed while the request was pending differs from it and is kept, so
 * it layers onto the newly saved draft instead of being dropped.
 */
export function editsAfterSave(current: Edits, submitted: Edits): Edits {
  const rest = <T extends object>(cur: T, sub: T | undefined): T => {
    const out = {} as T;
    for (const [k, v] of Object.entries(cur) as [keyof T, T[keyof T]][])
      if (v !== undefined && (!sub || sub[k] !== v)) out[k] = v;
    return out;
  };
  const sections = <T extends object>(cur: Record<string, T>, sub: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [id, e] of Object.entries(cur)) {
      const r = rest(e, sub[id]);
      if (Object.keys(r).length) out[id] = r;
    }
    return out;
  };
  const { sections: curOutline, ...curDoc } = current.outline;
  const { sections: subOutline, ...subDoc } = submitted.outline;
  return {
    outline: { ...rest(curDoc, subDoc), sections: sections(curOutline, subOutline) },
    script: { sections: sections(current.script.sections, submitted.script.sections) },
  };
}

export function hasRawEdits(e: Edits): boolean {
  return (
    e.outline.title !== undefined ||
    e.outline.thesis_or_question !== undefined ||
    Object.keys(e.outline.sections).length > 0 ||
    Object.keys(e.script.sections).length > 0
  );
}
