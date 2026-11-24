"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileUp, Globe, ImageIcon, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { JobCard } from "@/components/job-card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { AcquireDialog } from "@/components/visuals/acquire-dialog";
import { AssetFacts } from "@/components/visuals/asset-facts";
import { CandidateGallery } from "@/components/visuals/candidate-gallery";
import { GatesPanel, NOT_CERTIFIED } from "@/components/visuals/gates-panel";
import { ImportDialog } from "@/components/visuals/import-dialog";
import { RecoveryBanner, blockReason } from "@/components/visuals/recovery-banner";
import { ApiError, api, type VisualsView as View } from "@/lib/api";
import { qk } from "@/lib/queries";
import { applyStatePresentation, g3Presentation, humanize } from "@/lib/status";

type Tab = "scenes" | "applied" | "report";
const TABS: { id: Tab; label: string }[] = [
  { id: "scenes", label: "Scenes and candidates" },
  { id: "applied", label: "Applied images" },
  { id: "report", label: "Engine report" },
];

const G1_CURRENT = new Set(["approved", "stale_after_apply"]);

/** Engine text, rendered only when it is text: a malformed record never breaks the page. */
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function VisualsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => api.project(projectId) });
  const view = useQuery({ queryKey: qk.visuals(projectId), queryFn: () => api.visuals(projectId) });
  const [tab, setTab] = useState<Tab>("scenes");
  const [jobId, setJobId] = useState<string | null>(null);
  const [acquireOpen, setAcquireOpen] = useState(false);
  const [importScene, setImportScene] = useState<string | null | false>(false);
  const failed = useRef(new Set<string>());
  const v = view.data;
  const activeJob = jobId ?? v?.active_job_id ?? null;
  const lang = project.data?.language ?? undefined;

  const started = (id: string) => {
    setJobId(id);
    void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
  };
  // An image that does not load is outdated or no longer intact: refresh the view once per
  // URL, so the page shows the engine's current facts (never retried in a loop).
  const onImageError = useCallback(
    (url: string) => {
      if (failed.current.has(url)) return;
      failed.current.add(url);
      void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
    },
    [qc, projectId],
  );
  const plan = useMutation({
    mutationFn: () => api.visualsPlan(projectId, v!.revision),
    onSuccess: (r) => started(r.job_id),
    onError: (e) => {
      toast.error((e as Error).message);
      if (e instanceof ApiError && ["revision_conflict", "recovery_required"].includes(e.code)) {
        void qc.invalidateQueries({ queryKey: qk.visuals(projectId) });
      }
    },
  });

  const title = project.data?.display_name ?? projectId;
  const projectHref = `/projects/${encodeURIComponent(projectId)}`;
  const block = v ? blockReason(v) : null;
  const busy = Boolean(block) || plan.isPending;

  return (
    <>
      <PageHeader
        title="Visuals"
        badge={v ? <StatusBadge presentation={g3Presentation(v.gates.g3.status)} prefix="Engine visuals gate" /> : undefined}
        subtitle="Planned visuals, image candidates with their licence evidence, and the images the draft shows, as the engine reports them."
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: title, href: projectHref },
          { label: "Visuals" },
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
              {view.isFetching ? "Checking…" : "Check visuals"}
            </Button>
          </>
        }
      />
      {view.isLoading ? (
        <LoadingSkeleton rows={3} label="Loading visuals" />
      ) : view.isError ? (
        view.error instanceof ApiError && view.error.status === 404 ? (
          <EmptyState title="Project not found" action={<Button asChild><Link href="/">Back to Dashboard</Link></Button>} />
        ) : (
          <ErrorState title="The visuals could not be loaded" message={(view.error as Error).message} onRetry={() => view.refetch()} />
        )
      ) : v ? (
        <div className="space-y-5">
          <RecoveryBanner view={v} />
          {activeJob ? <JobCard jobId={activeJob} title="Visuals job" /> : null}
          <GatesPanel view={v} />
          {!v.plan ? (
            <EmptyState
              icon={ImageIcon}
              title="No visual plan yet"
              description={
                G1_CURRENT.has(v.gates.g1.status)
                  ? "Plan visuals: the engine lists one planned visual per scene, with its kind and search query. No network is used."
                  : "Visuals need an approved draft first (gate G1)."
              }
              action={
                G1_CURRENT.has(v.gates.g1.status) ? (
                  <Button onClick={() => plan.mutate()} disabled={busy} title={block ?? undefined}>
                    <Play aria-hidden /> Plan visuals
                  </Button>
                ) : (
                  <Button asChild variant="outline">
                    <Link href={`${projectHref}/draft`}>Open the draft</Link>
                  </Button>
                )
              }
            />
          ) : (
            <>
              <Toolbar view={v} block={block} onSearch={() => setAcquireOpen(true)} onImport={() => setImportScene(null)} />
              <Tabs tab={tab} setTab={setTab} />
              <div role="tabpanel" id={`vpanel-${tab}`} aria-labelledby={`vtab-${tab}`} tabIndex={-1} className="focus-visible:outline-none">
                {tab === "scenes" ? (
                  <ScenesTab view={v} projectId={projectId} lang={lang} block={block} onImport={(s) => setImportScene(s)} onImageError={onImageError} />
                ) : null}
                {tab === "applied" ? <AssetFacts view={v} projectId={projectId} onImageError={onImageError} /> : null}
                {tab === "report" ? <ReportTab view={v} /> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {v?.plan ? (
        <>
          <AcquireDialog
            open={acquireOpen && !block}
            onOpenChange={setAcquireOpen}
            projectId={projectId}
            revision={v.revision}
            scenes={v.plan.scenes}
            provider={v.network.search_provider}
            onStarted={started}
          />
          {importScene !== false && !block ? (
            <ImportDialog
              key={importScene ?? "any"}
              open
              onOpenChange={(o) => (o ? null : setImportScene(false))}
              projectId={projectId}
              revision={v.revision}
              scenes={v.plan.scenes}
              initialScene={importScene ?? undefined}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Toolbar({ view, block, onSearch, onImport }: { view: View; block: string | null; onSearch: () => void; onImport: () => void }) {
  const off = !view.network.enabled;
  const name = view.network.search_provider === "fixture" ? "test images" : "Wikimedia Commons";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSearch} disabled={off || Boolean(block)} aria-describedby="vnet-note">
          <Globe aria-hidden /> Search {name}…
        </Button>
        <Button variant="outline" onClick={onImport} disabled={Boolean(block)}>
          <FileUp aria-hidden /> Import image…
        </Button>
        <p id="vnet-note" className="text-xs text-muted-foreground">
          {block ??
            (off
              ? "Network visuals actions are turned off on this computer (YTA_VISUALS_NETWORK=false). Imports still work."
              : "Nothing is contacted until you confirm the exact search and hosts.")}
        </p>
      </div>
      {!view.catalog_trusted ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-danger">
          The candidate catalogue was changed outside the engine, so nothing in it is trusted or shown: {view.catalog_problems.join("; ")}. A
          new search rebuilds it.
        </p>
      ) : null}
      {!view.editing.supported ? <p className="text-xs text-muted-foreground">{view.editing.reason}</p> : null}
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
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
    <div role="tablist" aria-label="Visuals workspace" onKeyDown={onKey} className="flex flex-wrap gap-1 border-b">
      {TABS.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          id={`vtab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={tab === t.id}
          aria-controls={`vpanel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => setTab(t.id)}
          className="-mb-px rounded-t-md border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground aria-selected:border-primary aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:outline-none"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ScenesTab({
  view,
  projectId,
  lang,
  block,
  onImport,
  onImageError,
}: {
  view: View;
  projectId: string;
  lang?: string;
  block: string | null;
  onImport: (sceneId: string) => void;
  onImageError: (url: string) => void;
}) {
  const plan = new Map(view.plan!.scenes.map((s) => [s.scene_id, s]));
  const report = new Map(view.report.scenes.map((s) => [s.scene_id, s]));
  const selection = new Map((view.selection?.scenes ?? []).map((s) => [s.scene_id, s.shots ?? []]));
  return (
    <ul className="space-y-4">
      {view.scenes.map((s) => {
        const p = plan.get(s.scene_id);
        const r = report.get(s.scene_id);
        const shots = selection.get(s.scene_id) ?? [];
        return (
          <li key={s.scene_id} id={`scene-${s.scene_id}`} className="space-y-3 rounded-[var(--radius-card)] border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{s.scene_id}</h3>
              {p ? <span className="rounded border px-1.5 text-xs text-muted-foreground">{humanize(p.desired_kind)}</span> : null}
              <StatusBadge presentation={applyStatePresentation(s.apply_state)} prefix="Apply state" />
              {view.recovery_required ? <span className="text-xs text-danger">({NOT_CERTIFIED})</span> : null}
              {p?.requires_manual_asset ? (
                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-xs text-warning">Needs an image you provide</span>
              ) : null}
            </div>
            {view.narration[s.scene_id] ? (
              <p lang={lang} className="text-sm leading-6">
                {view.narration[s.scene_id]}
              </p>
            ) : null}
            {p ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Brief</dt>
                <dd lang={lang}>{text(p.brief) ?? "—"}</dd>
                <dt className="text-muted-foreground">Search</dt>
                <dd>{p.search_enabled ? (text(p.search_query) ?? "—") : "Off for this scene"}</dd>
                {r ? (
                  <>
                    <dt className="text-muted-foreground">Engine</dt>
                    <dd>
                      {humanize(String(r.disposition))}
                      {r.messages?.length ? ` · ${r.messages.map(String).join("; ")}` : ""}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Selected</dt>
                <dd>{shots.length ? shots.map((x) => x.candidate_id).join(", ") : "Nothing selected"}</dd>
                <dt className="text-muted-foreground">In the draft</dt>
                <dd>{s.draft_shots.length ? `${s.draft_shots.length} shot(s)` : "No shots"}</dd>
              </dl>
            ) : null}
            <CandidateGallery view={view} projectId={projectId} sceneId={s.scene_id} brief={text(p?.brief) ?? undefined} onImageError={onImageError} />
            <Button size="sm" variant="outline" onClick={() => onImport(s.scene_id)} disabled={Boolean(block)}>
              <FileUp aria-hidden /> Import an image for {s.scene_id}…
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function ReportTab({ view }: { view: View }) {
  const list = (label: string, items: unknown[], tone: string) =>
    items.length ? (
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">
          {label} ({items.length})
        </h3>
        <ul className="space-y-1 text-sm">
          {items.map((x, i) => (
            <li key={i} className={`rounded border px-2 py-1 ${tone}`}>
              {typeof x === "string" ? x : JSON.stringify(x)}
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Render ready (engine evaluation): <strong>{view.report.render_ready ? "yes" : "no"}</strong>
        {view.recovery_required ? <span className="text-danger"> ({NOT_CERTIFIED})</span> : null}
      </p>
      {list("Errors", view.report.errors ?? [], "border-red-200 bg-red-50/60")}
      {list("Unpublishable images", view.report.unpublishable ?? [], "border-amber-200 bg-amber-50/60")}
      {list("Image integrity", view.report.image_integrity ?? [], "border-red-200 bg-red-50/60")}
      {list("Warnings", view.report.warnings ?? [], "")}
      <p className="text-xs text-muted-foreground">
        Snapshot revision <code className="font-mono">{view.revision.slice(0, 12)}</code>: every fact on this page comes from
        this one engine read.
      </p>
    </div>
  );
}
