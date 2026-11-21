"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { OllamaHealthBadge } from "@/components/health-badges";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ApiError, api, type DraftJobInput, type OllamaInfo } from "@/lib/api";
import { qk, useConfig, useOllama } from "@/lib/queries";

const STAGES: { value: DraftJobInput["from_stage"]; label: string }[] = [
  { value: "outline", label: "Outline (full draft)" },
  { value: "script", label: "Script (keep the existing outline)" },
  { value: "storyboard", label: "Storyboard only" },
];

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";

export function ModelSelector({
  info,
  value,
  onChange,
  disabled,
}: {
  info: OllamaInfo | undefined;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const models = info?.models ?? [];
  return (
    <div className="space-y-1.5">
      <Label htmlFor="draft-model">Model</Label>
      <select
        id="draft-model"
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || models.length === 0}
        aria-describedby="draft-model-help"
      >
        {models.length === 0 ? <option value="">No models installed</option> : null}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
            {m.parameter_size ? ` (${m.parameter_size})` : ""}
          </option>
        ))}
      </select>
      <p id="draft-model-help" className="text-xs text-muted-foreground">
        {info?.available && !info.default_model_installed ? (
          <>
            The recommended model {info.default_model} is not installed. Run{" "}
            <code className="rounded bg-surface-muted px-1">ollama pull {info.default_model}</code>.
          </>
        ) : (
          "Models installed in your local Ollama."
        )}
      </p>
    </div>
  );
}

export function DraftPanel({
  projectId,
  hasActiveJob,
  draftExists,
  onStarted,
}: {
  projectId: string;
  hasActiveJob: boolean;
  draftExists: boolean;
  onStarted: (jobId: string) => void;
}) {
  const qc = useQueryClient();
  const ollama = useOllama();
  const config = useConfig();
  const providers = config.data?.providers ?? ["ollama"];
  const [provider, setProvider] = useState<DraftJobInput["provider"]>("ollama");
  const [chosenModel, setModel] = useState<string>("");
  const [fromStage, setFromStage] = useState<DraftJobInput["from_stage"]>("outline");

  const info = ollama.data;
  const defaultModel =
    info?.models.find((m) => m.name === info.default_model || m.name === `${info.default_model}:latest`)?.name ??
    info?.models[0]?.name ??
    "";
  const model = chosenModel || defaultModel;

  const start = useMutation({
    mutationFn: () =>
      api.startDraft(projectId, {
        provider,
        model: provider === "ollama" ? model : null,
        from_stage: fromStage,
      }),
    onSuccess: (r) => {
      toast.success("Draft job queued");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.projects });
      onStarted(r.job_id);
    },
  });

  const ollamaReady = provider !== "ollama" || (!!info?.available && !!model);
  const disabled = hasActiveJob || start.isPending || !ollamaReady;
  const err = start.error instanceof ApiError ? start.error : null;

  return (
    <Card id="generate-draft" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="text-lg">Generate Draft</CardTitle>
        <CardDescription>
          Runs the engine&apos;s <code>draft</code> command in the background. It writes an editable outline,
          script and storyboard draft and never starts narration, visuals or rendering.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <OllamaHealthBadge />
          {!info?.available && info?.reason ? (
            <Button variant="link" size="sm" onClick={() => ollama.refetch()}>
              Retry
            </Button>
          ) : null}
        </div>
        {provider === "ollama" && info && !info.available ? (
          <p className="text-sm text-danger">{info.reason}</p>
        ) : null}

        {providers.includes("fixture") ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Provider</legend>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="provider"
                  value="ollama"
                  checked={provider === "ollama"}
                  onChange={() => setProvider("ollama")}
                />
                Local Ollama
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="provider"
                  value="fixture"
                  checked={provider === "fixture"}
                  onChange={() => setProvider("fixture")}
                />
                Offline fixture (test placeholder text, not editorial content)
              </label>
            </div>
          </fieldset>
        ) : null}

        {provider === "ollama" ? (
          <ModelSelector info={info} value={model} onChange={setModel} disabled={start.isPending} />
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="draft-from-stage">Start from</Label>
          <select
            id="draft-from-stage"
            className={selectClass}
            value={fromStage}
            onChange={(e) => setFromStage(e.target.value as DraftJobInput["from_stage"])}
            disabled={start.isPending}
            aria-describedby="draft-from-stage-help"
          >
            {STAGES.map((s) => (
              <option key={s.value} value={s.value} disabled={!draftExists && s.value !== "outline"}>
                {s.label}
              </option>
            ))}
          </select>
          <p id="draft-from-stage-help" className="text-xs text-muted-foreground">
            Unchanged parts are reused from the engine cache. The engine refuses to overwrite files you edited.
          </p>
        </div>

        {err ? (
          <ErrorState
            title={err.code === "job_conflict" ? "A job is already active" : "Could not start the draft"}
            message={err.message}
          />
        ) : start.isError ? (
          <ErrorState title="Could not start the draft" message={(start.error as Error).message} />
        ) : null}

        <Button size="lg" className="w-full" disabled={disabled} onClick={() => start.mutate()}>
          <Sparkles aria-hidden />
          {start.isPending ? "Starting…" : hasActiveJob ? "A job is already active" : "Generate Draft"}
        </Button>
      </CardContent>
    </Card>
  );
}
