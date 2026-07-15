/**
 * Tests for bounded-mutations.ts — bounded mutation primitives for
 * package search. Verifies that routing and body mutations produce
 * valid, distinct, evaluator-compatible skill file variants.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const {
  generateRoutingMutations,
  generateBodyMutations,
  generateReflectiveRoutingMutations,
  generateReflectiveBodyMutations,
  generateTargetedRoutingMutations,
  generateTargetedBodyMutations,
  extractMutationWeaknesses,
  cleanupVariants,
} = await import("../../packages/runtime/evolution/bounded-mutations.js");

import type { MutationWeaknesses } from "../../packages/runtime/evolution/bounded-mutations.js";

const { parseSkillSections } = await import("../../packages/runtime/evolution/deploy-proposal.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `---
name: test-skill
version: 1.0
---

# Test Skill

A skill for testing bounded mutations. It handles task management and project tracking.

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| create task | task-create |
| list tasks | task-list |
| update task | task-update |

## Instructions

Follow these steps to manage tasks:
1. Parse the user request
2. Identify the task operation
3. Execute the appropriate workflow

## Examples

- "create a new task for the sprint"
- "show me all open tasks"
`;

let testSkillDir: string;
let testSkillPath: string;

function createWeaknessTestTables(db: { run: (sql: string) => void }) {
  db.run(`CREATE TABLE IF NOT EXISTS evolution_evidence (
    timestamp TEXT, proposal_id TEXT, skill_name TEXT, skill_path TEXT,
    target TEXT, stage TEXT, rationale TEXT, confidence REAL, details TEXT,
    original_text TEXT, proposed_text TEXT, eval_set_json TEXT,
    validation_json TEXT, evidence_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS grading_results (
    grading_id TEXT,
    session_id TEXT,
    skill_name TEXT,
    transcript_path TEXT,
    graded_at TEXT,
    pass_rate REAL,
    mean_score REAL,
    score_std_dev REAL,
    passed_count INTEGER,
    failed_count INTEGER,
    total_count INTEGER,
    expectations_json TEXT,
    claims_json TEXT,
    eval_feedback_json TEXT,
    failure_feedback_json TEXT,
    execution_metrics_json TEXT
  )`);
}

beforeEach(() => {
  testSkillDir = join(tmpdir(), `selftune-bounded-test-${Date.now()}`);
  mkdirSync(testSkillDir, { recursive: true });
  testSkillPath = join(testSkillDir, "SKILL.md");
  writeFileSync(testSkillPath, SAMPLE_SKILL_MD, "utf-8");
});

afterEach(() => {
  try {
    rmSync(testSkillDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ---------------------------------------------------------------------------
// Routing mutations
// ---------------------------------------------------------------------------

describe("generateRoutingMutations", () => {
  test("returns array of BoundedMutationResult objects", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(2);

    for (const r of results) {
      expect(r.variantSkillPath).toBeDefined();
      expect(r.mutationSurface).toBe("routing");
      expect(typeof r.mutationDescription).toBe("string");
      expect(r.mutationDescription.length).toBeGreaterThan(0);
      expect(typeof r.parentFingerprint).toBe("string");
      expect(r.parentFingerprint.length).toBeGreaterThan(0);
    }
  });

  test("variant files exist on disk and are valid SKILL.md", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    for (const r of results) {
      expect(existsSync(r.variantSkillPath)).toBe(true);

      const content = readFileSync(r.variantSkillPath, "utf-8");
      const parsed = parseSkillSections(content);

      // Must preserve title
      expect(parsed.title).toBe("# Test Skill");
      // Must preserve frontmatter
      expect(parsed.frontmatter).toContain("name: test-skill");
      // Must have Workflow Routing section
      expect(parsed.sections["Workflow Routing"]).toBeDefined();
      // Routing section must have table syntax
      expect(parsed.sections["Workflow Routing"]).toContain("|");
    }
  });

  test("variants are distinct from parent routing", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      maxVariants: 3,
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    const parentContent = readFileSync(testSkillPath, "utf-8");
    const parentParsed = parseSkillSections(parentContent);
    const parentRouting = parentParsed.sections["Workflow Routing"];

    for (const r of results) {
      const variantContent = readFileSync(r.variantSkillPath, "utf-8");
      const variantParsed = parseSkillSections(variantContent);
      const variantRouting = variantParsed.sections["Workflow Routing"];

      // Variant routing should differ from parent
      expect(variantRouting).not.toBe(parentRouting);
    }
  });

  test("defaults to 3 variants when maxVariants not specified", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    expect(results.length).toBe(3);
  });

  test("throws when skill path does not exist", async () => {
    await expect(
      generateRoutingMutations("/nonexistent/SKILL.md", {
        mutationSurface: "routing",
        parentSkillPath: "/nonexistent/SKILL.md",
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Body mutations
// ---------------------------------------------------------------------------

describe("generateBodyMutations", () => {
  test("returns array of BoundedMutationResult objects", async () => {
    const results = await generateBodyMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "body",
      parentSkillPath: testSkillPath,
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(2);

    for (const r of results) {
      expect(r.variantSkillPath).toBeDefined();
      expect(r.mutationSurface).toBe("body");
      expect(typeof r.mutationDescription).toBe("string");
      expect(r.mutationDescription.length).toBeGreaterThan(0);
      expect(typeof r.parentFingerprint).toBe("string");
    }
  });

  test("variant files preserve SKILL.md structure", async () => {
    const results = await generateBodyMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "body",
      parentSkillPath: testSkillPath,
    });

    for (const r of results) {
      expect(existsSync(r.variantSkillPath)).toBe(true);

      const content = readFileSync(r.variantSkillPath, "utf-8");
      const parsed = parseSkillSections(content);

      // Must preserve title
      expect(parsed.title).toBe("# Test Skill");
      // Must preserve frontmatter
      expect(parsed.frontmatter).toContain("name: test-skill");
      // Must still have Workflow Routing (body mutation preserves structure)
      expect(parsed.sections["Workflow Routing"]).toBeDefined();
    }
  });

  test("variants differ from parent body", async () => {
    const results = await generateBodyMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "body",
      parentSkillPath: testSkillPath,
    });

    const parentContent = readFileSync(testSkillPath, "utf-8");

    for (const r of results) {
      const variantContent = readFileSync(r.variantSkillPath, "utf-8");
      expect(variantContent).not.toBe(parentContent);
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted routing mutations
// ---------------------------------------------------------------------------

describe("generateTargetedRoutingMutations", () => {
  test("focuses mutations on missed query patterns", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: ["create a task", "make a new task"],
      routingFailureSamples: ["add task to project"],
      bodyQualityScore: 0.7,
      gradingPassRateDelta: -0.1,
    };
    const results = generateTargetedRoutingMutations(testSkillPath, weaknesses);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // At least one variant should contain task-related keywords
    const anyContainsTask = results.some((r) => {
      const content = readFileSync(r.variantSkillPath, "utf-8");
      return content.toLowerCase().includes("task");
    });
    expect(anyContainsTask).toBe(true);
  });

  test("returns valid BoundedMutationResult with targeted descriptions", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: ["schedule meeting"],
      routingFailureSamples: [],
      bodyQualityScore: 0.8,
      gradingPassRateDelta: 0.0,
    };
    const results = generateTargetedRoutingMutations(testSkillPath, weaknesses);
    for (const r of results) {
      expect(r.mutationDescription).toContain("Targeted");
      expect(existsSync(r.variantSkillPath)).toBe(true);
    }
  });

  test("returns empty array when no weaknesses provided", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: [],
      routingFailureSamples: [],
      bodyQualityScore: 1.0,
      gradingPassRateDelta: 0.0,
    };
    const results = generateTargetedRoutingMutations(testSkillPath, weaknesses);
    expect(results.length).toBe(0);
  });

  test("variants have distinct fingerprints from parent", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: ["create a task"],
      routingFailureSamples: [],
      bodyQualityScore: 0.5,
      gradingPassRateDelta: -0.2,
    };
    const results = generateTargetedRoutingMutations(testSkillPath, weaknesses);
    const parentContent = readFileSync(testSkillPath, "utf-8");
    for (const r of results) {
      // Variant content should differ from parent
      const variantContent = readFileSync(r.variantSkillPath, "utf-8");
      expect(variantContent).not.toBe(parentContent);
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted body mutations
// ---------------------------------------------------------------------------

describe("generateTargetedBodyMutations", () => {
  test("focuses mutations on weak body sections", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: [],
      routingFailureSamples: [],
      bodyQualityScore: 0.3,
      gradingPassRateDelta: -0.15,
      gradingFailurePatterns: ["Instructions section lacks detail", "Examples too sparse"],
    };
    const results = generateTargetedBodyMutations(testSkillPath, weaknesses);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.mutationDescription).toContain("Targeted");
      expect(existsSync(r.variantSkillPath)).toBe(true);
    }
  });

  test("returns empty array when body quality is high and no failures", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: [],
      routingFailureSamples: [],
      bodyQualityScore: 0.95,
      gradingPassRateDelta: 0.05,
    };
    const results = generateTargetedBodyMutations(testSkillPath, weaknesses);
    expect(results.length).toBe(0);
  });

  test("strengthens instruction section when grading pass rate drops", () => {
    const weaknesses: MutationWeaknesses = {
      replayFailureSamples: [],
      routingFailureSamples: [],
      bodyQualityScore: 0.6,
      gradingPassRateDelta: -0.2,
      gradingFailurePatterns: ["Instructions unclear"],
    };
    const results = generateTargetedBodyMutations(testSkillPath, weaknesses);
    // At least one variant should have an expanded Instructions section
    const anyExpanded = results.some((r) => {
      const content = readFileSync(r.variantSkillPath, "utf-8");
      const original = readFileSync(testSkillPath, "utf-8");
      return content.length > original.length;
    });
    expect(anyExpanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reflective mutations
// ---------------------------------------------------------------------------

describe("generateReflectiveRoutingMutations", () => {
  test("builds a routing variant from measured failures using the reflective proposer", async () => {
    const results = await generateReflectiveRoutingMutations(
      testSkillPath,
      {
        replayFailureSamples: ["archive project tasks"],
        routingFailureSamples: [],
        bodyQualityScore: 0.9,
        gradingPassRateDelta: 0,
      },
      {
        skillName: "test-skill",
        agent: "claude",
      },
      {
        generateRoutingProposal: async () => ({
          proposal_id: "proposal-routing",
          skill_name: "test-skill",
          skill_path: testSkillPath,
          original_body: "",
          proposed_body:
            "| Trigger | Workflow |\n| --- | --- |\n| archive project tasks | task-archive |",
          rationale: "Add archive routing coverage",
          target: "routing",
          failure_patterns: [],
          confidence: 0.9,
          created_at: new Date().toISOString(),
          status: "pending",
        }),
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.mutationDescription).toContain("Reflective");
    const content = readFileSync(results[0]!.variantSkillPath, "utf-8");
    expect(content).toContain("archive project tasks");
    expect(content).toContain("task-archive");
  });
});

describe("generateReflectiveBodyMutations", () => {
  test("builds a body variant from measured grading failures using the reflective proposer", async () => {
    const results = await generateReflectiveBodyMutations(
      testSkillPath,
      {
        replayFailureSamples: ["create rollout checklist"],
        routingFailureSamples: [],
        bodyQualityScore: 0.4,
        gradingPassRateDelta: -0.2,
        gradingFailurePatterns: ["missing verification step"],
      },
      {
        skillName: "test-skill",
        agent: "claude",
      },
      {
        generateBodyProposal: async () => ({
          proposal_id: "proposal-body",
          skill_name: "test-skill",
          skill_path: testSkillPath,
          original_body: "",
          proposed_body: `A skill for testing bounded mutations with stronger verification guidance.

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| create task | task-create |
| list tasks | task-list |
| update task | task-update |

## Instructions

Follow these steps to manage tasks:
1. Parse the user request
2. Identify the task operation
3. Execute the appropriate workflow
4. Verify the result before replying`,
          rationale: "Strengthen verification instructions",
          target: "body",
          failure_patterns: [],
          confidence: 0.86,
          created_at: new Date().toISOString(),
          status: "pending",
        }),
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.mutationDescription).toContain("Reflective");
    const content = readFileSync(results[0]!.variantSkillPath, "utf-8");
    expect(content).toContain("# Test Skill");
    expect(content).toContain("Verify the result before replying");
  });
});

// ---------------------------------------------------------------------------
// Weakness extraction
// ---------------------------------------------------------------------------

describe("extractMutationWeaknesses", () => {
  test("returns MutationWeaknesses with all required fields", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result).toHaveProperty("replayFailureSamples");
    expect(result).toHaveProperty("routingFailureSamples");
    expect(result).toHaveProperty("bodyQualityScore");
    expect(result).toHaveProperty("gradingPassRateDelta");
    expect(Array.isArray(result.replayFailureSamples)).toBe(true);
    expect(Array.isArray(result.routingFailureSamples)).toBe(true);
    expect(typeof result.bodyQualityScore).toBe("number");
    expect(typeof result.gradingPassRateDelta).toBe("number");
  });

  test("extracts replay failures from evidence table", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    const validationJson = JSON.stringify({
      per_entry_results: [
        { query: "create a task", should_trigger: true, triggered: false, passed: false },
        { query: "delete project", should_trigger: true, triggered: true, passed: true },
      ],
    });
    db.run(
      `INSERT INTO evolution_evidence (timestamp, proposal_id, skill_name, skill_path, target, stage, validation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        "evo-test-1",
        "test-skill",
        "/tmp/skill",
        "routing",
        "validated",
        validationJson,
      ],
    );

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result.replayFailureSamples).toContain("create a task");
    expect(result.replayFailureSamples).not.toContain("delete project");
  });

  test("extracts grading pass rate delta from grading results", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    const now = new Date();
    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["s1", "test-skill", "/tmp/t1", new Date(now.getTime() - 60000).toISOString(), 0.8, "[]"],
    );
    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["s2", "test-skill", "/tmp/t2", now.toISOString(), 0.6, "[]"],
    );

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result.gradingPassRateDelta).toBeLessThan(0);
  });

  test("extracts grading failure patterns from expectations_json", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    const now = new Date();
    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "s1",
        "test-skill",
        "/tmp/t1",
        now.toISOString(),
        0.625,
        JSON.stringify([
          { text: "correct output format", passed: true },
          { text: "handles edge cases", passed: false },
          { text: "follows instructions", passed: false },
          { text: "valid JSON response", passed: true },
        ]),
      ],
    );
    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "s2",
        "test-skill",
        "/tmp/t2",
        new Date(now.getTime() - 60000).toISOString(),
        0.75,
        JSON.stringify([
          { text: "correct output format", passed: true },
          { text: "handles edge cases", passed: true },
          { text: "respects timeout", passed: false },
        ]),
      ],
    );

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result.gradingFailurePatterns).toBeDefined();
    expect(result.gradingFailurePatterns).toContain("handles edge cases");
    expect(result.gradingFailurePatterns).toContain("follows instructions");
    expect(result.gradingFailurePatterns).toContain("respects timeout");
    expect(result.gradingFailurePatterns).not.toContain("correct output format");
    expect(result.gradingFailurePatterns).not.toContain("valid JSON response");
  });

  test("uses description when name is absent in expectations", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "s1",
        "test-skill",
        "/tmp/t1",
        new Date().toISOString(),
        0.5,
        JSON.stringify([{ description: "output must be valid JSON", passed: false }]),
      ],
    );

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result.gradingFailurePatterns).toContain("output must be valid JSON");
  });

  test("extracts grading failure patterns from failure feedback hints", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    db.run(
      `INSERT INTO grading_results
        (session_id, skill_name, transcript_path, graded_at, pass_rate, expectations_json, failure_feedback_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "s1",
        "test-skill",
        "/tmp/t1",
        new Date().toISOString(),
        0.4,
        "[]",
        JSON.stringify([
          {
            query: "generate a report",
            failure_reason: "missed required JSON structure",
            improvement_hint: "always return valid JSON with the required schema",
          },
        ]),
      ],
    );

    const result = extractMutationWeaknesses("test-skill", db);
    expect(result.gradingFailurePatterns).toContain(
      "always return valid JSON with the required schema",
    );
  });

  test("returns defaults when no data exists", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");

    createWeaknessTestTables(db);

    const result = extractMutationWeaknesses("nonexistent-skill", db);
    expect(result.replayFailureSamples).toEqual([]);
    expect(result.routingFailureSamples).toEqual([]);
    expect(result.bodyQualityScore).toBe(1.0);
    expect(result.gradingPassRateDelta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("cleanupVariants", () => {
  test("removes variant files from disk", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      maxVariants: 2,
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    // Verify they exist first
    for (const r of results) {
      expect(existsSync(r.variantSkillPath)).toBe(true);
    }

    cleanupVariants(results);

    // Now they should be gone
    for (const r of results) {
      expect(existsSync(r.variantSkillPath)).toBe(false);
    }
  });

  test("handles already-deleted files gracefully", () => {
    const fakeResults = [
      {
        variantSkillPath: "/tmp/nonexistent-variant-12345/SKILL.md",
        mutationSurface: "routing" as const,
        mutationDescription: "test",
        parentFingerprint: "abc",
      },
    ];

    // Should not throw
    expect(() => cleanupVariants(fakeResults)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fingerprint consistency
// ---------------------------------------------------------------------------

describe("fingerprinting", () => {
  test("all variants from same parent share the same fingerprint", async () => {
    const results = await generateRoutingMutations(testSkillPath, {
      maxVariants: 3,
      mutationSurface: "routing",
      parentSkillPath: testSkillPath,
    });

    const fingerprints = results.map((r) => r.parentFingerprint);
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(1);
  });
});
