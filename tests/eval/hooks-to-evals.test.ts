import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvalSet,
  classifyInvocation,
  MAX_QUERY_LENGTH,
} from "../../cli/selftune/eval/hooks-to-evals.js";
import type { QueryLogRecord, SkillUsageRecord } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-eval-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to write JSONL fixture files
// ---------------------------------------------------------------------------
function _writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// classifyInvocation
// ---------------------------------------------------------------------------
describe("classifyInvocation", () => {
  test("returns 'explicit' when query contains $skill syntax", () => {
    expect(classifyInvocation("use $pptx to make slides", "pptx")).toBe("explicit");
  });

  test("returns 'explicit' when query contains skill name (case-insensitive)", () => {
    expect(classifyInvocation("open the PPTX builder", "pptx")).toBe("explicit");
  });

  test("returns 'implicit' for short task description without skill name", () => {
    expect(classifyInvocation("make a slide deck", "pptx")).toBe("implicit");
  });

  test("returns 'contextual' for long query with domain noise and proper nouns", () => {
    const q =
      "For the TechCorp project meeting tomorrow, create a comprehensive slide deck covering our Q4 revenue numbers";
    expect(classifyInvocation(q, "pptx")).toBe("contextual");
  });

  test("returns 'contextual' when query has proper noun even if short", () => {
    expect(classifyInvocation("slides for Microsoft", "pptx")).toBe("contextual");
  });

  test("returns 'contextual' for queries over 15 words without proper nouns", () => {
    const q =
      "i need to make a deck with many pages about the future of the entire industry in general";
    expect(classifyInvocation(q, "pptx")).toBe("contextual");
  });

  test("handles empty query", () => {
    expect(classifyInvocation("", "pptx")).toBe("implicit");
  });

  test("handles Unicode/emoji queries", () => {
    expect(classifyInvocation("make \u{1F3A8} slides", "pptx")).toBe("implicit");
  });

  test("handles single-word query", () => {
    expect(classifyInvocation("slides", "pptx")).toBe("implicit");
  });

  test("handles query that is just the skill name", () => {
    expect(classifyInvocation("pptx", "pptx")).toBe("explicit");
  });

  // --- New: Hyphenated skill names ---
  test("returns 'explicit' for hyphenated skill name parts in query", () => {
    expect(classifyInvocation("use ms office suite", "ms-office-suite")).toBe("explicit");
  });

  test("returns 'explicit' for hyphenated skill name with all parts present", () => {
    expect(classifyInvocation("launch the ms office suite now", "ms-office-suite")).toBe(
      "explicit",
    );
  });

  // --- New: camelCase skill name ---
  test("returns 'explicit' for camelCase version of skill name", () => {
    expect(classifyInvocation("open msOfficeSuite", "ms-office-suite")).toBe("explicit");
  });

  // --- New: Temporal references ---
  test("returns 'contextual' for query with temporal reference", () => {
    expect(classifyInvocation("make slides for Q3 meeting", "pptx")).toBe("contextual");
  });

  test("returns 'contextual' for query with day reference", () => {
    expect(classifyInvocation("prepare deck for next week", "pptx")).toBe("contextual");
  });

  // --- New: Filenames ---
  test("returns 'contextual' for query with filename", () => {
    expect(classifyInvocation("convert report.docx to slides", "pptx")).toBe("contextual");
  });

  // --- New: Email addresses ---
  test("returns 'contextual' for query with email", () => {
    expect(classifyInvocation("send results to boss@company.com", "pptx")).toBe("contextual");
  });

  // --- New: Borderline domain signals ---
  test("returns 'contextual' for 10+ word query with numbers", () => {
    expect(
      classifyInvocation(
        "create a deck with the 2024 revenue data for all regions combined",
        "pptx",
      ),
    ).toBe("contextual");
  });

  // --- New: Still implicit ---
  test("returns 'implicit' for short clean task description", () => {
    expect(classifyInvocation("make a slide deck", "pptx")).toBe("implicit");
  });

  test("returns 'implicit' for brief request without domain signals", () => {
    expect(classifyInvocation("create some slides please", "pptx")).toBe("implicit");
  });
});

// ---------------------------------------------------------------------------
// buildEvalSet
// ---------------------------------------------------------------------------
describe("buildEvalSet", () => {
  const skillRecords: SkillUsageRecord[] = [
    {
      timestamp: "2025-01-01T00:00:00Z",
      session_id: "s1",
      skill_name: "pptx",
      skill_path: "/skills/pptx",
      query: "use $pptx to make slides",
      triggered: true,
    },
    {
      timestamp: "2025-01-01T00:01:00Z",
      session_id: "s2",
      skill_name: "pptx",
      skill_path: "/skills/pptx",
      query: "make a slide deck",
      triggered: true,
    },
    {
      timestamp: "2025-01-01T00:02:00Z",
      session_id: "s3",
      skill_name: "other-skill",
      skill_path: "/skills/other",
      query: "do something else",
      triggered: true,
    },
  ];

  const queryRecords: QueryLogRecord[] = [
    {
      timestamp: "2025-01-01T00:00:00Z",
      session_id: "s1",
      query: "use $pptx to make slides",
    },
    {
      timestamp: "2025-01-01T00:01:00Z",
      session_id: "s2",
      query: "make a slide deck",
    },
    {
      timestamp: "2025-01-01T00:02:00Z",
      session_id: "s3",
      query: "do something else",
    },
    {
      timestamp: "2025-01-01T00:03:00Z",
      session_id: "s4",
      query: "what is the weather?",
    },
    {
      timestamp: "2025-01-01T00:04:00Z",
      session_id: "s5",
      query: "help me write a test",
    },
  ];

  test("produces balanced positives and negatives", () => {
    const result = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    const negatives = result.filter((e) => !e.should_trigger);
    expect(positives.length).toBe(2);
    expect(negatives.length).toBeGreaterThanOrEqual(2);
  });

  test("deduplicates positive queries", () => {
    const dupeSkillRecords: SkillUsageRecord[] = [
      ...skillRecords,
      {
        timestamp: "2025-01-01T00:05:00Z",
        session_id: "s6",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: "use $pptx to make slides",
        triggered: true,
      },
    ];
    const result = buildEvalSet(dupeSkillRecords, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    const uniqueQueries = new Set(positives.map((e) => e.query));
    expect(positives.length).toBe(uniqueQueries.size);
  });

  test("ignores untriggered skill records when building positives", () => {
    const recordsWithBrowseOnly: SkillUsageRecord[] = [
      ...skillRecords,
      {
        timestamp: "2025-01-01T00:06:00Z",
        session_id: "s7",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: "browse the pptx skill docs",
        triggered: false,
      },
    ];

    const result = buildEvalSet(recordsWithBrowseOnly, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger).map((e) => e.query);

    expect(positives).not.toContain("browse the pptx skill docs");
    expect(positives).toHaveLength(2);
  });

  test("pads with generic negatives when real negatives are sparse", () => {
    // Only 3 non-pptx queries exist, but we have 2 positives.
    // The 3 negatives should be enough here, but if we make many positives:
    const manySkillRecords: SkillUsageRecord[] = [];
    for (let i = 0; i < 20; i++) {
      manySkillRecords.push({
        timestamp: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        session_id: `s-pos-${i}`,
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: `unique pptx query number ${i}`,
        triggered: true,
      });
    }
    // Only 2 real negative queries available
    const fewQueryRecords: QueryLogRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "n1",
        query: "unrelated query alpha",
      },
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "n2",
        query: "unrelated query beta",
      },
    ];
    const result = buildEvalSet(manySkillRecords, fewQueryRecords, "pptx", 20, true, 42, true);
    const negatives = result.filter((e) => !e.should_trigger);
    // Should have padded beyond the 2 real negatives with GENERIC_NEGATIVES
    expect(negatives.length).toBeGreaterThan(2);
  });

  test("same seed produces same output (deterministic)", () => {
    const r1 = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, 42, true);
    const r2 = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, 42, true);
    expect(r1).toEqual(r2);
  });

  test("different seeds produce different order", () => {
    // Need enough entries for shuffling to matter
    const manySkillRecords: SkillUsageRecord[] = [];
    for (let i = 0; i < 20; i++) {
      manySkillRecords.push({
        timestamp: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        session_id: `s${i}`,
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: `pptx query ${i}`,
        triggered: true,
      });
    }
    const r1 = buildEvalSet(manySkillRecords, queryRecords, "pptx", 20, true, 42, true);
    const r2 = buildEvalSet(manySkillRecords, queryRecords, "pptx", 20, true, 99, true);
    const positives1 = r1.filter((e) => e.should_trigger).map((e) => e.query);
    const positives2 = r2.filter((e) => e.should_trigger).map((e) => e.query);
    // Same set of queries but different order
    expect(new Set(positives1)).toEqual(new Set(positives2));
    expect(positives1).not.toEqual(positives2);
  });

  test("--no-negatives produces only positives", () => {
    const result = buildEvalSet(skillRecords, queryRecords, "pptx", 50, false, 42, true);
    const negatives = result.filter((e) => !e.should_trigger);
    expect(negatives.length).toBe(0);
    expect(result.length).toBeGreaterThan(0);
  });

  test("--no-taxonomy omits invocation_type field", () => {
    const result = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, 42, false);
    for (const entry of result) {
      expect(entry).not.toHaveProperty("invocation_type");
    }
  });

  test("respects max_per_side limit", () => {
    const manySkillRecords: SkillUsageRecord[] = [];
    for (let i = 0; i < 100; i++) {
      manySkillRecords.push({
        timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        session_id: `s${i}`,
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: `pptx query ${i}`,
        triggered: true,
      });
    }
    const result = buildEvalSet(manySkillRecords, queryRecords, "pptx", 10, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(10);
  });

  test("excludes entries with '(query not found)' placeholder", () => {
    const recordsWithPlaceholder: SkillUsageRecord[] = [
      ...skillRecords,
      {
        timestamp: "2025-01-01T00:06:00Z",
        session_id: "s7",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: "(query not found)",
        triggered: true,
      },
    ];
    const result = buildEvalSet(recordsWithPlaceholder, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.every((e) => e.query !== "(query not found)")).toBe(true);
  });

  test("truncates queries longer than 500 chars", () => {
    const longQuery = "a".repeat(600);
    const longSkillRecords: SkillUsageRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: longQuery,
        triggered: true,
      },
    ];
    const longQueryRecords: QueryLogRecord[] = [
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "s2",
        query: "b".repeat(700),
      },
    ];
    const result = buildEvalSet(longSkillRecords, longQueryRecords, "pptx", 50, true, 42, true);
    for (const entry of result) {
      expect(entry.query.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    }
  });

  test("handles empty skill records gracefully", () => {
    const result = buildEvalSet([], queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(0);
    // Should still have negatives from queryRecords
    const negatives = result.filter((e) => !e.should_trigger);
    expect(negatives.length).toBeGreaterThan(0);
  });

  test("handles NaN maxPerSide -- defaults to 50", () => {
    const result = buildEvalSet(skillRecords, queryRecords, "pptx", Number.NaN, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    // Should not crash; NaN maxPerSide defaults to 50, so all 2 positives should be included
    expect(positives.length).toBe(2);
  });

  test("handles NaN seed -- defaults to 42", () => {
    const resultNaN = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, Number.NaN, true);
    const resultDefault = buildEvalSet(skillRecords, queryRecords, "pptx", 50, true, 42, true);
    // NaN seed should default to 42, producing the same result
    expect(resultNaN).toEqual(resultDefault);
  });

  test("skips malformed skill records (missing skill_name)", () => {
    const malformedSkillRecords = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: "make slides",
        triggered: true,
      },
      // Malformed: missing skill_name
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "s2",
        skill_path: "/skills/pptx",
        query: "should be skipped",
        triggered: true,
      } as unknown as SkillUsageRecord,
      // Malformed: null record
      null as unknown as SkillUsageRecord,
    ];
    const result = buildEvalSet(malformedSkillRecords, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(1);
    expect(positives[0].query).toBe("make slides");
  });

  test("skips malformed query records (missing query field)", () => {
    const malformedQueryRecords = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        query: "valid negative query",
      },
      // Malformed: missing query field
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "s2",
      } as unknown as QueryLogRecord,
      // Malformed: null record
      null as unknown as QueryLogRecord,
    ];
    const result = buildEvalSet([], malformedQueryRecords, "pptx", 50, true, 42, true);
    const negatives = result.filter((e) => !e.should_trigger);
    // Only the valid query record should produce a negative
    expect(negatives.length).toBeGreaterThanOrEqual(1);
    expect(negatives.some((e) => e.query === "valid negative query")).toBe(true);
  });

  test("handles skill records with null query field", () => {
    const nullQueryRecords: SkillUsageRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: null as unknown as string,
        triggered: true,
      },
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "s2",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: "valid query",
        triggered: true,
      },
    ];
    const result = buildEvalSet(nullQueryRecords, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    // null query should be handled gracefully (treated as empty -> skipped)
    expect(positives.length).toBe(1);
    expect(positives[0].query).toBe("valid query");
  });

  test("handles very long queries with truncation", () => {
    const veryLongQuery = "word ".repeat(200).trim(); // 999 chars
    const longSkillRecords: SkillUsageRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: veryLongQuery,
        triggered: true,
      },
    ];
    const result = buildEvalSet(longSkillRecords, [], "pptx", 50, false, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(1);
    expect(positives[0].query.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
  });

  test("handles queries with special characters", () => {
    const specialRecords: SkillUsageRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "pptx",
        skill_path: "/skills/pptx",
        query: 'make slides with "quotes" & <tags> and \ttabs',
        triggered: true,
      },
    ];
    const specialQueryRecords: QueryLogRecord[] = [
      {
        timestamp: "2025-01-01T00:01:00Z",
        session_id: "s2",
        query: "query with \n newlines \r\n and unicode \u{1F600}",
      },
    ];
    const result = buildEvalSet(specialRecords, specialQueryRecords, "pptx", 50, true, 42, true);
    expect(result.length).toBeGreaterThan(0);
    // Should not throw and should produce valid entries
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(1);
  });

  test("handles empty query records array", () => {
    const result = buildEvalSet(skillRecords, [], "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    const negatives = result.filter((e) => !e.should_trigger);
    expect(positives.length).toBe(2);
    // Should still have generic fallback negatives
    expect(negatives.length).toBeGreaterThan(0);
  });

  test("handles empty skill records for target skill", () => {
    // All skill records are for a different skill
    const otherSkillRecords: SkillUsageRecord[] = [
      {
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        skill_name: "other-skill",
        skill_path: "/skills/other",
        query: "do other stuff",
        triggered: true,
      },
    ];
    const result = buildEvalSet(otherSkillRecords, queryRecords, "pptx", 50, true, 42, true);
    const positives = result.filter((e) => e.should_trigger);
    expect(positives.length).toBe(0);
  });
});
