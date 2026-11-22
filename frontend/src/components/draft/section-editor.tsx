"use client";

import { Flag } from "lucide-react";
import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { EditLimits, Outline, OutlineSection, ScriptSection } from "@/lib/api";
import {
  listToText,
  type FieldErrors,
  type OutlineSectionEdits,
  type ScriptSectionEdits,
} from "@/lib/draft-edit";
import { formatClock } from "@/lib/format";
import { humanize } from "@/lib/status";

const FLAG_LABEL: Record<string, string> = {
  source_needed: "Source needed",
  interpretation: "Interpretation",
  quotation_needs_verification: "Quotation: verify",
  visual_brief_needed: "Visual brief: check",
};

export function EditField({
  label,
  value,
  onChange,
  readOnly,
  error,
  help,
  max,
  rows,
  lang,
  changed,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  error?: string;
  help?: string;
  max?: number;
  /** Multi-line when set. */
  rows?: number;
  lang?: string;
  changed?: boolean;
}) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : null, help || max ? `${id}-help` : null].filter(Boolean).join(" ");
  const common = {
    id,
    value,
    readOnly,
    lang,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {label}
        {changed ? (
          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-xs font-medium text-warning">
            Unsaved
          </span>
        ) : null}
      </Label>
      {rows ? (
        <Textarea {...common} rows={rows} className="text-base leading-7 read-only:bg-surface-muted" />
      ) : (
        <Input {...common} className="read-only:bg-surface-muted" />
      )}
      {help || max ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
          {help && max ? " · " : ""}
          {max ? `${value.trim().length.toLocaleString("en")} / ${max.toLocaleString("en")} characters` : ""}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const pick = (edit: string | undefined, base: string) => (edit !== undefined ? edit : base);

export function OutlineDocumentEditor({
  outline,
  edits,
  onChange,
  errors,
  readOnly,
  limits,
  changed,
}: {
  outline: Outline;
  edits: { title?: string; thesis_or_question?: string };
  onChange: (field: "title" | "thesis_or_question", v: string) => void;
  errors: FieldErrors;
  readOnly: boolean;
  limits: EditLimits;
  changed: Set<string>;
}) {
  const lang = outline.language ?? undefined;
  const title = pick(edits.title, outline.title);
  const thesis = pick(edits.thesis_or_question, outline.thesis_or_question ?? "");
  return (
    <div className="space-y-5">
      <h3 className="text-lg font-semibold">Documentary</h3>
      <EditField
        label="Title"
        value={title}
        onChange={(v) => onChange("title", v)}
        readOnly={readOnly}
        error={errors["outline.title"]}
        help="Also used as the script and storyboard title."
        max={limits.title}
        lang={lang}
        changed={changed.has("outline.title")}
      />
      <EditField
        label="Central question"
        value={thesis}
        onChange={(v) => onChange("thesis_or_question", v)}
        readOnly={readOnly}
        error={errors["outline.thesis_or_question"]}
        max={limits.thesis_or_question}
        rows={3}
        lang={lang}
        changed={changed.has("outline.thesis_or_question")}
      />
    </div>
  );
}

export function OutlineSectionEditor({
  section,
  index,
  edits,
  onChange,
  errors,
  readOnly,
  limits,
  lang,
  changed,
}: {
  section: OutlineSection;
  index: number;
  edits: OutlineSectionEdits;
  onChange: (field: keyof OutlineSectionEdits, v: string) => void;
  errors: FieldErrors;
  readOnly: boolean;
  limits: EditLimits;
  lang?: string;
  changed: Set<string>;
}) {
  const key = (f: string) => `outline.${section.id}.${f}`;
  const base = {
    heading: section.heading,
    purpose: section.purpose ?? "",
    key_points: listToText(section.key_points),
    claims_to_investigate: listToText(section.claims_to_investigate),
  };
  const val = (f: keyof OutlineSectionEdits) => pick(edits[f], base[f]);
  const isChanged = (f: keyof OutlineSectionEdits) => changed.has(key(f));
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">
          {index + 1}. {val("heading") || section.id}
        </h3>
        <p className="text-xs text-muted-foreground">
          Section ID <code>{section.id}</code>
          {section.role ? ` · role ${section.role}` : ""}
          {section.estimated_duration_seconds ? ` · ~${formatClock(section.estimated_duration_seconds)} planned` : ""}
        </p>
      </div>
      <EditField label="Heading" value={val("heading")} onChange={(v) => onChange("heading", v)} readOnly={readOnly} error={errors[key("heading")]} max={limits.heading} lang={lang} changed={isChanged("heading")} />
      <EditField label="Purpose" value={val("purpose")} onChange={(v) => onChange("purpose", v)} readOnly={readOnly} error={errors[key("purpose")]} max={limits.purpose} rows={3} lang={lang} changed={isChanged("purpose")} />
      <EditField
        label="Key points"
        value={val("key_points")}
        onChange={(v) => onChange("key_points", v)}
        readOnly={readOnly}
        error={errors[key("key_points")]}
        help={`One per line, at least one, at most ${limits.key_points}.`}
        rows={5}
        lang={lang}
        changed={isChanged("key_points")}
      />
      <EditField
        label="Claims to investigate (unverified)"
        value={val("claims_to_investigate")}
        onChange={(v) => onChange("claims_to_investigate", v)}
        readOnly={readOnly}
        error={errors[key("claims_to_investigate")]}
        help={`One per line, at most ${limits.claims_to_investigate}. These are leads for research, not facts.`}
        rows={4}
        lang={lang}
        changed={isChanged("claims_to_investigate")}
      />
    </div>
  );
}

export function ScriptSectionEditor({
  section,
  index,
  edits,
  onChange,
  errors,
  readOnly,
  limits,
  lang,
  changed,
}: {
  section: ScriptSection;
  index: number;
  edits: ScriptSectionEdits;
  onChange: (field: keyof ScriptSectionEdits, v: string) => void;
  errors: FieldErrors;
  readOnly: boolean;
  limits: EditLimits;
  lang?: string;
  changed: Set<string>;
}) {
  const id = section.outline_section_id;
  const key = (f: string) => `script.${id}.${f}`;
  const base = {
    heading: section.heading,
    narration: section.narration,
    summary: section.summary ?? "",
    editorial_notes: listToText(section.editorial_notes),
  };
  const val = (f: keyof ScriptSectionEdits) => pick(edits[f], base[f]);
  const isChanged = (f: keyof ScriptSectionEdits) => changed.has(key(f));
  const timing = [
    section.estimated_duration_seconds != null ? `estimated ${formatClock(section.estimated_duration_seconds)}` : null,
    section.target_duration_seconds != null ? `target ${formatClock(section.target_duration_seconds)}` : null,
    section.spoken_units != null ? `${section.spoken_units.toLocaleString("en")} spoken units` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">
          {index + 1}. {val("heading") || id}
        </h3>
        <p className="text-xs text-muted-foreground">
          Section ID <code>{id}</code>
          {timing.length ? ` · ${timing.join(" / ")}` : ""}
          {isChanged("narration") ? " · the engine recalculates timing when you save" : ""}
        </p>
      </div>
      <EditField label="Heading" value={val("heading")} onChange={(v) => onChange("heading", v)} readOnly={readOnly} error={errors[key("heading")]} max={limits.heading} lang={lang} changed={isChanged("heading")} />
      <EditField
        label="Narration"
        value={val("narration")}
        onChange={(v) => onChange("narration", v)}
        readOnly={readOnly}
        error={errors[key("narration")]}
        help="Separate paragraphs with a blank line. Saving re-splits this section's storyboard scenes."
        max={limits.narration}
        rows={14}
        lang={lang}
        changed={isChanged("narration")}
      />
      <EditField label="Summary" value={val("summary")} onChange={(v) => onChange("summary", v)} readOnly={readOnly} error={errors[key("summary")]} max={limits.summary} rows={2} lang={lang} changed={isChanged("summary")} />
      <EditField
        label="Editorial notes"
        value={val("editorial_notes")}
        onChange={(v) => onChange("editorial_notes", v)}
        readOnly={readOnly}
        error={errors[key("editorial_notes")]}
        help={`One per line, at most ${limits.editorial_notes}.`}
        rows={3}
        lang={lang}
        changed={isChanged("editorial_notes")}
      />
      {section.review_flags.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3" lang="en">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warning">
            <Flag aria-hidden className="size-4" /> Review flags ({section.review_flags.length}, set by the engine)
          </p>
          <ul className="space-y-2 text-sm">
            {section.review_flags.map((f, j) => (
              <li key={j}>
                <span className="mr-1.5 inline-block rounded border border-amber-300 bg-white px-1.5 py-0.5 text-xs font-medium text-warning">
                  {FLAG_LABEL[f.kind] ?? humanize(f.kind)}
                </span>
                {f.excerpt ? (
                  <q lang={lang} className="text-slate-800">
                    {f.excerpt.replace(/^["“”']+|["“”']+$/g, "")}
                  </q>
                ) : null}
                {f.note ? <span className="block text-slate-700">{f.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
