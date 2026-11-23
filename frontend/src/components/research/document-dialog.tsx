"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EditError } from "@/components/research/edit-error";
import { LineField, REVIEWER_HINT, TextField } from "@/components/research/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type DocumentImport, type ResearchSnapshot, type ResearchView } from "@/lib/api";
import { qk } from "@/lib/queries";

const MAX_CHARS = 400_000;
const EMPTY: DocumentImport = {
  title: "",
  language: "",
  citation: "",
  imported_by: "",
  edition: "",
  declared_url: "",
  original_published_at: "",
  license: "",
  note: "",
  text: "",
};

function fromEdition(p: Record<string, string | null> | null | undefined): DocumentImport {
  const get = (k: string) => (p?.[k] ?? "") as string;
  return {
    ...EMPTY,
    title: get("title"),
    language: get("language"),
    citation: get("citation"),
    edition: get("edition"),
    declared_url: get("declared_url"),
    original_published_at: get("original_published_at"),
    license: get("license"),
    note: get("note"),
  };
}

/** Import an offline document (engine D-120), or a corrected edition of one. No network: a
 * declared URL is stored as data and never fetched. Imported evidence is labelled as such, is
 * never an independent root, and counts as primary only once its edition is attested. */
export function DocumentDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  newVersionOf,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  revision: string | null;
  /** For a new edition: the document source and its current edition, to pre-fill from. */
  newVersionOf?: { sourceId: string; edition: ResearchSnapshot | undefined } | null;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<DocumentImport>(() => (newVersionOf ? fromEdition(newVersionOf.edition?.document_provenance) : EMPTY));
  const set = (k: keyof DocumentImport, v: string) => setF((x) => ({ ...x, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body: DocumentImport & { expected_revision: string } = {
        expected_revision: revision ?? "",
        title: f.title,
        language: f.language.trim(),
        citation: f.citation,
        imported_by: f.imported_by.trim(),
        text: f.text,
      };
      for (const k of ["edition", "declared_url", "original_published_at", "license", "note"] as const) {
        if (f[k]?.trim()) body[k] = f[k]!.trim();
      }
      if (newVersionOf) body.new_version_of = newVersionOf.sourceId;
      return api.addDocument(projectId, body);
    },
    onSuccess: (r) => {
      qc.setQueryData<ResearchView>(qk.research(projectId), r.research);
      toast.success(newVersionOf ? "New edition imported" : `Document imported as ${r.result.source_id}`);
      setF(EMPTY);
      onOpenChange(false);
    },
  });
  const chars = f.text.normalize("NFC").length;
  const ready = f.title.trim() && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(f.language.trim()) && f.citation.trim() && f.imported_by.trim() && f.text.trim() && chars <= MAX_CHARS;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{newVersionOf ? "Import a new edition" : "Import a document"}</DialogTitle>
          <DialogDescription>
            A book, an archive document or a saved text, with the provenance of this edition. Nothing is contacted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="rounded-md border bg-surface-muted p-2 text-xs">
            Imported evidence is labelled “Imported document — not retrieved by the engine”. It never counts as an independent root, and counts
            as a primary source only after you attest this edition.
          </p>
          {newVersionOf ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-warning">
              The form is pre-filled from the current edition: check and submit every field; nothing is inherited. Claims citing the older edition
              will need a source recheck, and an existing research approval (G2) will go out of date.
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <LineField label="Title" value={f.title} onChange={(v) => set("title", v)} required max={300} />
            <LineField label="Language" value={f.language} onChange={(v) => set("language", v)} required max={20} placeholder="vi" hint="A language code, such as vi, fr or en." />
          </div>
          <TextField label="Citation" value={f.citation} onChange={(v) => set("citation", v)} required rows={2} max={2000}
            hint="A bibliographic or archive reference for this edition." />
          <LineField label="Imported by" value={f.imported_by} onChange={(v) => set("imported_by", v)} required hint={REVIEWER_HINT} />
          <div className="grid gap-2 sm:grid-cols-2">
            <LineField label="Edition" value={f.edition ?? ""} onChange={(v) => set("edition", v)} />
            <LineField label="Original date (as stated)" value={f.original_published_at ?? ""} onChange={(v) => set("original_published_at", v)} max={100} />
            <LineField label="Licence" value={f.license ?? ""} onChange={(v) => set("license", v)} />
            <LineField label="Declared URL" value={f.declared_url ?? ""} onChange={(v) => set("declared_url", v)} max={2000}
              hint="https only. Stored as information; never fetched." />
          </div>
          <TextField label="Note" value={f.note ?? ""} onChange={(v) => set("note", v)} rows={2} />
          <TextField label="Text" value={f.text} onChange={(v) => set("text", v)} required rows={10} max={MAX_CHARS} lang={f.language.trim() || undefined}
            hint={`Plain text only (${chars.toLocaleString()} of ${MAX_CHARS.toLocaleString()} characters).`} />
          <EditError error={m.error} onReload={() => qc.invalidateQueries({ queryKey: qk.research(projectId) })} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={!ready || m.isPending || !revision}>
            <FileUp aria-hidden /> {m.isPending ? "Importing…" : newVersionOf ? "Import edition" : "Import document"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
