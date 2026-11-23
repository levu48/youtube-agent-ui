"use client";

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** The engine's "substantive text" rule (research checks.py `substantive`): at least `words`
 * words of two or more letters, `chars` characters and some variety. Shown as guidance only;
 * the engine's research-check is the judge. */
export function substantive(text: string, words: number, chars: number) {
  const flat = text.normalize("NFC").split(/\s+/).filter(Boolean).join(" ");
  const found = (flat.match(/\p{L}{2,}/gu) ?? []).map((w) => w.toLocaleLowerCase());
  const ok = flat.length >= chars && found.length >= words && new Set(found).size >= Math.max(3, Math.floor(words / 2));
  return { ok, words: found.length, chars: flat.length };
}

export const MIN = {
  rationale: [6, 30],
  explanation: [5, 25],
  statement: [5, 25],
  counterargument: [5, 25],
  long: [6, 30],
} as const satisfies Record<string, readonly [number, number]>;

export function TextField({
  label,
  value,
  onChange,
  min,
  required,
  rows = 3,
  max = 4000,
  lang,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: readonly [number, number];
  required?: boolean;
  rows?: number;
  max?: number;
  lang?: string;
  hint?: string;
}) {
  const id = useId();
  const s = min ? substantive(value, min[0], min[1]) : null;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={max}
        lang={lang}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint ? `${hint} ` : ""}
        {min
          ? `The engine expects at least ${min[0]} words and ${min[1]} characters (now ${s!.words} words, ${s!.chars} characters)${s!.ok ? "." : "; research-check will flag it as too thin."}`
          : null}
      </p>
    </div>
  );
}

export function LineField({
  label,
  value,
  onChange,
  required,
  max = 200,
  hint,
  placeholder,
  lang,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  max?: number;
  hint?: string;
  placeholder?: string;
  lang?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      <Input
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        lang={lang}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const REVIEWER_HINT = "Your own name: the engine refuses placeholders such as \"reviewer\" or \"admin\".";

/** Only the fields that have a value: the engine patch never carries empty optional text. */
export function present<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")),
  ) as Partial<T>;
}
