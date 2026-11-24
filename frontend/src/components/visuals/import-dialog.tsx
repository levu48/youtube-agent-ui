"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { LineField, TextField } from "@/components/research/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ApiError, IMPORT_KINDS, api, type VisualPlanScene } from "@/lib/api";
import { qk } from "@/lib/queries";
import { humanize } from "@/lib/status";

const MAX_BYTES = 20 * 1024 * 1024; // the engine's limit
const ACCEPT = "image/jpeg,image/png,image/webp,image/tiff,.jpg,.jpeg,.png,.webp,.tif,.tiff";
const OPTIONAL = ["title", "source_url", "creator", "license_name", "license_url", "attribution"] as const;
type Optional = (typeof OPTIONAL)[number];

/** Add an image the reviewer owns or has cleared (`visuals-import --stdin`). The engine adds
 * it as a `manual_review` candidate: imports are never cleared automatically. The text fields
 * travel first, so the backend checks them and the revision before reading the image. */
export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  scenes,
  initialScene,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  revision: string;
  scenes: VisualPlanScene[];
  initialScene?: string;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [scene, setScene] = useState(initialScene ?? scenes[0]?.scene_id ?? "");
  const [kind, setKind] = useState<(typeof IMPORT_KINDS)[number]>("archival");
  const [provenance, setProvenance] = useState("");
  const [opt, setOpt] = useState<Record<Optional, string>>({ title: "", source_url: "", creator: "", license_name: "", license_url: "", attribution: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: Optional, v: string) => setOpt((o) => ({ ...o, [k]: v }));

  const problem =
    !file
      ? "Choose an image file."
      : file.size > MAX_BYTES
        ? "The image is larger than 20 MB, the engine's limit."
        : provenance.trim().length < 10
          ? "Describe where the image comes from (at least 10 characters)."
          : (["source_url", "license_url"] as const).some((k) => opt[k].trim() && !/^https:\/\//i.test(opt[k].trim()))
            ? "Links must start with https://."
            : null;

  const m = useMutation({
    mutationFn: () => {
      const form = new FormData();
      // Order matters: every text field before the file.
      form.append("expected_revision", revision);
      form.append("scene_id", scene);
      form.append("kind", kind);
      form.append("provenance", provenance.trim());
      for (const k of OPTIONAL) if (opt[k].trim()) form.append(k, opt[k].trim());
      form.append("file", file!, file!.name);
      return api.visualsImport(projectId, form);
    },
    onSuccess: (r) => {
      qc.setQueryData(qk.visuals(projectId), r.visuals);
      toast.success(`Image added to ${r.result.scene_id} as a candidate that needs a rights review`);
      onOpenChange(false);
    },
    onError: (e) => {
      setError((e as Error).message);
      setFields(e instanceof ApiError ? e.fields : {});
      if (e instanceof ApiError && ["revision_conflict", "recovery_required"].includes(e.code)) {
        void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import an image</DialogTitle>
          <DialogDescription>
            Add a still image you own or have cleared. The engine stores a normalised copy and records it as needing a human
            rights review. Nothing is sent anywhere else.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-scene`}>Scene</Label>
              <select id={`${id}-scene`} value={scene} onChange={(e) => setScene(e.target.value)} className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
                {scenes.map((s) => (
                  <option key={s.scene_id} value={s.scene_id}>
                    {s.scene_id} ({humanize(s.desired_kind)})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-kind`}>Kind</Label>
              <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-md border bg-surface px-2 py-1.5 text-sm">
                {IMPORT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-file`}>
              Image file<span className="text-danger"> *</span>
            </Label>
            <input
              id={`${id}-file`}
              type="file"
              accept={ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              aria-describedby={`${id}-file-hint`}
              className="block w-full text-sm"
            />
            <p id={`${id}-file-hint`} className="text-xs text-muted-foreground">
              JPEG, PNG, WebP or TIFF, at most 20 MB. The engine needs at least 480×270 pixels.
            </p>
          </div>
          <TextField
            label="Provenance"
            value={provenance}
            onChange={setProvenance}
            required
            rows={2}
            max={2000}
            hint="Where the image comes from and why you may use it (at least 10 characters)."
          />
          {fields.provenance ? <p className="text-xs text-danger">{fields.provenance}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <LineField label="Title" value={opt.title} onChange={(v) => set("title", v)} hint="Defaults to the file name." />
            <LineField label="Creator" value={opt.creator} onChange={(v) => set("creator", v)} max={300} />
            <LineField label="Source URL" value={opt.source_url} onChange={(v) => set("source_url", v)} max={2000} placeholder="https://" />
            <LineField label="Licence name" value={opt.license_name} onChange={(v) => set("license_name", v)} />
            <LineField label="Licence URL" value={opt.license_url} onChange={(v) => set("license_url", v)} max={2000} placeholder="https://" />
            <LineField label="Attribution" value={opt.attribution} onChange={(v) => set("attribution", v)} max={1000} />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {problem ? <p className="mr-auto text-xs text-muted-foreground">{problem}</p> : null}
          <Button onClick={() => m.mutate()} disabled={Boolean(problem) || m.isPending}>
            <FileUp aria-hidden /> {m.isPending ? "Importing…" : "Import image"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
