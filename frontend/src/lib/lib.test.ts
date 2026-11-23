import { describe, expect, it } from "vitest";

import type { StatusSummary } from "@/lib/api";
import { formatDuration, slugify } from "@/lib/format";
import { JOB_STATUS, approvalPresentation, displayUrl, gatePresentation, nextAction, stagePresentation, stageSummary } from "@/lib/status";
import { minutesToSeconds, validateCreate, type CreateFormValues } from "@/lib/validation";

const base: CreateFormValues = {
  idea: "Hồ Chí Minh: Nationalist or Communist?",
  slug: "hcm-demo",
  language: "vi",
  durationMinutes: "3",
  audience: "",
  tone: "",
  guidance: "",
};

describe("slugify", () => {
  it("strips Vietnamese diacritics including đ", () => {
    expect(slugify("Hồ Chí Minh: Nationalist or Communist?")).toBe("ho-chi-minh-nationalist-or-communist");
    expect(slugify("Đường Trường Sơn")).toBe("duong-truong-son");
  });
  it("bounds length and trims hyphens", () => {
    expect(slugify("  --a--  ")).toBe("a");
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("validateCreate", () => {
  it("accepts a valid form", () => {
    expect(validateCreate(base)).toEqual({});
  });
  it("mirrors server rules", () => {
    const e = validateCreate({ ...base, idea: "abc", slug: "Bad Slug", durationMinutes: "0.5", guidance: "g".repeat(4001) });
    expect(Object.keys(e).sort()).toEqual(["durationMinutes", "guidance", "idea", "slug"]);
    expect(validateCreate({ ...base, durationMinutes: "61" }).durationMinutes).toBeTruthy();
    expect(validateCreate({ ...base, slug: "-x" }).slug).toBeTruthy();
  });
  it("converts minutes to whole seconds", () => {
    expect(minutesToSeconds("3")).toBe(180);
    expect(minutesToSeconds("1.5")).toBe(90);
    expect(minutesToSeconds("60")).toBe(3600);
  });
});

describe("status presentation", () => {
  it("every job status has a text label and icon", () => {
    for (const p of Object.values(JOB_STATUS)) {
      expect(p.label).toMatch(/\w/);
      expect(p.icon).toBeTruthy();
    }
  });
  it("unknown engine stage statuses are humanised, not hidden", () => {
    expect(stagePresentation("needs_review").label).toBe("Awaiting review");
    expect(stagePresentation("some_new_state").label).toBe("Some new state");
  });
  it("never guesses when status is unavailable", () => {
    const unavailable: StatusSummary = { available: false, stages: [], current_stage: null, error: "boom" };
    expect(stageSummary(unavailable)).toBe("Status unavailable");
    expect(nextAction(unavailable, null).title).toBe("Unable to determine");
  });
  it("derives next action from the engine report", () => {
    const stage = (status: string) => ({ stage: "draft", status, mode: null, detail: null, next_action: "hint" });
    const s = (status: string): StatusSummary => ({ available: true, stages: [], current_stage: stage(status), error: null });
    expect(nextAction(s("blocked"), null).kind).toBe("generate_draft");
    expect(nextAction(s("needs_review"), null).kind).toBe("review_draft");
    expect(nextAction(s("needs_review"), { status: "running" }).kind).toBe("wait_for_job");
    expect(nextAction(s("needs_review"), null).engineHint).toBe("hint");
  });
  it("uses the engine's G1 detail for invalid drafts and stale approvals", () => {
    const s = (status: string, detail: string): StatusSummary => ({
      available: true,
      stages: [],
      current_stage: { stage: "draft", status, mode: null, detail, next_action: null },
      error: null,
    });
    expect(nextAction(s("blocked", "G1 editorial: missing"), null).kind).toBe("generate_draft");
    expect(nextAction(s("blocked", "G1 editorial: invalid"), null).kind).toBe("fix_draft");
    const stale = nextAction(s("needs_review", "G1 editorial: stale"), null);
    expect(stale.kind).toBe("review_draft");
    expect(stale.title).toBe("Review the draft again");
    expect(nextAction(s("needs_review", "G1 editorial: not_approved"), null).title).toBe("Review the draft");
    const afterApply = nextAction(s("needs_review", "G1 editorial: stale_after_apply"), null);
    expect(afterApply.kind).toBe("review_draft");
    expect(afterApply.title).toBe("Approve the draft again");
    expect(afterApply.description).toMatch(/Claim IDs .* were applied to the scenes/);
  });
  it("labels gate states as production-status reports them, and never invents one", () => {
    expect(gatePresentation("approved_not_applied").label).toBe("Approved, claim IDs not applied yet");
    expect(gatePresentation("stale_after_apply").tone).toBe("warning");
    expect(gatePresentation(null).label).toBe("Not reported by the engine");
    expect(gatePresentation("new_engine_state").label).toBe("New engine state");
  });
  it("labels engine approval states without inventing them", () => {
    expect(approvalPresentation("approved").label).toBe("G1 approved");
    expect(approvalPresentation("stale").label).toBe("G1 approval out of date");
    expect(approvalPresentation("not_approved").label).toBe("G1 not approved");
    expect(approvalPresentation("something_new").label).toBe("G1 Something new");
    expect(approvalPresentation(null).label).toBe("G1 status unknown");
  });
});

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(180)).toBe("3 min");
    expect(formatDuration(90)).toBe("1 min 30s");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("approvalPresentation", () => {
  it("never labels an unconfirmed engine approval as approved", () => {
    expect(approvalPresentation("approved").label).toBe("G1 approved");
    expect(approvalPresentation("approved", true).label).toBe("G1 approved");
    expect(approvalPresentation("approved", false)).toMatchObject({ label: "G1 approval unconfirmed", tone: "warning" });
    expect(approvalPresentation("stale", false).label).toBe("G1 approval out of date");
  });
});

describe("displayUrl", () => {
  it("shows percent-encoded Vietnamese paths readably and keeps malformed ones as they are", () => {
    expect(displayUrl("https://vi.wikipedia.org/wiki/Ba_%C4%90%C3%ACnh")).toBe("https://vi.wikipedia.org/wiki/Ba_Đình");
    expect(displayUrl("https://example.org/a%2Fb")).toBe("https://example.org/a%2Fb");
    expect(displayUrl("https://example.org/%E0%A4%A")).toBe("https://example.org/%E0%A4%A");
  });
});
