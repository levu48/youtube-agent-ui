"use client";

import { ArrowDown, ArrowUp, Pencil, Save, Undo2, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VisualsError } from "@/components/visuals/visuals-error";
import { useVisualsEdit } from "@/hooks/use-visuals-edit";
import type { ShotChoice, VisualPlanScene, VisualsOperation, VisualsView } from "@/lib/api";
import { humanize } from "@/lib/status";

export function savedShots(view: VisualsView, sceneId: string): ShotChoice[] {
  return view.selection?.scenes.find((s) => s.scene_id === sceneId)?.shots ?? [];
}

const same = (a: ShotChoice[], b: ShotChoice[]) => JSON.stringify(a) === JSON.stringify(b);

/** The scene's shots as the reviewer is choosing them: one ordered list, saved with one
 * `visuals-edit` (`shots.set`, or `shots.clear` for none). Nothing is saved until Save. */
export function ShotEditor({
  view,
  projectId,
  sceneId,
  draft,
  setDraft,
  block,
}: {
  view: VisualsView;
  projectId: string;
  sceneId: string;
  draft: ShotChoice[];
  setDraft: (s: ShotChoice[]) => void;
  block: string | null;
}) {
  const id = useId();
  const edit = useVisualsEdit(projectId, view.revision);
  const saved = savedShots(view, sceneId);
  const dirty = !same(draft, saved);
  const max = view.editing.max_shots ?? 20;
  const titles = new Map((view.candidates[sceneId] ?? []).map((c) => [c.id, c.title ?? c.id]));
  const update = (i: number, patch: Partial<ShotChoice>) => {
    const next = draft.map((s, n) => {
      if (n !== i) return s;
      const out: ShotChoice = { ...s, ...patch };
      for (const k of ["motion", "fit", "duration_seconds"] as const) if (out[k] === undefined || out[k] === "") delete out[k];
      return out;
    });
    setDraft(next);
  };
  const move = (i: number, d: number) => {
    const next = [...draft];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setDraft(next);
  };
  const save = async () => {
    const op: VisualsOperation = draft.length ? { op: "shots.set", scene_id: sceneId, shots: draft } : { op: "shots.clear", scene_id: sceneId };
    try {
      const r = await edit.run([op]);
      toast.success(r.status === "already_current" ? "Nothing changed" : `Selection saved for ${sceneId}`);
    } catch {
      // shown below
    }
  };
  const tooMany = draft.length > max;
  const reason = block ?? (tooMany ? `At most ${max} shots per scene.` : null);
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-2 rounded-lg border p-3">
      <h4 id={`${id}-h`} className="text-sm font-semibold">
        Shots for {sceneId} {dirty ? <span className="font-normal text-warning">(unsaved changes)</span> : null}
      </h4>
      {draft.length ? (
        <ol className="space-y-2">
          {draft.map((s, i) => (
            <li key={`${s.candidate_id}-${i}`} className="grid gap-2 rounded border p-2 text-sm sm:grid-cols-[1fr_auto]">
              <span className="min-w-0 break-words">
                <span className="font-medium">Shot {i + 1}:</span> {titles.get(s.candidate_id) ?? s.candidate_id}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="icon-sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move shot ${i + 1} up`}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label={`Move shot ${i + 1} down`}>
                  <ArrowDown aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setDraft(draft.filter((_, n) => n !== i))} aria-label={`Remove shot ${i + 1}`}>
                  <X aria-hidden />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <label className="flex items-center gap-1 text-xs">
                  Motion
                  <select value={s.motion ?? ""} onChange={(e) => update(i, { motion: e.target.value || undefined })} className="rounded border bg-surface px-1 py-0.5">
                    <option value="">Engine default</option>
                    {(view.editing.motions ?? []).map((m) => (
                      <option key={m} value={m}>
                        {humanize(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-xs">
                  Fit
                  <select value={s.fit ?? ""} onChange={(e) => update(i, { fit: e.target.value || undefined })} className="rounded border bg-surface px-1 py-0.5">
                    <option value="">Engine default</option>
                    {(view.editing.fits ?? []).map((m) => (
                      <option key={m} value={m}>
                        {humanize(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-xs">
                  Seconds
                  <Input
                    type="number"
                    min={0.5}
                    max={600}
                    step={0.5}
                    value={s.duration_seconds ?? ""}
                    onChange={(e) => update(i, { duration_seconds: e.target.value ? Number(e.target.value) : undefined })}
                    className="h-7 w-20"
                    placeholder="auto"
                  />
                </label>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No shots chosen. Use “Use as a shot” on a candidate below.</p>
      )}
      <VisualsError error={edit.error} onReload={() => void edit.reload()} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!dirty || Boolean(reason) || edit.pending}>
          <Save aria-hidden /> {edit.pending ? "Saving…" : draft.length ? "Save selection" : "Clear the selection"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDraft(saved)} disabled={!dirty || edit.pending}>
          <Undo2 aria-hidden /> Discard changes
        </Button>
        {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
      </div>
    </section>
  );
}

/** Narrow one scene's plan (engine D-61): change its search query or notes, or turn search
 * off. The engine refuses anything that widens the plan (`not_narrowing`). */
export function PlanEditor({ view, projectId, scene, block }: { view: VisualsView; projectId: string; scene: VisualPlanScene; block: string | null }) {
  const id = useId();
  const edit = useVisualsEdit(projectId, view.revision);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ query: scene.search_query ?? "", search: scene.search_enabled, notes: scene.notes ?? "" });
  const ops: Omit<Extract<VisualsOperation, { op: "plan.update" }>, "op" | "scene_id"> = {};
  if (f.query !== (scene.search_query ?? "")) ops.search_query = f.query;
  if (f.search !== scene.search_enabled) ops.search_enabled = f.search;
  if (f.notes !== (scene.notes ?? "")) ops.notes = f.notes;
  const dirty = Object.keys(ops).length > 0;
  const save = async () => {
    try {
      await edit.run([{ op: "plan.update", scene_id: scene.scene_id, ...ops }]);
      toast.success(`Plan updated for ${scene.scene_id}`);
      setOpen(false);
    } catch {
      // shown below
    }
  };
  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setF({ query: scene.search_query ?? "", search: scene.search_enabled, notes: scene.notes ?? "" });
          setOpen(true);
        }}
        disabled={Boolean(block)}
      >
        <Pencil aria-hidden /> Narrow the plan for {scene.scene_id}
      </Button>
    );
  }
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-2 rounded-lg border p-3">
      <h4 id={`${id}-h`} className="text-sm font-semibold">
        Plan for {scene.scene_id}
      </h4>
      <p className="text-xs text-muted-foreground">
        You can change the search query and notes, or turn search off. Turning search on where the engine planned it off, and image
        generation, are not available: the engine only accepts a narrower plan.
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-q`}>Search query</Label>
        <Input id={`${id}-q`} value={f.query} maxLength={300} onChange={(e) => setF({ ...f, query: e.target.value })} disabled={!f.search} />
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-s`}
          type="checkbox"
          checked={f.search}
          disabled={!scene.search_enabled}
          onChange={(e) => setF({ ...f, search: e.target.checked })}
          className="size-4"
        />
        <Label htmlFor={`${id}-s`} className="font-normal">
          Search for images for this scene{!scene.search_enabled ? " (off in the engine's plan; cannot be turned on)" : ""}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">Image generation: not available (no paid or generated images in this UI).</p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-n`}>Notes</Label>
        <Input id={`${id}-n`} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
      <VisualsError error={edit.error} onReload={() => void edit.reload()} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!dirty || Boolean(block) || edit.pending}>
          <Save aria-hidden /> {edit.pending ? "Saving…" : "Save plan"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {block ? <span className="text-xs text-muted-foreground">{block}</span> : null}
      </div>
    </section>
  );
}
