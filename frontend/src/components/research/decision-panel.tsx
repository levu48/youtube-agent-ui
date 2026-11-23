"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, History, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditError } from "@/components/research/edit-error";
import { LineField, MIN, REVIEWER_HINT, TextField, present } from "@/components/research/fields";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useResearchEdit } from "@/hooks/use-research-edit";
import { api, type ClaimStatus, type HistoryEntry, type ResearchClaim, type ReviewRecord } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/queries";
import { claimPresentation, humanize } from "@/lib/status";

/** The decisions a reviewer records. "unverified" and the tool's "supported, pending review"
 * are states, not decisions; a decision is removed with "Clear decision". */
const DECISIONS: { status: ClaimStatus; help: string }[] = [
  { status: "verified", help: "The linked evidence supports this exact wording." },
  { status: "disputed", help: "Credible sources disagree; the narration must present it as disputed." },
  { status: "insufficient", help: "The evidence does not support the wording; revise the narration or find evidence." },
  { status: "editorial_nonfactual", help: "An editorial or interpretive span that states no checkable fact." },
];

/** The engine's requirements for a verified decision (research checks.py), shown before it is
 * recorded. research-check applies them; this list only informs the reviewer. */
function verifiedRules(claim: ResearchClaim, contested: boolean): string[] {
  const rules = [
    "At least one supports link to a real saved passage (fixture test pages never count).",
    "A rationale explaining why the evidence supports this exact wording.",
  ];
  if (claim.contradicts.length) rules.push("Contradicting evidence is linked: document how it is resolved for this wording, or mark the claim disputed.");
  if (contested) {
    rules.push("Contested or interpretive: two independent evidence roots (encyclopedias and mirrors do not count), or an exceptional primary basis.");
    rules.push("Contested or interpretive: a documented counter-source search and a counterargument summary.");
  }
  rules.push("Imported documents never count as independent roots, and count as primary sources only once attested.");
  return rules;
}

type Form = {
  status: ClaimStatus | null;
  reviewer: string;
  rationale: string;
  counterargument_summary: string;
  counter_search_done: boolean;
  contradiction_resolution: string;
  narration_qualifies_dispute: boolean;
  exceptional_primary_basis: string;
};

const EMPTY: Form = {
  status: null,
  reviewer: "",
  rationale: "",
  counterargument_summary: "",
  counter_search_done: false,
  contradiction_resolution: "",
  narration_qualifies_dispute: false,
  exceptional_primary_basis: "",
};

function fromRecord(r: ReviewRecord): Form {
  return {
    status: r.status,
    reviewer: r.reviewer ?? "",
    rationale: r.rationale ?? "",
    counterargument_summary: r.counterargument_summary ?? "",
    counter_search_done: Boolean(r.counter_search_done),
    contradiction_resolution: r.contradiction_resolution ?? "",
    narration_qualifies_dispute: Boolean(r.narration_qualifies_dispute),
    exceptional_primary_basis: r.exceptional_primary_basis ?? "",
  };
}

export function DecisionPanel({
  projectId,
  revision,
  claim,
  record,
  contested,
  lang,
  disabled,
}: {
  projectId: string;
  revision: string | null;
  claim: ResearchClaim;
  /** The recorded review for this claim (current or outdated), from research-review.json. */
  record: ReviewRecord | null;
  contested: boolean;
  lang?: string;
  disabled?: string | null;
}) {
  const edit = useResearchEdit(projectId, revision);
  const [form, setForm] = useState<Form>(EMPTY);
  const [open, setOpen] = useState(false);
  const [confirmVerified, setConfirmVerified] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clear, setClear] = useState({ reviewer: "", reason: "" });
  const groupId = useId();
  const outdated = claim.review_outdated ?? [];
  const isOutdated = outdated.length > 0;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const operation = () => ({
    op: "reviews.set",
    claim_id: claim.id,
    status: form.status,
    reviewer: form.reviewer.trim(),
    rationale: form.rationale,
    ...present({
      counterargument_summary: form.status === "disputed" || (form.status === "verified" && contested) ? form.counterargument_summary : undefined,
      contradiction_resolution: form.status === "verified" && claim.contradicts.length ? form.contradiction_resolution : undefined,
      exceptional_primary_basis: form.status === "verified" && contested ? form.exceptional_primary_basis : undefined,
    }),
    ...(form.status === "disputed" ? { narration_qualifies_dispute: form.narration_qualifies_dispute } : {}),
    ...(form.status === "verified" && contested ? { counter_search_done: form.counter_search_done } : {}),
  });

  const save = async () => {
    try {
      await edit.run([operation()]);
      toast.success(`Decision recorded: ${claimPresentation(form.status!).label}`);
      setOpen(false);
      setForm(EMPTY);
    } catch {
      /* shown by EditError; the form keeps its input */
    }
  };
  const submit = () => (form.status === "verified" ? setConfirmVerified(true) : void save());
  const ready = form.status !== null && form.reviewer.trim() && form.rationale.trim();

  return (
    <section aria-label={`Decision for ${claim.id}`} className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Decision</h4>
        <StatusBadge presentation={claimPresentation(claim.status)} prefix="Engine status" />
        {claim.reviewer ? (
          <span className="text-xs text-muted-foreground">
            by {claim.reviewer}
            {record?.reviewed_at && !isOutdated ? `, ${formatDateTime(record.reviewed_at)}` : ""}
          </span>
        ) : null}
      </div>
      {isOutdated ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-warning">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle aria-hidden className="size-4" /> Needs a new decision
          </p>
          <p className="text-foreground">
            The earlier <strong>{claimPresentation(claim.outdated_review?.status ?? "unverified").label}</strong> decision
            {claim.outdated_review?.reviewer ? ` by ${claim.outdated_review.reviewer}` : ""} was made on a different claim or evidence, so it
            no longer counts. What changed: {outdated.map(componentLabel).join("; ")}.
          </p>
        </div>
      ) : null}
      {claim.rationale && !isOutdated ? (
        <p lang={lang} className="text-sm">
          <span className="text-muted-foreground">Rationale: </span>
          {claim.rationale}
        </p>
      ) : null}
      {disabled ? <p className="text-xs text-muted-foreground">{disabled}</p> : null}
      {!open ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => { setForm(EMPTY); setOpen(true); }} disabled={Boolean(disabled)}>
            Record a decision…
          </Button>
          {isOutdated && record ? (
            <Button size="sm" variant="outline" onClick={() => { setForm(fromRecord(record)); setOpen(true); }} disabled={Boolean(disabled)}>
              <RotateCcw aria-hidden /> Confirm again…
            </Button>
          ) : null}
          {record ? (
            <Button size="sm" variant="outline" onClick={() => setClearing(true)} disabled={Boolean(disabled)}>
              Clear decision…
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {isOutdated && record && form.status === record.status ? (
            <p className="text-xs text-muted-foreground">
              Confirming again records the same decision on the current claim and evidence; the earlier record moves to the history. Check
              every field before you save.
            </p>
          ) : null}
          <fieldset className="space-y-1.5" aria-describedby={`${groupId}-note`}>
            <legend className="text-sm font-medium">
              Status<span className="text-danger"> *</span>
            </legend>
            <p id={`${groupId}-note`} className="text-xs text-muted-foreground">
              No status is preselected. The tool suggestion ({claimPresentation(claim.suggested_status).label}) is not a verdict.
            </p>
            {DECISIONS.map((d) => (
              <label key={d.status} className="flex items-start gap-2 text-sm">
                <input type="radio" name={`${groupId}-status`} checked={form.status === d.status} onChange={() => set("status", d.status)} className="mt-1" />
                <span>
                  <span className="font-medium">{claimPresentation(d.status).label}</span>
                  <span className="text-muted-foreground"> · {d.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <LineField label="Reviewer" value={form.reviewer} onChange={(v) => set("reviewer", v)} required hint={REVIEWER_HINT} />
          <TextField label="Rationale" value={form.rationale} onChange={(v) => set("rationale", v)} min={MIN.rationale} required lang={lang}
            hint="Why the evidence supports (or does not support) this exact wording." />
          {form.status === "disputed" ? (
            <>
              <TextField label="Counterargument summary" value={form.counterargument_summary} onChange={(v) => set("counterargument_summary", v)}
                min={MIN.counterargument} lang={lang} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={form.narration_qualifies_dispute} onChange={(e) => set("narration_qualifies_dispute", e.target.checked)} className="mt-1" />
                The narration presents this as disputed.
              </label>
            </>
          ) : null}
          {form.status === "verified" && claim.contradicts.length ? (
            <TextField label="How the contradicting evidence is resolved" value={form.contradiction_resolution}
              onChange={(v) => set("contradiction_resolution", v)} min={MIN.long} lang={lang} />
          ) : null}
          {form.status === "verified" && contested ? (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={form.counter_search_done} onChange={(e) => set("counter_search_done", e.target.checked)} className="mt-1" />
                I searched for counter-sources.
              </label>
              <TextField label="Counterargument summary" value={form.counterargument_summary} onChange={(v) => set("counterargument_summary", v)}
                min={MIN.counterargument} lang={lang} />
              <TextField label="Exceptional primary basis (only if there are fewer than two independent roots)" value={form.exceptional_primary_basis}
                onChange={(v) => set("exceptional_primary_basis", v)} min={MIN.long} lang={lang} />
            </>
          ) : null}
          <EditError error={edit.error} onReload={edit.reload} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!ready || edit.pending || !revision}>
              {edit.pending ? "Saving…" : "Save decision"}
            </Button>
            <Button type="button" variant="outline" onClick={() => { setOpen(false); edit.reset(); }}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={confirmVerified}
        onOpenChange={setConfirmVerified}
        title="Record this claim as verified?"
        description="This is your own judgement as the named reviewer. The engine's research check applies these requirements and will block approval if any is not met:"
        confirmLabel="Record as verified"
        cancelLabel="Go back"
        pending={edit.pending}
        onConfirm={() => {
          setConfirmVerified(false);
          void save();
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {verifiedRules(claim, contested).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </ConfirmDialog>
      <ClearDialog
        open={clearing}
        onOpenChange={setClearing}
        value={clear}
        onChange={setClear}
        pending={edit.pending}
        error={edit.error}
        onReload={edit.reload}
        onConfirm={async () => {
          try {
            await edit.run([{ op: "reviews.clear", claim_id: claim.id, reviewer: clear.reviewer.trim(), reason: clear.reason }]);
            setClearing(false);
            setClear({ reviewer: "", reason: "" });
            toast.success("Decision cleared; it is kept in the history");
          } catch {
            /* shown */
          }
        }}
      />
      <HistoryDisclosure projectId={projectId} kind="claim_review" subjectId={claim.id} label="Decision history" />
    </section>
  );
}

function ClearDialog({
  open,
  onOpenChange,
  value,
  onChange,
  pending,
  error,
  onReload,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  value: { reviewer: string; reason: string };
  onChange: (v: { reviewer: string; reason: string }) => void;
  pending: boolean;
  error: unknown;
  onReload: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Clear this decision?"
      description="The claim becomes unverified. The decision is kept in the review history with your reason."
      confirmLabel="Clear decision"
      cancelLabel="Keep the decision"
      destructive
      pending={pending || !value.reviewer.trim() || !value.reason.trim()}
      onConfirm={onConfirm}
    >
      <div className="space-y-2">
        <LineField label="Reviewer" value={value.reviewer} onChange={(v) => onChange({ ...value, reviewer: v })} required hint={REVIEWER_HINT} />
        <TextField label="Reason" value={value.reason} onChange={(v) => onChange({ ...value, reason: v })} required rows={2} />
        <EditError error={open ? error : null} onReload={onReload} />
      </div>
    </ConfirmDialog>
  );
}

export function componentLabel(c: string): string {
  const [what, id] = c.split(":");
  const words: Record<string, string> = {
    claim: "the claim's wording, kind, contested state or flags",
    anchors: "where the claim sits in the narration",
    "evidence.added": "evidence added",
    "evidence.removed": "evidence removed",
    "evidence.changed": "evidence changed",
    "snapshots.changed": "a cited snapshot changed",
    basis_missing: "the decision predates the current review rules (recorded without a basis)",
  };
  return `${words[what] ?? humanize(what)}${id ? ` (${id})` : ""}`;
}

const ACTIONS: Record<string, string> = {
  replaced: "Replaced",
  cleared: "Cleared",
  updated: "Updated",
  removed: "Removed",
  migrated: "Records upgraded",
};

const HISTORY_PAGE = 200; // the backend maximum (HISTORY_PAGE_MAX)

/** The append-only history from the engine's review file, loaded when opened. The backend
 * pages it in ascending `seq` (oldest first): `after_seq` asks for the entries after a seq,
 * so "Load more" appends newer entries below the ones shown. */
export function HistoryDisclosure({
  projectId,
  kind,
  subjectId,
  label,
  pageSize = HISTORY_PAGE,
}: {
  projectId: string;
  kind?: string;
  subjectId?: string;
  label: string;
  pageSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const q = useInfiniteQuery({
    queryKey: [...qk.history(projectId, subjectId), kind ?? "all"],
    queryFn: ({ pageParam }) => api.researchHistory(projectId, { kind, subject_id: subjectId, after_seq: pageParam || undefined, limit: pageSize }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more && last.next_after_seq !== null ? last.next_after_seq : undefined),
    enabled: open,
  });
  const pages = q.data?.pages ?? [];
  // One entry per seq, in seq order, even if a page overlaps an earlier one.
  const entries = [...new Map(pages.flatMap((p) => p.entries).map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
  const latest = pages.at(-1);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="text-sm">
      <summary className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
        <History aria-hidden className="size-4" /> {label}
      </summary>
      <div className="mt-2 space-y-2">
        {q.isLoading ? <p className="text-muted-foreground">Loading…</p> : null}
        {q.isError && !pages.length ? <p className="text-danger">{(q.error as Error).message}</p> : null}
        {pages.some((p) => p.chain_ok === false) ? (
          <p role="alert" className="text-danger">
            The engine reports that this history is not intact (history_tampered).
          </p>
        ) : null}
        {pages.length && !entries.length ? <p className="text-muted-foreground">No earlier records.</p> : null}
        {entries.length ? (
          <ol className="space-y-2">
            {entries.map((e) => (
              <HistoryItem key={e.seq} e={e} />
            ))}
          </ol>
        ) : null}
        {q.isFetchNextPageError ? (
          <p role="alert" className="text-danger">
            Could not load more history: {(q.error as Error).message}
          </p>
        ) : null}
        {latest?.has_more ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "Loading…" : q.isFetchNextPageError ? "Try again" : "Load more"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Showing {entries.length} entries, oldest first; later entries follow.
            </span>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function HistoryItem({ e }: { e: HistoryEntry }) {
  const prev = e.previous as Record<string, unknown>;
  return (
    <li className="rounded border bg-surface-muted/50 p-2">
      <p>
        <span className="font-medium">#{e.seq} {ACTIONS[e.action] ?? humanize(e.action)}</span>
        <span className="text-muted-foreground"> · {humanize(e.kind)} · {formatDateTime(e.at)}{e.by_reviewer ? ` · by ${e.by_reviewer}` : ""}</span>
      </p>
      {e.reason ? <p>Reason: {e.reason}</p> : null}
      {typeof prev.status === "string" ? (
        <p>
          Previous: {claimPresentation(prev.status).label}
          {typeof prev.reviewer === "string" ? ` by ${prev.reviewer}` : ""}
          {typeof prev.rationale === "string" ? ` — ${prev.rationale}` : ""}
        </p>
      ) : null}
      {e.outdated_components.length ? <p className="text-xs text-muted-foreground">Outdated: {e.outdated_components.map(componentLabel).join("; ")}</p> : null}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted-foreground">Previous record (as stored)</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(e.previous, null, 2)}</pre>
      </details>
    </li>
  );
}
