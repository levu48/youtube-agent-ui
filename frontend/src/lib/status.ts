/**
 * The single status-to-presentation mapping (docs/ui-design.md §5). Every status has a
 * text label and an icon; colour is never the only signal. Job status (UI-owned process
 * lifecycle) and stage status (engine-reported) are mapped separately on purpose.
 */
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  Loader2,
  Lock,
  UserCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { JobStatus, Stage, StatusSummary } from "@/lib/api";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface Presentation {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  spin?: boolean;
}

export const JOB_STATUS: Record<JobStatus, Presentation> = {
  queued: { label: "Queued", tone: "neutral", icon: Clock },
  running: { label: "Running", tone: "info", icon: Loader2, spin: true },
  succeeded: { label: "Succeeded", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Ban },
  interrupted: { label: "Interrupted", tone: "warning", icon: AlertTriangle },
};

const STAGE_STATUS: Record<string, Presentation> = {
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  needs_review: { label: "Awaiting review", tone: "warning", icon: UserCheck },
  blocked: { label: "Blocked", tone: "warning", icon: Lock },
  pending: { label: "Pending", tone: "neutral", icon: CircleDashed },
  not_started: { label: "Not started", tone: "neutral", icon: CircleDashed },
  running: { label: "In progress", tone: "info", icon: CircleDot },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  approved: { label: "Approved", tone: "success", icon: CheckCircle2 },
};

/** G1 approval as reported by the engine's draft-check `approval_status`. */
export const APPROVAL_STATUS: Record<string, Presentation> = {
  approved: { label: "G1 approved", tone: "success", icon: CheckCircle2 },
  stale: { label: "G1 approval out of date", tone: "warning", icon: AlertTriangle },
  not_approved: { label: "G1 not approved", tone: "neutral", icon: CircleDashed },
};

export function approvalPresentation(status: string | null | undefined, confirmed?: boolean | null): Presentation {
  // An engine approval the UI could not tie to the version the reviewer validated is never
  // shown as a plain "approved".
  if (status === "approved" && confirmed === false)
    return { label: "G1 approval unconfirmed", tone: "warning", icon: AlertTriangle };
  if (!status) return { label: "G1 status unknown", tone: "neutral", icon: CircleDashed };
  return APPROVAL_STATUS[status] ?? { label: `G1 ${humanize(status)}`, tone: "neutral", icon: CircleDashed };
}

const STAGE_NAMES: Record<string, string> = {
  intake: "Intake",
  draft: "Draft",
  research: "Research",
  visuals: "Visuals",
  narration: "Narration",
  render: "Render",
  production: "Production",
  review: "Review",
};

export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : s;
}

export function stageName(stage: string): string {
  return STAGE_NAMES[stage] ?? humanize(stage);
}

export function stagePresentation(status: string): Presentation {
  return STAGE_STATUS[status] ?? { label: humanize(status), tone: "neutral", icon: CircleDot };
}

/** e.g. "Draft · Awaiting review", derived only from the engine report. */
export function stageSummary(status: StatusSummary | null | undefined): string {
  const cur = status?.current_stage;
  if (!status?.available || !cur) return "Status unavailable";
  return `${stageName(cur.stage)} · ${stagePresentation(cur.status).label}`;
}

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-slate-300 bg-surface-muted text-slate-700",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-green-200 bg-green-50 text-success",
  warning: "border-amber-200 bg-amber-50 text-warning",
  danger: "border-red-200 bg-red-50 text-danger",
};

export type NextActionKind =
  | "generate_draft"
  | "review_draft"
  | "fix_draft"
  | "wait_for_job"
  | "engine_action"
  | "unknown";

export interface NextAction {
  kind: NextActionKind;
  title: string;
  description: string;
  engineHint: string | null;
}

/**
 * Translate the engine's reported current stage into the next useful UI action.
 * Everything comes from `production-status`; when it is unavailable we say so.
 */
export function nextAction(
  status: StatusSummary | null | undefined,
  activeJob: { status: JobStatus } | null | undefined,
): NextAction {
  if (activeJob && (activeJob.status === "queued" || activeJob.status === "running")) {
    return {
      kind: "wait_for_job",
      title: activeJob.status === "queued" ? "Draft job queued" : "Draft generation in progress",
      description: "Follow the live engine log below. You can leave this page and come back.",
      engineHint: null,
    };
  }
  const cur: Stage | null | undefined = status?.current_stage;
  if (!status?.available || !cur) {
    return {
      kind: "unknown",
      title: "Unable to determine",
      description: status?.error
        ? `The engine status could not be read: ${status.error}`
        : "The engine status could not be read.",
      engineHint: null,
    };
  }
  const hint = cur.next_action;
  if (cur.stage === "draft" && cur.status === "blocked" && /\binvalid\b/.test(cur.detail ?? "")) {
    return {
      kind: "fix_draft",
      title: "Check the draft",
      description:
        "The engine reports that the draft is not valid, for example because a file changed " +
        "after it was generated. Open the draft to see the engine's errors.",
      engineHint: hint,
    };
  }
  if (cur.stage === "draft" && cur.status === "blocked") {
    return {
      kind: "generate_draft",
      title: "Generate a draft",
      description:
        "No draft exists yet. Generate an outline and script with your local Ollama model.",
      engineHint: hint,
    };
  }
  if (cur.stage === "draft" && cur.status === "needs_review" && /\bstale_after_apply\b/.test(cur.detail ?? "")) {
    return {
      kind: "review_draft",
      title: "Approve the draft again",
      description:
        "Claim IDs from the research approval were applied to the scenes, so the editorial " +
        "approval (gate G1) is out of date. Nothing else in the draft changed: review it and " +
        "approve it again.",
      engineHint: hint,
    };
  }
  if (cur.stage === "draft" && cur.status === "needs_review") {
    const stale = /\bstale\b/.test(cur.detail ?? "");
    return {
      kind: "review_draft",
      title: stale ? "Review the draft again" : "Review the draft",
      description: stale
        ? "The previous approval is out of date because a reviewed file changed. " +
          "Review the draft and approve it again (gate G1)."
        : "The engine is waiting for editorial review (gate G1). Read the outline and " +
          "script, check the validation results, then approve the draft.",
      engineHint: hint,
    };
  }
  return {
    kind: "engine_action",
    title: `${stageName(cur.stage)}: ${stagePresentation(cur.status).label}`,
    description: cur.detail ?? "Follow the engine's suggested next step.",
    engineHint: hint,
  };
}

/** A claim's recorded status (research-check). "Verified" is only ever a person's decision. */
export const CLAIM_STATUS: Record<string, Presentation> = {
  unverified: { label: "Unverified", tone: "neutral", icon: CircleDashed },
  supported_pending_review: { label: "Evidence linked, needs a decision", tone: "info", icon: CircleDot },
  verified: { label: "Verified by a reviewer", tone: "success", icon: CheckCircle2 },
  disputed: { label: "Disputed", tone: "warning", icon: AlertTriangle },
  insufficient: { label: "Insufficient evidence", tone: "danger", icon: XCircle },
  editorial_nonfactual: { label: "Editorial (not a factual claim)", tone: "neutral", icon: CircleDashed },
};

export function claimPresentation(status: string): Presentation {
  return CLAIM_STATUS[status] ?? { label: humanize(status), tone: "neutral", icon: CircleDashed };
}

/** G2, as research-check reports it. */
export const RESEARCH_APPROVAL: Record<string, Presentation> = {
  approved: { label: "G2 approved", tone: "success", icon: CheckCircle2 },
  stale: { label: "G2 approval out of date", tone: "warning", icon: AlertTriangle },
  not_approved: { label: "G2 not approved", tone: "neutral", icon: CircleDashed },
};

/** G1 and G2 as production-status reports them (`G1 editorial: …`, `G2 research: …`). */
export const GATE_LABEL: Record<string, Presentation> = {
  approved: { label: "Approved", tone: "success", icon: CheckCircle2 },
  approved_not_applied: { label: "Approved, claim IDs not applied yet", tone: "info", icon: CircleDot },
  stale_after_apply: { label: "Out of date after apply: approve the draft again", tone: "warning", icon: AlertTriangle },
  stale: { label: "Out of date", tone: "warning", icon: AlertTriangle },
  needs_review: { label: "Needs review", tone: "neutral", icon: CircleDashed },
  not_approved: { label: "Not approved", tone: "neutral", icon: CircleDashed },
  pending: { label: "Pending", tone: "neutral", icon: CircleDashed },
  recovery_required: { label: "Recovery required (use the CLI)", tone: "danger", icon: XCircle },
  missing: { label: "No draft", tone: "neutral", icon: CircleDashed },
  invalid: { label: "Invalid", tone: "danger", icon: XCircle },
};

export function gatePresentation(state: string | null | undefined): Presentation {
  if (!state) return { label: "Not reported by the engine", tone: "neutral", icon: CircleDashed };
  return GATE_LABEL[state] ?? { label: humanize(state), tone: "neutral", icon: CircleDashed };
}

/** Fetch outcomes recorded by the engine, in words. */
export const FETCH_OUTCOME: Record<string, string> = {
  fetched: "Fetched",
  queued: "Queued",
  host_not_allowed: "Host not confirmed: not contacted",
  robots_disallowed: "Not allowed by the site's robots.txt",
  metadata_only: "Metadata only (for example a PDF): not extracted",
  timeout: "Timed out",
  http_401: "Access refused (401)",
  http_403: "Access refused (403)",
  http_404: "Not found (404)",
  http_429: "Rate limited (429)",
  http_5xx: "Server error",
  too_large: "Too large",
  url_refused: "URL refused (not a public https address)",
  ssrf_blocked: "Refused: not a public address",
  skipped_time_budget: "Skipped: time budget reached",
};

export function fetchOutcome(outcome: string | null | undefined): string {
  if (!outcome) return "Not fetched yet";
  return FETCH_OUTCOME[outcome] ?? humanize(outcome);
}

/** A URL as a reader sees it: the engine stores percent-encoded URLs, so Vietnamese paths
 * are decoded for display (text only; never used as a link target). */
export function displayUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}
