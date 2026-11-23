"use client";

import { useId, useState } from "react";
import { toast } from "sonner";

import { EditError } from "@/components/research/edit-error";
import { TextField } from "@/components/research/fields";
import { OccurrencePicker } from "@/components/research/occurrence-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useResearchEdit } from "@/hooks/use-research-edit";
import { CLAIM_FLAGS, CLAIM_KINDS, type ClaimFlag, type ClaimKind, type EditOperation, type Occurrence, type SceneNarration } from "@/lib/api";
import { humanize } from "@/lib/status";

/** Where a new claim is anchored: an uncovered sentence the engine reported (its own offsets),
 * or an excerpt the reviewer types, which the engine locates. */
export type NewAnchor = { kind: "sentence"; scene_id: string; start: number; end: number; text: string } | { kind: "excerpt" };

export function AddClaimDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  anchor,
  scenes,
  lang,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  revision: string | null;
  anchor: NewAnchor;
  scenes: SceneNarration[];
  lang?: string;
}) {
  const edit = useResearchEdit(projectId, revision);
  const id = useId();
  const fromSentence = anchor.kind === "sentence";
  const [scene, setScene] = useState(fromSentence ? anchor.scene_id : "");
  const [excerpt, setExcerpt] = useState("");
  const [assertion, setAssertion] = useState(fromSentence ? anchor.text : "");
  const [kind, setKind] = useState<ClaimKind | "">("");
  const [flags, setFlags] = useState<ClaimFlag[]>([]);
  const [contested, setContested] = useState(false);
  const [found, setFound] = useState<Occurrence[] | null>(null);
  const [occ, setOcc] = useState<number | null>(null);

  const op = (n: number | null): EditOperation => ({
    op: "claims.add",
    anchor: fromSentence
      ? { scene_id: anchor.scene_id, start: anchor.start, end: anchor.end }
      : { scene_id: scene, excerpt, ...(n ? { occurrence: n } : {}) },
    assertion,
    kind,
    ...(flags.length ? { flags } : {}),
    ...(contested ? { contested: true } : {}),
  });
  const ready = assertion.trim() && kind && (fromSentence || (scene && excerpt.trim()));
  const save = async () => {
    try {
      const r = await edit.run([op(occ)]);
      toast.success(`Claim ${r.created.find((c) => c.kind === "claim")?.id ?? ""} added`);
      onOpenChange(false);
    } catch {
      /* shown; input kept */
    }
  };
  const find = async () => {
    try {
      const r = await edit.dryRun([op(null)]);
      const o = r.occurrences.find((x) => x.field === "excerpt")?.occurrences ?? [];
      setFound(o);
      setOcc(o.length === 1 ? 1 : null);
    } catch {
      setFound(null);
    }
  };
  const needFind = !fromSentence && !found;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a claim</DialogTitle>
          <DialogDescription>
            {fromSentence ? "For a sentence not covered by any claim." : "Anchored to an exact excerpt of a scene's narration."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {fromSentence ? (
            <blockquote lang={lang} className="border-l-2 pl-2 text-sm">
              <span className="text-xs text-muted-foreground">{anchor.scene_id}: </span>
              {anchor.text}
            </blockquote>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor={`${id}-scene`}>
                  Scene<span className="text-danger"> *</span>
                </Label>
                <select id={`${id}-scene`} value={scene} onChange={(e) => { setScene(e.target.value); setFound(null); }}
                  className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
                  <option value="">Choose…</option>
                  {scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}: {s.narration.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </div>
              <TextField label="Excerpt (exact narration text)" value={excerpt} onChange={(v) => { setExcerpt(v); setFound(null); }} required rows={2}
                max={2000} lang={lang} />
            </>
          )}
          <TextField label="Assertion" value={assertion} onChange={setAssertion} required rows={2} max={2000} lang={lang}
            hint="The checkable statement, in your words if the sentence is compound." />
          <div className="space-y-1">
            <Label htmlFor={`${id}-kind`}>
              Kind<span className="text-danger"> *</span>
            </Label>
            <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ClaimKind)}
              className="rounded-md border bg-surface px-2 py-1.5 text-sm">
              <option value="">Choose…</option>
              {CLAIM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Flags</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {CLAIM_FLAGS.map((fl) => (
                <label key={fl} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={flags.includes(fl)}
                    onChange={(e) => setFlags(e.target.checked ? [...flags, fl] : flags.filter((x) => x !== fl))} />
                  {humanize(fl)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={contested} onChange={(e) => setContested(e.target.checked)} />
            Contested
          </label>
          {found ? <OccurrencePicker label="Excerpt" occurrences={found} value={occ} onChange={setOcc} lang={lang} /> : null}
          <EditError error={edit.error} onReload={edit.reload} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {needFind ? (
            <Button onClick={find} disabled={!ready || edit.pending || !revision}>
              {edit.pending ? "Finding…" : "Find in the narration"}
            </Button>
          ) : (
            <Button onClick={save} disabled={!ready || edit.pending || !revision || (!fromSentence && !occ)}>
              {edit.pending ? "Adding…" : "Add claim"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
