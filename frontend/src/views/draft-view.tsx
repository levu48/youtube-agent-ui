"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Copy, Eye, FileX, Pencil, RefreshCw, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ApprovalPanel } from "@/components/draft/approval-panel";
import { ConflictDialog } from "@/components/draft/conflict-dialog";
import { DraftContent } from "@/components/draft/draft-content";
import { DraftValidationPanel } from "@/components/draft/draft-validation-panel";
import { SafeMarkdown } from "@/components/draft/safe-markdown";
import { OutlineDocumentEditor, OutlineSectionEditor, ScriptSectionEditor } from "@/components/draft/section-editor";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { ApiError, api, type DraftEditResult, type EditableDraft, type Script } from "@/lib/api";
import {
  buildPatch,
  changedKeys,
  editedSections,
  editsAfterSave,
  editsAsText,
  emptyEdits,
  hasRawEdits,
  isEmptyPatch,
  validatePatch,
  type Edits,
  type OutlineSectionEdits,
  type ScriptSectionEdits,
} from "@/lib/draft-edit";
import { clearEdits, loadEdits, storeEdits } from "@/lib/edit-recovery";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { approvalPresentation } from "@/lib/status";

type Tab = "outline" | "script" | "validation";
const TABS: { id: Tab; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "script", label: "Script" },
  { id: "validation", label: "Validation" },
];
const DOC = "__document__";

function scriptText(s: Script): string {
  return [s.title, ...s.sections.map((x) => `${x.heading}\n\n${x.narration}`)].join("\n\n");
}

export function DraftView() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => api.project(projectId) });
  const draft = useQuery({ queryKey: qk.draft(projectId), queryFn: () => api.draftEditable(projectId) });
  const d = draft.data as EditableDraft | undefined;

  const [edits, setEdits] = useState<Edits>(emptyEdits);
  // The version the unsaved edits are based on. A refetch while editing never replaces it,
  // so a save is always checked by the engine against the revision the edits started from.
  const [editBase, setEditBase] = useState<EditableDraft | null>(null);
  // Unsaved edits left behind in this tab (browser Back, a crash) come back once the draft
  // loads, together with the version they were based on, so the engine's check still applies.
  const [restoreChecked, setRestoreChecked] = useState(false);
  const [recovered, setRecovered] = useState<string | null>(null);
  if (!restoreChecked && d) {
    setRestoreChecked(true);
    const stored = loadEdits(projectId);
    if (stored && hasRawEdits(stored.edits)) {
      setEditBase(stored.base);
      setEdits(stored.edits);
      setRecovered(stored.savedAt);
    }
  }
  const base = editBase ?? d;
  const outline = base?.outline.data ?? null;
  const script = base?.script.data ?? null;
  const patch = useMemo(() => buildPatch(edits, outline, script), [edits, outline, script]);
  const dirty = !isEmptyPatch(patch);
  const keys = useMemo(() => changedKeys(patch), [patch]);
  const edited = useMemo(() => editedSections(patch), [patch]);
  const limits = d?.editing?.limits;
  const errors = useMemo(() => (limits ? validatePatch(patch, limits) : {}), [patch, limits]);
  const errorCount = Object.keys(errors).length;

  // No real change is pending and the engine now reports a newer draft: follow it. (The raw
  // input is kept otherwise, so typing a space that matches the saved text is not lost.
  // State adjusted during render: React's pattern for state derived from other state.)
  if (!dirty && editBase && d && d.editing?.revision !== editBase.editing?.revision) {
    setEditBase(null);
    setEdits(emptyEdits());
  } else if (editBase && !hasRawEdits(edits)) {
    setEditBase(null);
  }
  useUnsavedGuard(dirty);
  useEffect(() => {
    if (!restoreChecked) return;
    if (dirty && editBase) storeEdits(projectId, editBase, edits);
    else clearEdits(projectId);
  }, [restoreChecked, dirty, editBase, edits, projectId]);
  // The latest input, read when a save returns: anything typed while it was pending is kept.
  const editsRef = useRef(edits);
  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);

  const editing = d?.editing;
  const canEdit = Boolean(editing?.can_edit && base?.editing?.revision);
  const drifted = dirty && Boolean(d && base && d.editing?.revision !== base.editing?.revision);

  const [tab, setTab] = useState<Tab>("outline");
  const [selOutline, setSelOutline] = useState<string>(DOC);
  const [selScript, setSelScript] = useState<string | null>(null);
  const [scriptMode, setScriptMode] = useState<"edit" | "full" | "markdown">("edit");
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [lastSave, setLastSave] = useState<DraftEditResult["result"] | null>(null);

  const startEdit = useCallback(() => {
    if (!editBase && d) setEditBase(d);
  }, [editBase, d]);

  const setOutlineField = (field: "title" | "thesis_or_question", v: string) => {
    startEdit();
    setEdits((e) => ({ ...e, outline: { ...e.outline, [field]: v } }));
  };
  const setOutlineSection = (id: string, field: keyof OutlineSectionEdits, v: string) => {
    startEdit();
    setEdits((e) => ({
      ...e,
      outline: { ...e.outline, sections: { ...e.outline.sections, [id]: { ...e.outline.sections[id], [field]: v } } },
    }));
  };
  const setScriptSection = (id: string, field: keyof ScriptSectionEdits, v: string) => {
    startEdit();
    setEdits((e) => ({
      ...e,
      script: { sections: { ...e.script.sections, [id]: { ...e.script.sections[id], [field]: v } } },
    }));
  };

  const discard = () => {
    setEdits(emptyEdits());
    setEditBase(null);
    setSaveError(null);
    setConfirmDiscard(false);
    setRecovered(null);
  };

  const save = useMutation({
    // The patch, its revision and the raw input it came from are fixed when Save is pressed.
    mutationFn: (v: { revision: string; patch: typeof patch; submitted: Edits; wasApproved: boolean }) =>
      api.editDraft(projectId, { expected_revision: v.revision, ...v.patch }),
    onSuccess: (res, v) => {
      if (res.draft) qc.setQueryData(qk.draft(projectId), res.draft);
      else void qc.invalidateQueries({ queryKey: qk.draft(projectId) });
      // Edits typed while the save was pending stay unsaved, now on top of the saved version.
      const remaining = editsAfterSave(editsRef.current, v.submitted);
      const kept = hasRawEdits(remaining);
      editsRef.current = remaining;
      setEdits(remaining);
      setEditBase(kept && res.draft ? res.draft : null);
      setSaveError(null);
      setLastSave(res.result);
      setRecovered(null);
      void qc.invalidateQueries({ queryKey: qk.projectStatus(projectId) });
      void qc.invalidateQueries({ queryKey: qk.projects });
      if (res.result.status === "already_current") {
        toast.info("Nothing to save: the draft already had this text.");
      } else if (v.wasApproved && res.result.approval_status !== "approved") {
        toast.warning("Draft saved. The G1 approval is now out of date: review and approve again.");
      } else {
        toast.success("Draft saved by the engine.");
      }
      if (kept) toast.info("Changes you made while saving are still unsaved.");
    },
    onError: (e) => {
      const err = e instanceof ApiError ? e : new ApiError(0, "error", (e as Error).message);
      if (err.code === "revision_conflict") setConflict(err);
      else setSaveError(err);
    },
  });

  const reloadLatest = () => {
    setConflict(null);
    discard();
    void draft.refetch();
  };

  const title = project.data?.display_name ?? projectId;
  const projectHref = `/projects/${encodeURIComponent(projectId)}`;
  const lang = outline?.language ?? script?.language ?? undefined;

  const copy = async () => {
    if (!d?.script.data) return;
    try {
      await navigator.clipboard.writeText(scriptText(d.script.data));
      toast.success("Script text copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  const saveDisabledReason = !canEdit
    ? (editing?.reason ?? "Editing is not available.")
    : !dirty
      ? "There are no unsaved edits."
      : errorCount
        ? `Fix ${errorCount} field problem${errorCount === 1 ? "" : "s"} first.`
        : null;
  const saveHelpId = useId();

  return (
    <>
      <PageHeader
        title="Draft"
        badge={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-slate-700">
              {canEdit ? <Pencil aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
              {canEdit ? "Editable" : "Read-only"}
            </span>
            {dirty ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-warning">
                <AlertTriangle aria-hidden className="size-3.5" /> Unsaved changes
              </span>
            ) : null}
            {d?.draft_check ? (
              <StatusBadge
                presentation={approvalPresentation(d.draft_check.approval_status, d.approval_confirmed)}
                prefix="Engine approval status"
              />
            ) : null}
          </span>
        }
        subtitle="Unverified editorial draft. Edit it here; the engine saves, validates and publishes every change. Approval (G1) is not research or fact-checking."
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: title, href: projectHref },
          { label: "Draft" },
        ]}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={projectHref}>
                <ArrowLeft aria-hidden /> Back to Project
              </Link>
            </Button>
            {editing?.supported ? (
              <>
                {dirty ? (
                  <Button variant="outline" onClick={() => setConfirmDiscard(true)} disabled={save.isPending}>
                    <Undo2 aria-hidden /> Discard
                  </Button>
                ) : null}
                <Button
                  onClick={() =>
                    save.mutate({
                      revision: base!.editing.revision!,
                      patch,
                      submitted: edits,
                      wasApproved: base?.draft_check?.approval_status === "approved",
                    })
                  }
                  disabled={Boolean(saveDisabledReason) || save.isPending}
                  aria-describedby={saveHelpId}
                >
                  <Save aria-hidden /> {save.isPending ? "Saving…" : "Save"}
                </Button>
                <span id={saveHelpId} className="sr-only">
                  {save.isPending ? "Saving" : (saveDisabledReason ?? "Save your edits through the engine.")}
                </span>
              </>
            ) : null}
            <Button variant="outline" onClick={() => draft.refetch()} disabled={draft.isFetching}>
              <RefreshCw aria-hidden className={draft.isFetching ? "motion-safe:animate-spin" : undefined} />
              {draft.isFetching ? "Validating…" : "Validate Draft"}
            </Button>
            <Button variant="outline" onClick={copy} disabled={!d?.script.data}>
              <Copy aria-hidden /> Copy text
            </Button>
          </>
        }
      />
      {draft.isLoading ? (
        <LoadingSkeleton rows={3} label="Loading draft" />
      ) : draft.isError ? (
        draft.error instanceof ApiError && draft.error.status === 404 ? (
          <EmptyState title="Project not found" action={<Button asChild><Link href="/">Back to Dashboard</Link></Button>} />
        ) : (
          <ErrorState title="The draft could not be loaded" message={(draft.error as Error).message} onRetry={() => draft.refetch()} />
        )
      ) : d && base ? (
        d.outline.state === "missing" && d.script.state === "missing" ? (
          <EmptyState
            icon={FileX}
            title="No draft yet"
            description="The outline and script have not been generated. Start a draft from the project workspace."
            action={
              <Button asChild>
                <Link href={projectHref}>Back to Project</Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-5">
            {[d.outline, d.script].some((a) => a.state !== "ok") ? (
              <ErrorState
                title="Part of the draft is missing or unreadable"
                message={
                  <ul className="list-disc pl-5">
                    {[d.outline, d.script]
                      .filter((a) => a.state !== "ok")
                      .map((a, i) => (
                        <li key={i}>{a.error}</li>
                      ))}
                  </ul>
                }
              />
            ) : null}
            {script?.notice ? (
              <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
                <strong>Unverified editorial draft.</strong> {script.notice}
              </p>
            ) : null}
            {editing && !editing.can_edit ? (
              <div role="status" className="rounded-lg border bg-surface-muted p-3 text-sm">
                <p>
                  <strong>Editing is not available.</strong> {editing.reason}
                </p>
                {editing.paths.length ? (
                  <p className="mt-1 text-muted-foreground">Depends on the draft: {editing.paths.join(", ")}</p>
                ) : null}
              </div>
            ) : null}
            {recovered && dirty ? (
              <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <strong>Your unsaved edits were restored.</strong> They were kept in this browser tab when you left the
                page ({formatDateTime(recovered)}). Save them, or Discard to go back to the saved draft.
              </div>
            ) : null}
            {drifted ? (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <strong>The draft changed since you started editing.</strong> Saving will be refused so nothing is
                overwritten. Copy your edits, then reload the latest version.
              </div>
            ) : null}
            {saveError ? (
              <div role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
                <p className="font-medium">The edit was not saved. {saveError.message}</p>
                {Array.isArray(saveError.details?.errors) && saveError.details.errors.length ? (
                  <ul className="list-disc pl-5">
                    {(saveError.details.errors as (string | { loc?: string; msg?: string })[]).map((e, i) => (
                      <li key={i}>{typeof e === "string" ? e : `${e.loc ? `${e.loc}: ` : ""}${e.msg ?? ""}`}</li>
                    ))}
                  </ul>
                ) : null}
                {Array.isArray(saveError.details?.paths) && saveError.details.paths.length ? (
                  <p>Depends on the draft: {(saveError.details.paths as string[]).join(", ")}</p>
                ) : null}
              </div>
            ) : null}
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {lastSave && !dirty ? <SaveSummary result={lastSave} /> : null}
              {dirty
                ? `Unsaved edits in ${keys.size} field${keys.size === 1 ? "" : "s"}.${errorCount ? ` ${errorCount} need fixing before saving.` : ""}`
                : null}
            </p>

            <Tabs
              tab={tab}
              setTab={setTab}
              counts={{ outline: edited.outline.size + (patch.outline?.title !== undefined || patch.outline?.thesis_or_question !== undefined ? 1 : 0), script: edited.script.size }}
              validationErrors={d.draft_check?.errors.length ?? 0}
            />

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={-1} className="focus-visible:outline-none">
              {tab === "outline" && outline && limits ? (
                <SplitLayout
                  nav={
                    <SectionNav
                      label="Outline sections"
                      items={[
                        { id: DOC, label: "Title and question", edited: keys.has("outline.title") || keys.has("outline.thesis_or_question") },
                        ...outline.sections.map((s, i) => ({
                          id: s.id,
                          label: `${i + 1}. ${edits.outline.sections[s.id]?.heading ?? s.heading ?? s.id}`,
                          edited: edited.outline.has(s.id),
                        })),
                      ]}
                      selected={selOutline}
                      onSelect={setSelOutline}
                      lang={lang}
                    />
                  }
                >
                  {selOutline === DOC ? (
                    <OutlineDocumentEditor
                      outline={outline}
                      edits={edits.outline}
                      onChange={setOutlineField}
                      errors={errors}
                      readOnly={!canEdit}
                      limits={limits}
                      changed={keys}
                    />
                  ) : (
                    (() => {
                      const i = outline.sections.findIndex((s) => s.id === selOutline);
                      const sec = outline.sections[i];
                      return sec ? (
                        <OutlineSectionEditor
                          key={sec.id}
                          section={sec}
                          index={i}
                          edits={edits.outline.sections[sec.id] ?? {}}
                          onChange={(f, v) => setOutlineSection(sec.id, f, v)}
                          errors={errors}
                          readOnly={!canEdit}
                          limits={limits}
                          lang={lang}
                          changed={keys}
                        />
                      ) : null;
                    })()
                  )}
                </SplitLayout>
              ) : null}

              {tab === "script" && script && limits ? (
                <div className="space-y-4">
                  <div role="group" aria-label="Script view" className="inline-flex flex-wrap rounded-lg border bg-surface p-0.5">
                    {(
                      [
                        ["edit", canEdit ? "Edit sections" : "Sections"],
                        ["full", "Full script"],
                        ["markdown", "Markdown view"],
                      ] as const
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={scriptMode === m}
                        onClick={() => setScriptMode(m)}
                        className="rounded-md px-3 py-1.5 text-sm font-medium aria-pressed:bg-primary aria-pressed:text-white"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {scriptMode === "edit" ? (
                    <SplitLayout
                      nav={
                        <SectionNav
                          label="Script sections"
                          items={script.sections.map((s, i) => ({
                            id: s.outline_section_id,
                            label: `${i + 1}. ${edits.script.sections[s.outline_section_id]?.heading ?? s.heading ?? s.outline_section_id}`,
                            edited: edited.script.has(s.outline_section_id),
                          }))}
                          selected={selScript ?? script.sections[0]?.outline_section_id ?? ""}
                          onSelect={setSelScript}
                          lang={lang}
                        />
                      }
                    >
                      {(() => {
                        const id = selScript ?? script.sections[0]?.outline_section_id;
                        const i = script.sections.findIndex((s) => s.outline_section_id === id);
                        const sec = script.sections[i];
                        return sec ? (
                          <ScriptSectionEditor
                            key={sec.outline_section_id}
                            section={sec}
                            index={i}
                            edits={edits.script.sections[sec.outline_section_id] ?? {}}
                            onChange={(f, v) => setScriptSection(sec.outline_section_id, f, v)}
                            errors={errors}
                            readOnly={!canEdit}
                            limits={limits}
                            lang={lang}
                            changed={keys}
                          />
                        ) : null;
                      })()}
                    </SplitLayout>
                  ) : (
                    <div className="rounded-[var(--radius-panel)] border bg-surface p-5 md:p-8">
                      {dirty ? (
                        <p className="mb-4 text-sm text-warning">This shows the saved draft, without your unsaved edits.</p>
                      ) : null}
                      {scriptMode === "markdown" ? (
                        d.script.markdown ? (
                          <SafeMarkdown lang={script.language}>{d.script.markdown}</SafeMarkdown>
                        ) : (
                          <p className="text-sm text-muted-foreground">script.md is not available.</p>
                        )
                      ) : d.script.data ? (
                        <DraftContent script={d.script.data} />
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}

              {tab === "validation" ? (
                <div className="space-y-6">
                  <DraftValidationPanel check={d.draft_check} error={d.draft_check_error?.message} />
                  {d.available ? (
                    <ApprovalPanel
                      projectId={projectId}
                      draft={d}
                      onValidate={() => draft.refetch()}
                      validating={draft.isFetching}
                      unsaved={dirty}
                    />
                  ) : null}
                </div>
              ) : null}

              {(tab === "outline" && !outline) || (tab === "script" && !script) ? (
                d[tab].markdown ? (
                  <SafeMarkdown>{d[tab].markdown!}</SafeMarkdown>
                ) : (
                  <p className="text-sm text-muted-foreground">This part of the draft is unavailable.</p>
                )
              ) : null}
            </div>
          </div>
        )
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your unsaved edits?"
        description="The fields go back to the saved draft. This cannot be undone."
        confirmLabel="Discard edits"
        cancelLabel="Keep editing"
        destructive
        onConfirm={discard}
      />
      <ConflictDialog
        open={Boolean(conflict)}
        onOpenChange={(o) => !o && setConflict(null)}
        message={conflict?.message ?? ""}
        editsText={editsAsText(patch, outline, script)}
        onReload={reloadLatest}
      />
    </>
  );
}

function SaveSummary({ result }: { result: DraftEditResult["result"] }) {
  if (result.status === "already_current") return <>Nothing changed: the draft already had this text.</>;
  const sb = result.storyboard;
  return (
    <>
      Saved by the engine (revision <code>{result.revision.slice(0, 12)}</code>): {result.changed_files.join(", ")}.
      {sb.resplit_sections.length ? ` Storyboard scenes re-split for ${sb.resplit_sections.join(", ")}.` : ""}
      {sb.briefs_need_review.length ? ` Visual briefs to check: ${sb.briefs_need_review.join(", ")}.` : ""}
      {result.approval_status === "stale" ? " The G1 approval is out of date." : ""}
    </>
  );
}

function Tabs({
  tab,
  setTab,
  counts,
  validationErrors,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: { outline: number; script: number };
  validationErrors: number;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };
  return (
    <div role="tablist" aria-label="Draft workspace" onKeyDown={onKey} className="flex flex-wrap gap-1 border-b">
      {TABS.map((t) => {
        const extra =
          t.id === "validation"
            ? validationErrors
              ? ` (${validationErrors} error${validationErrors === 1 ? "" : "s"})`
              : ""
            : counts[t.id]
              ? ` (${counts[t.id]} unsaved)`
              : "";
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className="-mb-px rounded-t-md border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground aria-selected:border-primary aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:outline-none"
          >
            {t.label}
            {extra}
          </button>
        );
      })}
    </div>
  );
}

function SplitLayout({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,28fr)_minmax(0,72fr)]">
      <aside className="min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-auto">{nav}</aside>
      <div className="min-w-0 rounded-[var(--radius-panel)] border bg-surface p-5 md:p-6">{children}</div>
    </div>
  );
}

function SectionNav({
  label,
  items,
  selected,
  onSelect,
  lang,
}: {
  label: string;
  items: { id: string; label: string; edited: boolean }[];
  selected: string;
  onSelect: (id: string) => void;
  lang?: string;
}) {
  return (
    <nav aria-label={label}>
      <ol className="space-y-1.5" lang={lang}>
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              aria-current={selected === it.id ? "true" : undefined}
              onClick={() => onSelect(it.id)}
              className="flex w-full items-start justify-between gap-2 rounded-lg border bg-surface px-3 py-2 text-left text-sm font-medium hover:bg-surface-muted aria-[current=true]:border-primary aria-[current=true]:bg-surface-muted"
            >
              <span className="min-w-0 break-words">{it.label}</span>
              {it.edited ? (
                <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 text-xs text-warning" lang="en">
                  Edited
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
