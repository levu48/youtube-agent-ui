import { describe, expect, it } from "vitest";

import type { StatusSummary } from "@/lib/api";
import { formatDuration, slugify } from "@/lib/format";
import { JOB_STATUS, nextAction, stagePresentation, stageSummary } from "@/lib/status";
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
});

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(180)).toBe("3 min");
    expect(formatDuration(90)).toBe("1 min 30s");
    expect(formatDuration(null)).toBe("—");
  });
});
