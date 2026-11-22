"use client";

import { Clipboard, RefreshCw } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Save conflict: the engine refused the save because the draft changed since it was loaded.
 * Nothing is overwritten or discarded automatically: the reviewer copies their edits, then
 * reloads the latest version (which discards the unsaved edits in this page) or keeps editing.
 */
export function ConflictDialog({
  open,
  onOpenChange,
  message,
  editsText,
  onReload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
  editsText: string;
  onReload: () => void;
}) {
  const id = useId();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(editsText);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setCopied(null);
        onOpenChange(o);
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>The draft changed since you loaded it</DialogTitle>
          <DialogDescription>
            {message} Your unsaved edits are still in this page. Copy them before you reload the latest version:
            reloading discards them here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-edits`} className="text-sm font-medium">
            Your unsaved edits
          </label>
          <textarea
            id={`${id}-edits`}
            readOnly
            value={editsText}
            rows={8}
            className="w-full rounded-md border bg-surface-muted p-2 font-mono text-xs"
          />
          <p role="status" className="text-sm text-muted-foreground">
            {copied === "yes"
              ? "Copied to the clipboard."
              : copied === "failed"
                ? "Could not use the clipboard. Select the text above and copy it."
                : null}
          </p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Keep editing</Button>
          </DialogClose>
          <Button variant="outline" onClick={copy}>
            <Clipboard aria-hidden /> Copy my edits
          </Button>
          <Button onClick={onReload}>
            <RefreshCw aria-hidden /> Reload latest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
