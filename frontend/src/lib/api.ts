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

export interface DraftView {
  available: boolean;
  outline: ArtifactView<Outline>;
  script: ArtifactView<Script>;
  draft_check: DraftCheck | null;
  draft_check_error: string | null;
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
  draftCheck: (id: string) => request<DraftCheck>(`/projects/${encodeURIComponent(id)}/draft-check`),
  draftAvailable: (id: string) =>
    request<{ available: boolean }>(`/projects/${encodeURIComponent(id)}/draft-available`),
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
  cancelJob: (id: string) => post<Job>(`/jobs/${encodeURIComponent(id)}/cancel`),
  eventsUrl: (id: string, after: number) =>
    `${BASE}/jobs/${encodeURIComponent(id)}/events?after=${after}`,
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}
