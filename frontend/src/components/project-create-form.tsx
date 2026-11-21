"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderLock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { slugify } from "@/lib/format";
import { qk, useConfig } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  SERVER_FIELD,
  minutesToSeconds,
  validateCreate,
  type CreateFormValues,
  type FieldErrors,
} from "@/lib/validation";

const ORDER: (keyof CreateFormValues)[] = [
  "idea",
  "slug",
  "language",
  "durationMinutes",
  "audience",
  "tone",
  "guidance",
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Field({
  id,
  label,
  required,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden>
            {" "}
            *
          </span>
        ) : (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </Label>
      {children}
      {help ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, help: boolean, error?: string) {
  return [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function ProjectCreateForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const config = useConfig();
  const uid = useId();
  const ids = Object.fromEntries(ORDER.map((k) => [k, `${uid}-${k}`])) as Record<keyof CreateFormValues, string>;
  const formRef = useRef<HTMLFormElement>(null);

  const [values, setValues] = useState<CreateFormValues>({
    idea: "",
    slug: "",
    language: "vi",
    durationMinutes: "3",
    audience: "",
    tone: "",
    guidance: "",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<ApiError | Error | null>(null);

  const [langTouched, setLangTouched] = useState(false);
  // Until the user picks one, the configured default language applies.
  const language = langTouched ? values.language : (config.data?.default_language ?? values.language);

  const set = <K extends keyof CreateFormValues>(k: K, val: CreateFormValues[K]) => {
    setValues((prev) => {
      const next = { ...prev, [k]: val };
      if (k === "idea" && !slugTouched) next.slug = slugify(String(val));
      if (submitted) setErrors(validateCreate(next));
      return next;
    });
  };

  const debouncedSlug = useDebounced(values.slug, 300);
  const preview = useQuery({
    queryKey: ["location-preview", debouncedSlug],
    queryFn: () => api.locationPreview(debouncedSlug),
    enabled: debouncedSlug.length > 0,
    staleTime: 5_000,
  });

  const focusFirstError = (errs: FieldErrors) => {
    const first = ORDER.find((k) => errs[k]);
    if (first) document.getElementById(ids[first])?.focus();
  };

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        slug: values.slug,
        idea: values.idea.trim(),
        language,
        duration_seconds: minutesToSeconds(values.durationMinutes),
        audience: values.audience.trim() || null,
        tone: values.tone.trim() || null,
        guidance: values.guidance.trim() || null,
      }),
    onSuccess: (r) => {
      toast.success("Project created");
      void qc.invalidateQueries({ queryKey: qk.projects });
      router.push(`/projects/${encodeURIComponent(r.id)}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const fieldErrs: FieldErrors = {};
        for (const [k, msg] of Object.entries(e.fields)) {
          const f = SERVER_FIELD[k];
          if (f) fieldErrs[f] = msg;
        }
        if (e.code === "project_exists" || e.code === "path_exists") fieldErrs.slug = e.message;
        if (Object.keys(fieldErrs).length) {
          setErrors(fieldErrs);
          focusFirstError(fieldErrs);
          setFormError(null);
          return;
        }
      }
      setFormError(e as Error);
    },
  });

  const onSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (create.isPending) return;
    setSubmitted(true);
    setFormError(null);
    const errs = validateCreate({ ...values, language });
    setErrors(errs);
    if (Object.keys(errs).length) {
      focusFirstError(errs);
      return;
    }
    create.mutate();
  };

  const errorCount = Object.values(errors).filter(Boolean).length;
  const inputCls = (k: keyof CreateFormValues) => cn("bg-surface", errors[k] && "border-danger");

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} className="space-y-6" aria-describedby={`${uid}-local`}>
      {submitted && errorCount > 0 ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
          {errorCount === 1 ? "1 field needs attention." : `${errorCount} fields need attention.`}
        </div>
      ) : null}

      <Field
        id={ids.idea}
        label="Documentary topic / idea"
        required
        help="What the documentary is about. 5–2,000 characters. Vietnamese is fully supported."
        error={errors.idea}
      >
        <Textarea
          id={ids.idea}
          value={values.idea}
          onChange={(e) => set("idea", e.target.value)}
          rows={3}
          required
          aria-invalid={!!errors.idea}
          aria-describedby={describedBy(ids.idea, true, errors.idea)}
          className={inputCls("idea")}
          placeholder="Hồ Chí Minh: Nationalist or Communist?"
        />
      </Field>

      <Field
        id={ids.slug}
        label="Project slug"
        required
        help={
          slugTouched
            ? "Lowercase letters, digits and hyphens. Used as the folder name; it cannot be changed later."
            : "Suggested from the topic. Edit it to choose your own; it cannot be changed later."
        }
        error={errors.slug}
      >
        <Input
          id={ids.slug}
          value={values.slug}
          onChange={(e) => {
            setSlugTouched(true);
            set("slug", e.target.value.toLowerCase());
          }}
          required
          maxLength={63}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={!!errors.slug}
          aria-describedby={describedBy(ids.slug, true, errors.slug)}
          className={cn(inputCls("slug"), "font-mono")}
        />
      </Field>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">
          Language<span className="text-danger" aria-hidden> *</span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["vi", "Vietnamese"],
              ["en", "English"],
            ] as const
          ).map(([val, label]) => (
            <label
              key={val}
              className={cn(
                "flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border bg-surface px-3 text-sm has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary",
              )}
            >
              <input
                type="radio"
                name="language"
                value={val}
                checked={language === val}
                onChange={() => {
                  setLangTouched(true);
                  set("language", val);
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        id={ids.durationMinutes}
        label="Target duration (minutes)"
        required
        help="Between 1 and 60 minutes."
        error={errors.durationMinutes}
      >
        <Input
          id={ids.durationMinutes}
          type="number"
          inputMode="decimal"
          min={1}
          max={60}
          step={0.5}
          value={values.durationMinutes}
          onChange={(e) => set("durationMinutes", e.target.value)}
          required
          aria-invalid={!!errors.durationMinutes}
          aria-describedby={describedBy(ids.durationMinutes, true, errors.durationMinutes)}
          className={cn(inputCls("durationMinutes"), "max-w-40")}
        />
      </Field>

      <div className="grid gap-6 md:grid-cols-2">
        <Field id={ids.audience} label="Audience" help="Who the video is for." error={errors.audience}>
          <Input
            id={ids.audience}
            value={values.audience}
            onChange={(e) => set("audience", e.target.value)}
            maxLength={500}
            aria-invalid={!!errors.audience}
            aria-describedby={describedBy(ids.audience, true, errors.audience)}
            className={inputCls("audience")}
            placeholder="General Vietnamese audience"
          />
        </Field>
        <Field id={ids.tone} label="Tone" help="Defaults to a balanced documentary tone." error={errors.tone}>
          <Input
            id={ids.tone}
            value={values.tone}
            onChange={(e) => set("tone", e.target.value)}
            maxLength={200}
            aria-invalid={!!errors.tone}
            aria-describedby={describedBy(ids.tone, true, errors.tone)}
            className={inputCls("tone")}
            placeholder="Balanced documentary"
          />
        </Field>
      </div>

      <Field
        id={ids.guidance}
        label="Editorial guidance"
        help="Instructions for the draft, e.g. “Distinguish evidence from interpretation”."
        error={errors.guidance}
      >
        <Textarea
          id={ids.guidance}
          value={values.guidance}
          onChange={(e) => set("guidance", e.target.value)}
          rows={3}
          aria-invalid={!!errors.guidance}
          aria-describedby={describedBy(ids.guidance, true, errors.guidance)}
          className={inputCls("guidance")}
        />
      </Field>

      <div className="space-y-1.5 rounded-lg border bg-surface-muted p-4" aria-live="polite">
        <p className="text-sm font-medium">Project location</p>
        <p className="font-mono text-sm break-all">
          {!values.slug
            ? "Enter a slug to see where the project will be stored."
            : preview.data?.location || (preview.isFetching ? "Checking…" : "—")}
        </p>
        {preview.data && !preview.data.available && preview.data.reason ? (
          <p className="text-sm text-warning">{preview.data.reason}</p>
        ) : null}
        <p id={`${uid}-local`} className="flex items-start gap-1.5 text-xs text-slate-600">
          <FolderLock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Projects are stored locally on this Mac
          {config.data ? ` under ${config.data.projects_root}` : ""}. Nothing is uploaded. Creating a project
          does not start any AI generation.
        </p>
      </div>

      {formError ? (
        <ErrorState
          title="The project could not be created"
          message={formError.message}
          onRetry={() => create.mutate()}
        />
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create Project"}
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
