"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, FilePlus2, FileSearch, FileUp, Globe, Link2, ListChecks, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { JobCard } from "@/components/job-card";
import { PageHeader } from "@/components/page-header";
import { AddClaimDialog, type NewAnchor } from "@/components/research/add-claim-dialog";
import { AddUrlDialog } from "@/components/research/add-url-dialog";
import { ClaimPanel } from "@/components/research/claim-panel";
import { CollectDialog } from "@/components/research/collect-dialog";
import { HistoryDisclosure } from "@/components/research/decision-panel";
import { DocumentDialog } from "@/components/research/document-dialog";
import { SnapshotReader } from "@/components/research/snapshot-reader";
import { CompletenessPanel, RechecksPanel, UpgradeBanner } from "@/components/research/validation-panels";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ApiError, CLAIM_KINDS, api, type LinkRef, type ResearchClaim, type ResearchSnapshot, type ResearchView as View } from "@/lib/api";
import { qk } from "@/lib/queries";
import { RESEARCH_APPROVAL, claimPresentation, displayUrl, fetchOutcome, humanize } from "@/lib/status";

type Tab = "claims" | "sources" | "validation";
const TABS: { id: Tab; label: string }[] = [
  { id: "claims", label: "Claims" },
  { id: "sources", label: "Sources" },
  { id: "validation", label: "Validation" },
];

export function ResearchView() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => api.project(projectId) });
  const view = useQuery({ queryKey: qk.research(projectId), queryFn: () => api.research(projectId) });
  const [tab, setTab] = useState<Tab>("claims");
  const [jobId, setJobId] = useState<string | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ sourceId: string; edition: ResearchSnapshot | undefined } | null | false>(false);
  const [focusClaim, setFocusClaim] = useState<string | null>(null);
  const v = view.data;
  const activeJob = jobId ?? v?.active_job_id ?? null;
  const lang = project.data?.language ?? undefined;

  const started = (id: string) => {
    setJobId(id);
    void qc.invalidateQueries({ queryKey: qk.research(projectId) });
  };
  const plan = useMutation({
    mutationFn: () => api.researchPlan(projectId, v!.revision!),
    onSuccess: (r) => started(r.job_id),
    onError: (e) => toast.error((e as Error).message),
  });

  const title = project.data?.display_name ?? projectId;
  const projectHref = `/projects/${encodeURIComponent(projectId)}`;
  const g2 = v?.report ? RESEARCH_APPROVAL[v.report.approval_status] : null;
  const editorial = v?.report?.items.find((i) => i.code === "editorial_not_current" && i.blocking);
  // The backend says whether a research job is running; the last job card stays visible.
  const busy = Boolean(v?.active_job_id) || plan.isPending;

  return (
    <>
      <PageHeader
        title="Research"
        badge={g2 ? <StatusBadge presentation={g2} prefix="Engine research approval" /> : undefined}
        subtitle="Claims, sources and evidence passages, as the engine records them. Nothing here marks a claim verified: only a named reviewer's decision does."
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: title, href: projectHref },
          { label: "Research" },
        ]}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={projectHref}>
                <ArrowLeft aria-hidden /> Back to Project
              </Link>
            </Button>
            <Button variant="outline" onClick={() => view.refetch()} disabled={view.isFetching}>
              <RefreshCw aria-hidden className={view.isFetching ? "motion-safe:animate-spin" : undefined} />
              {view.isFetching ? "Checking…" : "Check research"}
            </Button>
          </>
        }
      />
      {view.isLoading ? (
        <LoadingSkeleton rows={3} label="Loading research" />
      ) : view.isError ? (
        view.error instanceof ApiError && view.error.status === 404 ? (
          <EmptyState title="Project not found" action={<Button asChild><Link href="/">Back to Dashboard</Link></Button>} />
        ) : (
          <ErrorState title="The research could not be loaded" message={(view.error as Error).message} onRetry={() => view.refetch()} />
        )
      ) : v ? (
        <div className="space-y-5">
          {v.report_error ? (
            <ErrorState title="The engine could not check the research" message={v.report_error.message} onRetry={() => view.refetch()} />
          ) : null}
          {activeJob ? <JobCard jobId={activeJob} title="Research job" /> : null}
          {!v.started ? (
            <EmptyState
              icon={ListChecks}
              title="No claim inventory yet"
              description={
                editorial
                  ? `Research needs an approved draft first. ${editorial.detail}`
                  : "Prepare claims: the engine lists the factual statements of the narration, without an LLM and without network access."
              }
              action={
                editorial ? (
                  <Button asChild variant="outline">
                    <Link href={`${projectHref}/draft`}>Open the draft</Link>
                  </Button>
                ) : (
                  <Button onClick={() => plan.mutate()} disabled={!v.revision || busy}>
                    <Play aria-hidden /> Prepare claims
                  </Button>
                )
              }
            />
          ) : (
            <>
              <UpgradeBanner projectId={projectId} view={v} />
              <Tabs tab={tab} setTab={setTab} blocking={v.report?.items.filter((i) => i.blocking).length ?? 0} />
              <div role="tabpanel" id={`rpanel-${tab}`} aria-labelledby={`rtab-${tab}`} tabIndex={-1} className="focus-visible:outline-none">
                {tab === "claims" ? (
                  <ClaimsTab view={v} projectId={projectId} lang={lang} onRead={setReading} focus={focusClaim} onFocused={() => setFocusClaim(null)} />
                ) : null}
                {tab === "sources" ? (
                  <SourcesTab
                    view={v}
                    onRead={setReading}
                    onSearch={() => setCollectOpen(true)}
                    onAdd={() => setAddOpen(true)}
                    onImport={() => setImporting(null)}
                    busy={busy}
                  />
                ) : null}
                {tab === "validation" ? (
                  <ValidationTab
                    view={v}
                    projectId={projectId}
                    onClaim={(id) => {
                      setFocusClaim(id);
                      setTab("claims");
                    }}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {v?.revision ? (
        <>
          <CollectDialog
            open={collectOpen}
            onOpenChange={setCollectOpen}
            projectId={projectId}
            revision={v.revision}
            onStarted={started}
          />
          <AddUrlDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            projectId={projectId}
            revision={v.revision}
            networkEnabled={v.network.enabled}
            onStarted={started}
          />
        </>
      ) : null}
      <SnapshotReader
        projectId={projectId}
        snapshotId={reading}
        onClose={() => setReading(null)}
        view={v}
        onOpen={setReading}
        onNewEdition={(sourceId, edition) => {
          setReading(null);
          setImporting({ sourceId, edition });
        }}
      />
      {v && importing !== false ? (
        <DocumentDialog
          key={importing?.sourceId ?? "new"}
          open
          onOpenChange={(o) => (o ? null : setImporting(false))}
          projectId={projectId}
          revision={v.revision}
          newVersionOf={importing}
        />
      ) : null}
    </>
  );
}

function Tabs({ tab, setTab, blocking }: { tab: Tab; setTab: (t: Tab) => void; blocking: number }) {
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
    <div role="tablist" aria-label="Research workspace" onKeyDown={onKey} className="flex flex-wrap gap-1 border-b">
      {TABS.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          id={`rtab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={tab === t.id}
          aria-controls={`rpanel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => setTab(t.id)}
          className="-mb-px rounded-t-md border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground aria-selected:border-primary aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:outline-none"
        >
          {t.label}
          {t.id === "validation" && blocking ? ` (${blocking} blocking)` : ""}
        </button>
      ))}
    </div>
  );
}

function Evidence({ label, refs, onRead }: { label: string; refs: LinkRef[]; onRead: (id: string) => void }) {
  if (!refs.length) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {refs.map((r, i) => (
          <li key={`${r.snapshot_id}-${r.start}-${i}`}>
            <button
              type="button"
              onClick={() => onRead(r.snapshot_id)}
              className="rounded border bg-surface px-2 py-0.5 text-xs hover:bg-surface-muted"
            >
              {r.source_id ?? r.snapshot_id} · {humanize(r.source_type)}
              {r.acquisition && r.acquisition !== "retrieved" ? ` · ${r.acquisition}` : ""}
              {r.is_translation ? " · translation" : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Why research edits are not offered right now, or null. */
function editBlock(view: View): string | null {
  if (!view.editing?.supported) return view.editing?.reason ?? "Editing is not available.";
  if (view.editing.migration_required) return "Upgrade the research records first.";
  if (view.active_job_id) return "A job is running for this project.";
  return null;
}

function ClaimCard({
  c,
  view,
  projectId,
  lang,
  onRead,
  open,
  onToggle,
}: {
  c: ResearchClaim;
  view: View;
  projectId: string;
  lang?: string;
  onRead: (id: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const outdated = (c.review_outdated ?? []).length > 0;
  const planClaim = view.plan?.claims.find((p) => p.id === c.id);
  return (
    <li id={`claim-${c.id}`} className="space-y-2 rounded-lg border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge presentation={claimPresentation(c.status)} prefix="Status" />
        <span className="rounded border px-1.5 text-xs text-muted-foreground">{humanize(c.kind)}</span>
        {c.contested ? <span className="rounded border border-amber-300 px-1.5 text-xs text-warning">Contested</span> : null}
        {outdated ? (
          <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 text-xs text-warning">
            <AlertTriangle aria-hidden className="size-3" /> Needs a new decision
          </span>
        ) : null}
        <code className="text-xs text-muted-foreground">{c.id}</code>
      </div>
      <p lang={lang} className="text-base leading-7">
        {c.assertion}
      </p>
      <p className="text-xs text-muted-foreground">
        Scenes: {c.scenes.join(", ") || "none"}
        {c.flags.length ? ` · flags: ${c.flags.map(humanize).join(", ")}` : ""}
        {` · tool suggestion (not a verdict): ${claimPresentation(c.suggested_status).label}`}
      </p>
      {!open ? (
        <>
          <Evidence label="Supports" refs={c.supports} onRead={onRead} />
          <Evidence label="Contradicts" refs={c.contradicts} onRead={onRead} />
          <Evidence label="Context" refs={c.context} onRead={onRead} />
        </>
      ) : null}
      <Button size="sm" variant="outline" aria-expanded={open} aria-controls={`claim-panel-${c.id}`} onClick={onToggle}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />} {open ? "Close review" : "Review this claim"}
      </Button>
      {open ? (
        <div id={`claim-panel-${c.id}`}>
          <ClaimPanel view={view} projectId={projectId} claim={c} planClaim={planClaim} lang={lang} onRead={onRead} />
        </div>
      ) : null}
    </li>
  );
}

const NEEDS_DECISION = "__outdated";

function ClaimsTab({
  view,
  projectId,
  lang,
  onRead,
  focus,
  onFocused,
}: {
  view: View;
  projectId: string;
  lang?: string;
  onRead: (id: string) => void;
  focus: string | null;
  onFocused: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [openId, setOpenId] = useState<string | null>(focus);
  const [adding, setAdding] = useState<NewAnchor | null>(null);
  if (focus && openId !== focus) {
    setOpenId(focus);
    setFilter("all");
    setKind("all");
    onFocused();
  }
  const claims = view.report?.claims ?? [];
  const statuses = Array.from(new Set(claims.map((c) => c.status)));
  const outdatedCount = claims.filter((c) => (c.review_outdated ?? []).length).length;
  const shown = claims
    .filter((c) => (filter === "all" ? true : filter === NEEDS_DECISION ? (c.review_outdated ?? []).length > 0 : c.status === filter))
    .filter((c) => kind === "all" || c.kind === kind);
  const uncovered = view.report?.coverage.uncovered ?? [];
  const block = editBlock(view);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="claim-filter" className="text-sm font-medium">
          Show
        </label>
        <select id="claim-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border bg-surface px-2 py-1 text-sm">
          <option value="all">All claims ({claims.length})</option>
          {outdatedCount ? <option value={NEEDS_DECISION}>Needs a new decision ({outdatedCount})</option> : null}
          {statuses.map((s) => (
            <option key={s} value={s}>
              {claimPresentation(s).label} ({claims.filter((c) => c.status === s).length})
            </option>
          ))}
        </select>
        <label htmlFor="claim-kind" className="text-sm font-medium">
          Kind
        </label>
        <select id="claim-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border bg-surface px-2 py-1 text-sm">
          <option value="all">All kinds</option>
          {CLAIM_KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => setAdding({ kind: "excerpt" })} disabled={Boolean(block)}>
          <FilePlus2 aria-hidden /> Add a claim…
        </Button>
      </div>
      {block && view.editing?.supported === false ? <p className="text-xs text-muted-foreground">{block}</p> : null}
      {shown.length ? (
        <ul className="space-y-3">
          {shown.map((c) => (
            <ClaimCard key={c.id} c={c} view={view} projectId={projectId} lang={lang} onRead={onRead} open={openId === c.id}
              onToggle={() => setOpenId(openId === c.id ? null : c.id)} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No claims.</p>
      )}
      {uncovered.length ? (
        <section aria-labelledby="uncovered-h" className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
          <h3 id="uncovered-h" className="text-sm font-semibold">
            Sentences not covered by any claim ({uncovered.length})
          </h3>
          <ul className="mt-2 space-y-1 text-sm" lang={lang}>
            {uncovered.map((u) => (
              <li key={`${u.scene_id}-${u.start}`} className="flex flex-wrap items-start gap-2">
                <span>
                  <span className="text-muted-foreground">{u.scene_id}: </span>
                  {u.text}
                </span>
                <Button size="sm" variant="outline" disabled={Boolean(block)}
                  onClick={() => setAdding({ kind: "sentence", scene_id: u.scene_id, start: u.start, end: u.end, text: u.text })}>
                  Add claim…
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {adding ? (
        <AddClaimDialog open onOpenChange={(o) => (o ? null : setAdding(null))} projectId={projectId} revision={view.revision} anchor={adding}
          scenes={view.scenes ?? []} lang={lang} />
      ) : null}
    </div>
  );
}

function SourcesTab({
  view,
  onRead,
  onSearch,
  onAdd,
  onImport,
  busy,
}: {
  view: View;
  onRead: (id: string) => void;
  onSearch: () => void;
  onAdd: () => void;
  onImport: () => void;
  busy: boolean;
}) {
  const snaps = new Map(view.snapshots.map((s) => [s.id, s]));
  const off = !view.network.enabled;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSearch} disabled={off || busy} aria-describedby="net-note">
          <Globe aria-hidden /> Search {view.network.search_provider === "fixture" ? "test sources" : "Wikipedia"}…
        </Button>
        <Button variant="outline" onClick={onAdd} disabled={busy}>
          <Link2 aria-hidden /> Add URL…
        </Button>
        <Button variant="outline" onClick={onImport} disabled={Boolean(editBlock(view))}>
          <FileUp aria-hidden /> Import document…
        </Button>
        <p id="net-note" className="text-xs text-muted-foreground">
          {off
            ? "Network research is turned off on this computer (YTA_RESEARCH_NETWORK=false). URLs can still be queued."
            : "Nothing is contacted until you confirm the exact hosts."}
        </p>
      </div>
      {view.records_error ? <ErrorState title="Research records could not be read" message={view.records_error.message} /> : null}
      {view.sources.length ? (
        <ul className="space-y-2">
          {view.sources.map((s) => {
            const last = s.fetches[s.fetches.length - 1];
            return (
              <li key={s.id} className="space-y-1 rounded-lg border bg-surface p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {s.kind === "document" ? `Imported document: ${snaps.get(s.snapshot_ids[s.snapshot_ids.length - 1])?.title ?? s.id}` : s.host}
                  </span>
                  {s.user_supplied ? <span className="rounded border px-1.5 text-xs">Added by you</span> : null}
                  {s.fixture ? <span className="rounded border border-amber-300 px-1.5 text-xs text-warning">Test data</span> : null}
                  <code className="text-xs text-muted-foreground">{s.id}</code>
                </div>
                {s.url ? <p className="break-all text-xs text-muted-foreground">{displayUrl(s.url)}</p> : null}
                <p className="text-xs">
                  {s.snapshot_ids.length ? `${s.snapshot_ids.length} snapshot(s)` : fetchOutcome(last?.outcome ?? (s.state === "discovered" ? "queued" : s.state))}
                  {last && s.snapshot_ids.length === 0 && last.detail ? ` · ${last.detail}` : ""}
                </p>
                {s.snapshot_ids.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {s.snapshot_ids.map((id) => (
                      <Button key={id} size="sm" variant="outline" onClick={() => onRead(id)}>
                        <FileSearch aria-hidden /> Read {snaps.get(id)?.title ?? id}
                        {s.kind === "document" && s.snapshot_ids.length > 1 ? ` (edition ${s.snapshot_ids.indexOf(id) + 1})` : ""}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No sources yet. Search, or add a URL you chose.</p>
      )}
    </div>
  );
}

function ValidationTab({ view, projectId, onClaim }: { view: View; projectId: string; onClaim: (id: string) => void }) {
  const items = view.report?.items ?? [];
  const blocking = items.filter((i) => i.blocking);
  const notes = items.filter((i) => !i.blocking);
  const cov = view.report?.coverage;
  const block = editBlock(view);
  const item = (i: (typeof items)[number], n: number, tone: string) => (
    <li key={n} className={`flex flex-wrap items-start gap-2 rounded border px-2 py-1 ${tone}`}>
      <span className="min-w-0 flex-1">
        <code className="text-xs">{i.code}</code> {i.detail}
      </span>
      {i.claim_id && view.report?.claims.some((c) => c.id === i.claim_id) ? (
        <Button size="sm" variant="outline" onClick={() => onClaim(i.claim_id!)}>
          Open {i.claim_id}
        </Button>
      ) : null}
    </li>
  );
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Validation (research-check)</h2>
      {cov ? (
        <p className="text-sm">
          Coverage: {cov.covered} of {cov.sentences} narration sentences are covered by a claim.
        </p>
      ) : null}
      <section aria-labelledby="blocking-h">
        <h3 id="blocking-h" className="text-sm font-semibold">
          Blocking ({blocking.length})
        </h3>
        <ul className="mt-2 space-y-1 text-sm">{blocking.map((i, n) => item(i, n, "border-red-200 bg-red-50/60"))}</ul>
      </section>
      {notes.length ? (
        <section aria-labelledby="notes-h">
          <h3 id="notes-h" className="text-sm font-semibold">
            Notes ({notes.length})
          </h3>
          <ul className="mt-2 space-y-1 text-sm">{notes.map((i, n) => item(i, n, ""))}</ul>
        </section>
      ) : null}
      <CompletenessPanel projectId={projectId} view={view} disabled={block} />
      <RechecksPanel projectId={projectId} view={view} disabled={block} />
      <section aria-labelledby="history-h" className="space-y-2 rounded-lg border p-4">
        <h3 id="history-h" className="text-sm font-semibold">
          Review history ({view.review?.history_summary.count ?? 0} entries)
        </h3>
        <p className="text-xs text-muted-foreground">Append-only: every replaced, cleared or removed record is kept, for the life of the project.</p>
        {view.review?.schema_version === "m5-review-0.2" ? <HistoryDisclosure projectId={projectId} label="Show the full history" /> : null}
      </section>
      <p className="text-sm text-muted-foreground">
        The research approval (G2), applying claim IDs to scenes and the export are not in this version yet: use the engine CLI for those.
      </p>
    </div>
  );
}
