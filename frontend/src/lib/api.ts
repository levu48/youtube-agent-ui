/**
 * Typed client for the local backend (`/api/v1`, proxied same-origin by Next.js).
 * Types mirror the Pydantic schemas in backend/app/schemas.py.
 */

export type Language = "en" | "vi";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export interface Stage {
  stage: string;
  status: string;
  mode: string | null;
  detail: string | null;
  next_action: string | null;
}

export interface StatusSummary {
  available: boolean;
  stages: Stage[];
  current_stage: Stage | null;
  error: string | null;
  error_code?: string | null;
}

export interface Job {
  id: string;
  project_id: string;
  type: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  message: string | null;
  error_message: string | null;
  error_code: string | null;
  cancel_requested: boolean;
  provider: string | null;
  model: string | null;
  from_stage: string | null;
}

export interface JobEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface JobEventPage {
  job_id: string;
  status: JobStatus;
  events: JobEvent[];
  next_after: number;
  has_more: boolean;
}

export interface PublicError {
  code: string;
  message: string;
}

export interface JobDetail extends Job {
  events: JobEvent[];
  events_truncated: boolean;
}

export interface Project {
  id: string;
  slug: string;
  display_name: string;
  location: string;
  created_at: string;
  updated_at: string;
  idea: string | null;
  language: Language | null;
  duration_seconds: number | null;
  audience: string | null;
  tone: string | null;
  guidance: string | null;
  input_error: string | null;
  last_activity: string;
  active_job: Job | null;
}

export interface ProjectSummary extends Project {
  status: StatusSummary;
}

export interface ProjectCreateInput {
  slug: string;
  idea: string;
  language: Language;
  duration_seconds: number;
  audience?: string | null;
  tone?: string | null;
  guidance?: string | null;
}

export interface LocationPreview {
  slug: string;
  location: string;
  available: boolean;
  reason: string | null;
}

export interface EngineInfo {
  available: boolean;
  version: string | null;
  repo: string;
  reason: string | null;
  capabilities: string[];
}

export interface OllamaModel {
  name: string;
  size_bytes: number | null;
  parameter_size: string | null;
  quantization: string | null;
}

export interface OllamaInfo {
  available: boolean;
  base_url: string;
  models: OllamaModel[];
  default_model: string;
  default_model_installed: boolean;
  reason: string | null;
}

export interface SystemConfig {
  projects_root: string;
  default_language: Language;
  default_model: string;
  providers: string[];
}

export interface DraftJobInput {
  provider: "ollama" | "fixture";
  model?: string | null;
  from_stage: "outline" | "script" | "storyboard";
}

export interface OutlineSection {
  id: string;
  heading: string;
  role: string | null;
  purpose: string | null;
  key_points: string[];
  claims_to_investigate: string[];
  estimated_duration_seconds: number | null;
}

export interface ReviewFlag {
  kind: string;
  excerpt: string | null;
  note: string | null;
  origin: string | null;
}

export interface ScriptSection {
  outline_section_id: string;
  heading: string;
  narration: string;
  summary: string | null;
  target_duration_seconds: number | null;
  estimated_duration_seconds: number | null;
  spoken_units?: number | null;
  editorial_notes?: string[];
  review_flags: ReviewFlag[];
}

export type ArtifactState = "ok" | "missing" | "malformed";

export interface ArtifactView<T> {
  state: ArtifactState;
  error: string | null;
  data: T | null;
  markdown: string | null;
}

export interface Outline {
  title: string;
  thesis_or_question: string | null;
  language: string | null;
  target_duration_seconds: number | null;
  notice: string | null;
  generated_by: string | null;
  verification: string | null;
  sections: OutlineSection[];
}

export interface Script {
  title: string;
  language: string | null;
  target_duration_seconds: number | null;
  notice: string | null;
  generated_by: string | null;
  verification: string | null;
  sections: ScriptSection[];
}

export interface DraftCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  review_blockers: string[];
  approval_status: string;
  approval_changed?: string[];
  /** The engine's own draft revision (engines with D-117); absent on older engines. */
  revision?: string;
  needs_visuals?: string[];
  flag_counts?: Record<string, number>;
  timing?: {
    target_seconds: number;
    estimated_seconds: number;
    deviation: number;
    tolerance: number;
    within_tolerance: boolean;
  } | null;
  scenes?: number;
}

/** The engine's review.json, for display only. Whether it is current comes from
 * `draft_check.approval_status`, never from this record. */
export interface ApprovalRecord {
  status: string | null;
  reviewer: string | null;
  approved_at: string | null;
  comment: string | null;
  artifacts: Record<string, string>;
  unresolved_blockers: string[];
  meaning: string | null;
}

export interface DraftView {
  available: boolean;
  outline: ArtifactView<Outline>;
  script: ArtifactView<Script>;
  draft_check: DraftCheck | null;
  draft_check_error: PublicError | null;
  /** The version the reviewer validated: the engine's revision when it reports one, else a UI
   * hash of the checked files. Null when the report could not be verified (see the reason). */
  review_token: string | null;
  review_token_reason?: string | null;
  /** "engine": the engine checks the revision under its lock; "ui": the UI checks it. */
  review_mode?: "engine" | "ui" | null;
  approval: ApprovalRecord | null;
  /** False when the engine reports approved but the UI could not confirm that approval covers
   * the version the reviewer validated. Null when nothing is approved. */
  approval_confirmed?: boolean | null;
  active_job_id: string | null;
}

/** Field limits for edits; they mirror the engine's draft-edit patch (D-117). */
export interface EditLimits {
  title: number;
  thesis_or_question: number;
  heading: number;
  purpose: number;
  key_point: number;
  key_points: number;
  claims_to_investigate: number;
  narration: number;
  summary: number;
  editorial_note: number;
  editorial_notes: number;
}

/** Whether the engine allows an edit now (decided by an engine dry run). */
export interface Editing {
  supported: boolean;
  can_edit: boolean;
  /** The engine's draft revision; every save is based on it. */
  revision: string | null;
  reason: string | null;
  reason_code: string | null;
  paths: string[];
  limits: EditLimits;
}

export interface EditableDraft extends DraftView {
  editing: Editing;
}

export interface OutlineSectionPatch {
  id: string;
  heading?: string;
  purpose?: string;
  key_points?: string[];
  claims_to_investigate?: string[];
}

export interface ScriptSectionPatch {
  outline_section_id: string;
  heading?: string;
  narration?: string;
  summary?: string;
  editorial_notes?: string[];
}

export interface DraftPatch {
  outline?: { title?: string; thesis_or_question?: string; sections?: OutlineSectionPatch[] };
  script?: { sections: ScriptSectionPatch[] };
}

export interface DraftEditInput extends DraftPatch {
  expected_revision: string;
  dry_run?: boolean;
}

export interface DraftEditResult {
  result: {
    status: "published" | "already_current" | "would_publish";
    dry_run: boolean;
    previous_revision: string;
    revision: string;
    changed_files: string[];
    human_edited: string[];
    storyboard: {
      resplit_sections: string[];
      scenes_added: string[];
      scenes_removed: string[];
      briefs_need_review: string[];
    };
    check: { ok: boolean; errors: string[]; warnings: string[]; review_blockers: string[] };
    approval_status: string;
    approval_changed: string[];
  };
  draft?: EditableDraft;
}

export interface ApproveInput {
  reviewer: string;
  comment?: string | null;
  confirm: true;
  review_token: string;
}

export interface ApproveResult {
  already_approved: boolean;
  approved_version_matches: boolean;
  approval: ApprovalRecord | null;
  approval_confirmed?: boolean | null;
  draft_check: DraftCheck | null;
  draft_check_error: PublicError | null;
  review_token: string | null;
  review_token_reason?: string | null;
  review_mode?: "engine" | "ui" | null;
  status: StatusSummary;
}

// ---------------------------------------------------------------------- research (M3)

export interface ResearchItem {
  code: string;
  claim_id: string | null;
  detail: string;
  blocking: boolean;
  refs?: Record<string, unknown> | null;
}

export interface LinkRef {
  snapshot_id: string;
  source_id: string | null;
  start: number;
  end: number;
  source_type: string;
  acquisition?: string | null;
  evidence_root: string | null;
  is_translation: boolean;
  translator: string | null;
}

export interface ResearchClaim {
  id: string;
  kind: string;
  assertion: string;
  contested: boolean;
  flags: string[];
  status: string;
  suggested_status: string;
  scenes: string[];
  supports: LinkRef[];
  contradicts: LinkRef[];
  context: LinkRef[];
  independent_roots: number;
  quotation_basis: string | null;
  reviewer: string | null;
  rationale: string | null;
  review_outdated?: string[];
  outdated_review?: { status: string; reviewer: string | null; reviewed_at: string | null } | null;
}

export interface ResearchReport {
  approvable: boolean;
  approval_status: "not_approved" | "approved" | "stale";
  applied: boolean;
  counts: Record<string, number>;
  items: ResearchItem[];
  claims: ResearchClaim[];
  coverage: { sentences: number; covered: number; uncovered: { scene_id: string; start: number; end: number; text: string }[] };
  revision: string;
}

export interface ResearchSource {
  id: string;
  kind: "web" | "document";
  url: string | null;
  host: string | null;
  state: string;
  fixture: boolean;
  user_supplied: boolean;
  candidate_for: string[];
  snapshot_ids: string[];
  discoveries: { provider: string; query: string; language: string; title: string; snippet: string }[];
  fetches: { at: string | null; outcome: string; detail: string | null; final_url: string | null; snapshot_id: string | null }[];
}

export interface ResearchSnapshot {
  id: string;
  source_id: string;
  acquisition: "retrieved" | "imported" | "fixture";
  requested_url: string | null;
  final_url: string | null;
  canonical_url: string | null;
  retrieved_at: string | null;
  title: string | null;
  publisher: string | null;
  author: string | null;
  published_at: string | null;
  language: string | null;
  text_sha256: string;
  chars: number;
  limitations: string[];
  fixture: boolean;
  document_provenance: Record<string, string | null> | null;
}

export interface ResearchView {
  report: ResearchReport | null;
  report_error: { code: string; message: string } | null;
  revision: string | null;
  started: boolean;
  sources: ResearchSource[];
  snapshots: ResearchSnapshot[];
  evidence: Record<string, unknown>[];
  records_error: { code: string; message: string } | null;
  stage: Stage | null;
  network: { enabled: boolean; search_provider: string };
  active_job_id: string | null;
}

export interface CollectParams {
  languages: ("vi" | "en")[];
  claim_ids: string[];
  max_queries: number;
  max_results_per_query: number;
  max_pages: number;
}

export interface CollectPreview {
  revision: string;
  hosts: string[];
  search_hosts: string[];
  provider_result_hosts: string[];
  known_targets: { source_id: string; url: string; host: string; reason: string }[];
  plan_sha256: string;
  queries: number;
  fetch: boolean;
  search_provider: string;
}

export interface JobStarted {
  job_id: string;
  project_id: string;
  status: JobStatus;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get fields(): Record<string, string> {
    const f = this.details?.fields;
    return f && typeof f === "object" ? (f as Record<string, string>) : {};
  }
}

const BASE = "/api/v1";
let csrfPromise: Promise<string> | null = null;

function csrfToken(refresh = false): Promise<string> {
  if (!csrfPromise || refresh) {
    csrfPromise = fetch(`${BASE}/session`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new ApiError(r.status, "session_failed", "Backend session unavailable.");
        return r.json();
      })
      .then((b: { csrf_token: string }) => b.csrf_token)
      .catch((e) => {
        csrfPromise = null;
        throw e;
      });
  }
  return csrfPromise;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
      ?.error;
    if (err) throw new ApiError(res.status, err.code ?? "error", err.message ?? "Request failed", err.details);
    const message =
      res.status >= 500 && res.status < 600
        ? "The local backend is not responding. Is it running?"
        : `Request failed (${res.status}).`;
    throw new ApiError(res.status, "http_error", message);
  }
  return body as T;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", await csrfToken());
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the local backend. Is it running?");
  }
  if (res.status === 403 && method !== "GET" && retry) {
    const clone = res.clone();
    const body = await clone.json().catch(() => null);
    if (body?.error?.code === "csrf_failed") {
      await csrfToken(true);
      return request<T>(path, init, false);
    }
  }
  return parse<T>(res);
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  engine: () => request<EngineInfo>("/system/engine"),
  ollama: () => request<OllamaInfo>("/system/ollama"),
  config: () => request<SystemConfig>("/system/config"),
  projects: () => request<ProjectSummary[]>("/projects"),
  project: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
  projectStatus: (id: string) => request<StatusSummary>(`/projects/${encodeURIComponent(id)}/status`),
  draft: (id: string) => request<DraftView>(`/projects/${encodeURIComponent(id)}/draft`),
  draftEditable: (id: string) => request<EditableDraft>(`/projects/${encodeURIComponent(id)}/draft/editable`),
  editDraft: (id: string, input: DraftEditInput) =>
    post<DraftEditResult>(`/projects/${encodeURIComponent(id)}/draft/edit`, input),
  draftCheck: (id: string) => request<DraftCheck>(`/projects/${encodeURIComponent(id)}/draft-check`),
  draftAvailable: (id: string) =>
    request<{ available: boolean }>(`/projects/${encodeURIComponent(id)}/draft-available`),
  approveDraft: (id: string, input: ApproveInput) =>
    post<ApproveResult>(`/projects/${encodeURIComponent(id)}/draft/approve`, input),
  locationPreview: (slug: string) =>
    request<LocationPreview>(`/projects/location-preview?slug=${encodeURIComponent(slug)}`),
  discoverable: () => request<{ slug: string; location: string }[]>("/projects/discoverable"),
  register: (slug: string) => post<Project>("/projects/register", { slug }),
  createProject: (input: ProjectCreateInput) =>
    post<{ id: string; status: string; next_action: string }>("/projects", input),
  startDraft: (id: string, input: DraftJobInput) =>
    post<{ job_id: string; project_id: string; status: JobStatus }>(
      `/projects/${encodeURIComponent(id)}/draft-jobs`,
      input,
    ),
  jobs: (params: { projectId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.projectId) q.set("project_id", params.projectId);
    if (params.limit) q.set("limit", String(params.limit));
    return request<Job[]>(`/jobs?${q.toString()}`);
  },
  job: (id: string, events = 500) =>
    request<JobDetail>(`/jobs/${encodeURIComponent(id)}?events=${events}`),
  eventsPage: (id: string, after: number, limit = 1000) =>
    request<JobEventPage>(`/jobs/${encodeURIComponent(id)}/events/page?after=${after}&limit=${limit}`),
  cancelJob: (id: string) => post<Job>(`/jobs/${encodeURIComponent(id)}/cancel`),
  research: (id: string) => request<ResearchView>(`/projects/${encodeURIComponent(id)}/research`),
  researchSnapshot: (id: string, snapshotId: string) =>
    request<{ snapshot: ResearchSnapshot; text: string }>(
      `/projects/${encodeURIComponent(id)}/research/snapshots/${encodeURIComponent(snapshotId)}`,
    ),
  researchPlan: (id: string, expected_revision: string) =>
    post<JobStarted>(`/projects/${encodeURIComponent(id)}/research/plan`, { expected_revision }),
  collectPreview: (id: string, body: CollectParams & { expected_revision: string }) =>
    post<CollectPreview>(`/projects/${encodeURIComponent(id)}/research/collect/preview`, body),
  collect: (
    id: string,
    body: CollectParams & { expected_revision: string; network: true; plan_sha256: string; allow_hosts: string[] },
  ) => post<JobStarted>(`/projects/${encodeURIComponent(id)}/research/collect`, body),
  addSource: (
    id: string,
    body: { expected_revision: string; url: string; fetch: "queue" | "live"; network?: boolean; allow_hosts?: string[] },
  ) => post<JobStarted>(`/projects/${encodeURIComponent(id)}/research/sources`, body),
  eventsUrl: (id: string, after: number) =>
    `${BASE}/jobs/${encodeURIComponent(id)}/events?after=${after}`,
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}
