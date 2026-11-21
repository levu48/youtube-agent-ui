"use client";

import { CheckCircle2, Cpu, Loader2, Server, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { useEngine, useOllama } from "@/lib/queries";
import { cn } from "@/lib/utils";

function Pill({
  ok,
  loading,
  label,
  okText,
  badText,
  icon: Icon,
}: {
  ok: boolean;
  loading: boolean;
  label: string;
  okText: string;
  badText: string;
  icon: typeof Server;
}) {
  const StateIcon = loading ? Loader2 : ok ? CheckCircle2 : XCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        loading
          ? "border-slate-300 bg-surface-muted text-slate-700"
          : ok
            ? "border-green-200 bg-green-50 text-success"
            : "border-red-200 bg-red-50 text-danger",
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span>{label}</span>
      <StateIcon aria-hidden className={cn("size-3.5", loading && "motion-safe:animate-spin")} />
      <span>{loading ? "Checking…" : ok ? okText : badText}</span>
    </span>
  );
}

export function EngineHealthBadge() {
  const q = useEngine();
  const ok = !!q.data?.available;
  return (
    <span title={q.data?.reason ?? (q.data?.version ? `ytagent ${q.data.version}` : undefined)}>
      <Pill
        ok={ok}
        loading={q.isLoading}
        label="Engine"
        okText={q.data?.version ? `Local · ${q.data.version}` : "Local"}
        badText="Unavailable"
        icon={Server}
      />
    </span>
  );
}

export function OllamaHealthBadge() {
  const q = useOllama();
  const info = q.data;
  const ok = !!info?.available;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" className="h-auto rounded-full p-0">
          <Pill
            ok={ok}
            loading={q.isLoading}
            label="Ollama"
            okText={`${info?.models.length ?? 0} model${info?.models.length === 1 ? "" : "s"}`}
            badText="Unavailable"
            icon={Cpu}
          />
          <span className="sr-only">: show details</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Local Ollama</DialogTitle>
          <DialogDescription>
            {info?.base_url ? `Endpoint ${info.base_url}` : "Local language model server"}
          </DialogDescription>
        </DialogHeader>
        {!info ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : !info.available ? (
          <p className="text-sm text-danger">{info.reason}</p>
        ) : info.models.length === 0 ? (
          <p className="text-sm">
            Ollama is running but has no models. Install one with{" "}
            <code className="rounded bg-surface-muted px-1">ollama pull {info.default_model}</code>.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {info.models.map((m) => (
              <li key={m.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium">{m.name}</span>
                <span className="text-muted-foreground">
                  {[m.parameter_size, m.quantization, formatBytes(m.size_bytes)].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? "Checking…" : "Check again"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
