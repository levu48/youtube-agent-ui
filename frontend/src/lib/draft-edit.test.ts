import { describe, expect, it } from "vitest";

import type { Outline, Script } from "@/lib/api";
import {
  buildPatch,
  changedKeys,
  editsAfterSave,
  editsAsText,
  hasRawEdits,
  emptyEdits,
  isEmptyPatch,
  textToList,
  validatePatch,
  type Edits,
} from "@/lib/draft-edit";
import { LIMITS } from "@/test/fixtures";


const outline: Outline = {
  title: "Hành trình",
  thesis_or_question: "Vì sao?",
  language: "vi",
  target_duration_seconds: 180,
  notice: null,
  generated_by: null,
  verification: null,
  sections: [
    {
      id: "sec-01",
      heading: "Mở đầu",
      role: "hook",
      purpose: "Giới thiệu",
      key_points: ["A", "B"],
      claims_to_investigate: [],
      estimated_duration_seconds: 30,
    },
  ],
};
const script: Script = {
  title: "Hành trình",
  language: "vi",
  target_duration_seconds: 180,
  notice: null,
  generated_by: null,
  verification: null,
  sections: [
    {
      outline_section_id: "sec-01",
      heading: "Mở đầu",
      narration: "Đoạn một.\n\nĐoạn hai.",
      summary: null,
      target_duration_seconds: 30,
      estimated_duration_seconds: 20,
      editorial_notes: [],
      review_flags: [],
    },
  ],
};

function edits(over: Partial<Edits["outline"]> = {}, scriptSections: Edits["script"]["sections"] = {}): Edits {
  return { outline: { ...emptyEdits().outline, ...over }, script: { sections: scriptSections } };
}

describe("buildPatch", () => {
  it("is empty when nothing changed, including edits reverted by hand or whitespace only", () => {
    expect(isEmptyPatch(buildPatch(emptyEdits(), outline, script))).toBe(true);
    const reverted = edits({ title: " Hành trình ", sections: { "sec-01": { key_points: "A\n\n B \n" } } });
    expect(isEmptyPatch(buildPatch(reverted, outline, script))).toBe(true);
  });

  it("contains only the changed fields, with lists split one item per line", () => {
    const e = edits(
      { title: "Hành trình mới", sections: { "sec-01": { heading: "Mở đầu", key_points: "A\n  C  \n\nB" } } },
      { "sec-01": { narration: "Đoạn mới.\n\n  Đoạn hai.  ", summary: "Tóm tắt" } },
    );
    expect(buildPatch(e, outline, script)).toEqual({
      outline: { title: "Hành trình mới", sections: [{ id: "sec-01", key_points: ["A", "C", "B"] }] },
      // Narration is sent as typed: the engine normalises paragraphs and whitespace.
      script: { sections: [{ outline_section_id: "sec-01", narration: "Đoạn mới.\n\n  Đoạn hai.  ", summary: "Tóm tắt" }] },
    });
    expect([...changedKeys(buildPatch(e, outline, script))].sort()).toEqual([
      "outline.sec-01.key_points",
      "outline.title",
      "script.sec-01.narration",
      "script.sec-01.summary",
    ]);
  });

  it("ignores edits for sections that are not in the loaded draft", () => {
    const e = edits({ sections: { "sec-99": { heading: "X" } } }, { "sec-99": { narration: "Y" } });
    expect(isEmptyPatch(buildPatch(e, outline, script))).toBe(true);
  });
});

describe("validatePatch", () => {
  it("reports problems the engine would reject, per field", () => {
    const p = buildPatch(
      edits(
        { title: "  ", sections: { "sec-01": { key_points: "\n \n", purpose: "x".repeat(2001) } } },
        { "sec-01": { narration: "1911 — 1945", editorial_notes: Array(51).fill("n").join("\n") } },
      ),
      outline,
      script,
    );
    const errors = validatePatch(p, LIMITS);
    expect(errors["outline.title"]).toMatch(/cannot be empty/);
    expect(errors["outline.sec-01.key_points"]).toMatch(/at least one/);
    expect(errors["outline.sec-01.purpose"]).toMatch(/at most 2,000/);
    expect(errors["script.sec-01.narration"]).toMatch(/must contain words/);
    expect(errors["script.sec-01.editorial_notes"]).toMatch(/at most 50 items/);
  });

  it("accepts an empty summary and Vietnamese narration", () => {
    const p = buildPatch(edits({}, { "sec-01": { summary: "", narration: "Năm 1911, người thanh niên ra đi." } }), outline, {
      ...script,
      sections: [{ ...script.sections[0], summary: "old" }],
    });
    expect(validatePatch(p, LIMITS)).toEqual({});
  });
});

describe("editsAsText", () => {
  it("names every changed field so nothing is lost on a conflict", () => {
    const p = buildPatch(edits({ title: "Mới" }, { "sec-01": { narration: "Lời mới." } }), outline, script);
    const text = editsAsText(p, outline, script);
    expect(text).toContain("[Outline] Title:\nMới");
    expect(text).toContain("[Script · Mở đầu (sec-01)] Narration:\nLời mới.");
  });
});

it("textToList trims and drops blank lines", () => {
  expect(textToList(" a \r\n\n b\n")).toEqual(["a", "b"]);
});

describe("editsAfterSave", () => {
  it("drops what was saved and keeps what was typed while the save was pending", () => {
    const submitted = edits({ title: "Mới", sections: { "sec-01": { heading: "H" } } }, { "sec-01": { narration: "N" } });
    const current = edits(
      { title: "Mới thêm", thesis_or_question: "Q", sections: { "sec-01": { heading: "H", purpose: "P" } } },
      { "sec-01": { narration: "N" } },
    );
    expect(editsAfterSave(current, submitted)).toEqual(
      edits({ title: "Mới thêm", thesis_or_question: "Q", sections: { "sec-01": { purpose: "P" } } }),
    );
    expect(hasRawEdits(editsAfterSave(submitted, submitted))).toBe(false);
  });
});
