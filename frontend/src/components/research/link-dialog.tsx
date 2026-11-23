"use client";

import { Link2, Search } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { EditError } from "@/components/research/edit-error";
import { LineField, MIN, TextField, present } from "@/components/research/fields";
import { OccurrencePicker } from "@/components/research/occurrence-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useOccurrenceSearch } from "@/hooks/use-occurrence-search";
import { useResearchEdit } from "@/hooks/use-research-edit";
import {
  EVIDENCE_ROLES,
  SOURCE_TYPES,
  type EditOperation,
  type EvidenceRole,
  type ResearchSnapshot,
  type SourceType,
} from "@/lib/api";
import { humanize } from "@/lib/status";

export type Translation = {
  snapshot_id: string;
  quote: string;
  language: string;
  speaker: string;
  equivalence_note: string;
  translator: string;
  original_language: string;
};
export const NO_TRANSLATION: Translation = {
  snapshot_id: "",
  quote: "",
  language: "",
  speaker: "",
  equivalence_note: "",
  translator: "",
  original_language: "",
};

export function snapshotLabel(s: ResearchSnapshot): string {
  return `${s.title ?? s.id}${s.acquisition === "imported" ? " (imported)" : s.acquisition === "fixture" ? " (test data)" : ""}`;
}

/** Where a translated passage's original wording is: another saved snapshot's exact passage. */
export function TranslationFields({
  value,
  onChange,
  snapshots,
}: {
  value: Translation;
  onChange: (t: Translation) => void;
  snapshots: ResearchSnapshot[];
}) {
  const id = useId();
  const set = (k: keyof Translation, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        The original wording must itself be a saved passage. Whether the translation is faithful is your judgement, recorded in the
        equivalence note; no tool can prove it.
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-snap`}>
          Snapshot with the original<span className="text-danger"> *</span>
        </Label>
        <select id={`${id}-snap`} value={value.snapshot_id} onChange={(e) => set("snapshot_id", e.target.value)}
          className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
          <option value="">Choose…</option>
          {snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {snapshotLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <TextField label="Original passage (exact text)" value={value.quote} onChange={(v) => set("quote", v)} required rows={2} max={2000}
        lang={snapshots.find((s) => s.id === value.snapshot_id)?.language ?? undefined} />
      <div className="grid gap-2 sm:grid-cols-2">
        <LineField label="Language of the original" value={value.language} onChange={(v) => set("language", v)} required max={20} placeholder="fr" />
        <LineField label="Who spoke or wrote the original" value={value.speaker} onChange={(v) => set("speaker", v)} required />
        <LineField label="Translator (if known)" value={value.translator} onChange={(v) => set("translator", v)} hint="Leave empty if unknown; never guess." />
      </div>
      <TextField label="Equivalence note" value={value.equivalence_note} onChange={(v) => set("equivalence_note", v)} min={MIN.long} required
        hint="Why this translation renders the original." />
    </div>
  );
}

export function translationOp(t: Translation, occurrence: number | null) {
  return {
    snapshot_id: t.snapshot_id,
    quote: t.quote,
    language: t.language.trim(),
    speaker: t.speaker.trim(),
    equivalence_note: t.equivalence_note,
    ...(occurrence ? { occurrence } : {}),
  };
}

export const translationReady = (t: Translation) =>
  Boolean(t.snapshot_id && t.quote.trim() && t.language.trim().length >= 2 && t.speaker.trim() && t.equivalence_note.trim());

const OCC_FIELDS = ["quote", "original_quote"] as const;

/** Link a passage of a snapshot to a claim (`evidence.add`). A dry run first finds every
 * occurrence of the quote (and of the original passage, for a traced translation). */
export function LinkDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  snapshot,
  snapshots,
  initialQuote,
  claims,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  revision: string | null;
  snapshot: ResearchSnapshot;
  snapshots: ResearchSnapshot[];
  initialQuote: string;
  claims: { id: string; assertion: string }[];
}) {
  const edit = useResearchEdit(projectId, revision);
  const id = useId();
  const [claimId, setClaimId] = useState("");
  const [quote, setQuote] = useState(initialQuote);
  const [role, setRole] = useState<EvidenceRole | "">("");
  const [explanation, setExplanation] = useState("");
  const [sourceType, setSourceType] = useState<SourceType | "">(snapshot.acquisition === "imported" ? "user_supplied" : "");
  const [root, setRoot] = useState("");
  const [translated, setTranslated] = useState(false);
  const [tr, setTr] = useState<Translation>(NO_TRANSLATION);

  const op = (withOcc: boolean): EditOperation => ({
    op: "evidence.add",
    claim_id: claimId,
    snapshot_id: snapshot.id,
    quote,
    role,
    explanation,
    ...(withOcc && occ ? { occurrence: occ } : {}),
    ...present({ source_type: sourceType || undefined, evidence_root: root.trim() || undefined }),
    ...(translated
      ? {
          is_translation: true,
          translation_of: translationOp(tr, withOcc ? occOrig : null),
          ...present({ translator: tr.translator.trim(), original_language: tr.language.trim() }),
        }
      : {}),
  });
  // Results belong to this exact operation under this revision; any edit to the form hides them.
  const occs = useOccurrenceSearch(JSON.stringify([revision, op(false)]), OCC_FIELDS);
  const found = occs.found;
  const quotes = occs.occurrences("quote");
  const originals = occs.occurrences("original_quote");
  const occ = occs.pick("quote");
  const occOrig = occs.pick("original_quote");
  const ready = claimId && quote.trim() && role && explanation.trim() && (!translated || translationReady(tr));
  const chosen = found && (quotes.length === 1 || occ) && (!translated || originals.length === 1 || occOrig);

  const find = () => occs.search(() => edit.dryRun([op(false)]));
  const link = async () => {
    try {
      await edit.run([op(true)]);
      toast.success("Evidence linked");
      onOpenChange(false);
    } catch {
      /* shown; input kept */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link to claim</DialogTitle>
          <DialogDescription>
            A passage of “{snapshotLabel(snapshot)}” becomes evidence for a claim. It is evidence, not a verdict: a reviewer still decides.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-claim`}>
              Claim<span className="text-danger"> *</span>
            </Label>
            <select id={`${id}-claim`} value={claimId} onChange={(e) => setClaimId(e.target.value)}
              className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
              <option value="">Choose…</option>
              {claims.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}: {c.assertion.slice(0, 90)}
                </option>
              ))}
            </select>
          </div>
          <TextField label="Passage (exact text of the snapshot)" value={quote} onChange={(v) => setQuote(v)} required rows={3}
            max={2000} lang={snapshot.language ?? undefined} />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-role`}>
                Role<span className="text-danger"> *</span>
              </Label>
              <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as EvidenceRole)}
                className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
                <option value="">Choose…</option>
                {EVIDENCE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-type`}>Source type</Label>
              <select id={`${id}-type`} value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}
                className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
                <option value="">Not set (unknown)</option>
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {snapshot.acquisition === "imported" ? (
            <p className="text-xs text-muted-foreground">
              Imported document: never counts as an independent root, and as a primary source only once this edition is attested.
            </p>
          ) : null}
          <TextField label="Explanation" value={explanation} onChange={(v) => setExplanation(v)} min={MIN.explanation} required
            hint="Why this passage bears on the claim." />
          <LineField label="Evidence root (optional)" value={root} onChange={(v) => setRoot(v)}
            hint="The same value for mirrors, translations and pages derived from one original." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={translated} onChange={(e) => setTranslated(e.target.checked)} />
            This passage is a translation of another-language original
          </label>
          {translated ? <TranslationFields value={tr} onChange={setTr} snapshots={snapshots} /> : null}
          {found ? (
            <div className="space-y-2">
              <OccurrencePicker label="Passage" occurrences={quotes} value={occ} onChange={(n) => occs.setPick("quote", n)} lang={snapshot.language ?? undefined} />
              {translated ? <OccurrencePicker label="Original passage" occurrences={originals} value={occOrig} onChange={(n) => occs.setPick("original_quote", n)} /> : null}
            </div>
          ) : null}
          <EditError error={edit.error} onReload={edit.reload} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!found ? (
            <Button onClick={find} disabled={!ready || occs.searching || !revision}>
              <Search aria-hidden /> {occs.searching ? "Finding…" : "Find the passage"}
            </Button>
          ) : (
            <Button onClick={link} disabled={!chosen || edit.pending}>
              <Link2 aria-hidden /> {edit.pending ? "Linking…" : "Link evidence"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
