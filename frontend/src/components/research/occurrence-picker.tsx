"use client";

import { useId } from "react";

import type { Occurrence } from "@/lib/api";

/** The occurrences a research-edit dry run found for a quote, with the engine's context. The
 * browser never computes offsets: it sends the quote and the chosen occurrence number. */
export function OccurrencePicker({
  label,
  occurrences,
  value,
  onChange,
  lang,
}: {
  label: string;
  occurrences: Occurrence[];
  value: number | null;
  onChange: (n: number) => void;
  lang?: string;
}) {
  const name = useId();
  if (occurrences.length === 1) {
    return (
      <p className="text-sm">
        {label}: found once — <q lang={lang}>{occurrences[0].context}</q>
      </p>
    );
  }
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">
        {label}: found {occurrences.length} times. Choose the one you mean.
      </legend>
      {occurrences.map((o) => (
        <label key={o.n} className="flex items-start gap-2 rounded border p-2 text-sm">
          <input type="radio" name={name} checked={value === o.n} onChange={() => onChange(o.n)} className="mt-1" />
          <span>
            <span className="font-medium">#{o.n}</span> <span lang={lang}>…{o.context}…</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
