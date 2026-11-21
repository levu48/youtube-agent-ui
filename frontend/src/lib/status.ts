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
  if (cur.stage === "draft" && cur.status === "blocked") {
    return {
      kind: "generate_draft",
      title: "Generate a draft",
      description:
        "No draft exists yet. Generate an outline and script with your local Ollama model.",
      engineHint: hint,
    };
  }
  if (cur.stage === "draft" && cur.status === "needs_review") {
    return {
      kind: "review_draft",
      title: "Review the draft",
      description:
        "The engine is waiting for editorial review (gate G1). Read the outline and script. " +
        "Approval is recorded with the engine CLI in this milestone.",
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
