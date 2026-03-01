/**
 * Tests for evolution memory writer (session context persistence).
 *
 * Verifies that the memory system correctly reads/writes context.md, plan.md,
 * and decisions.md files, handles missing directories gracefully, and provides
 * high-level helpers for evolve/rollback/watch integration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendDecision,
  ensureMemoryDir,
  readContext,
  readDecisions,
  readPlan,
  updateContextAfterEvolve,
  updateContextAfterRollback,
  updateContextAfterWatch,
  writeContext,
  writePlan,
} from "../../cli/selftune/memory/writer.js";
import type {
  DecisionRecord,
  EvolutionProposal,
  MemoryContext,
  MemoryPlan,
  MonitoringSnapshot,
} from "../../cli/selftune/types.js";
import type { EvolveResult } from "../../cli/selftune/evolution/evolve.js";
import type { RollbackResult } from "../../cli/selftune/evolution/rollback.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let memDir: string;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "selftune-memory-test-"));
});

afterEach(() => {
  rmSync(memDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureMemoryDir
// ---------------------------------------------------------------------------

describe("ensureMemoryDir", () => {
  test("creates the memory directory if it does not exist", () => {
    const target = join(memDir, "nested", "memory");
    expect(existsSync(target)).toBe(false);

    ensureMemoryDir(target);

    expect(existsSync(target)).toBe(true);
  });

  test("succeeds if directory already exists", () => {
    mkdirSync(memDir, { recursive: true });
    // Should not throw
    ensureMemoryDir(memDir);
    expect(existsSync(memDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// context.md — write and read
// ---------------------------------------------------------------------------

describe("writeContext / readContext", () => {
  test("writes a valid context.md file", () => {
    const data: MemoryContext = {
      activeEvolutions: [
        { skillName: "pptx", status: "deployed", description: "Added slide deck triggers" },
      ],
      knownIssues: ["Low session count for grading"],
      lastUpdated: "2026-03-01T00:00:00Z",
    };

    writeContext(data, memDir);

    const filePath = join(memDir, "context.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Selftune Context");
    expect(content).toContain("## Active Evolutions");
    expect(content).toContain("pptx");
    expect(content).toContain("deployed");
    expect(content).toContain("## Known Issues");
    expect(content).toContain("Low session count");
    expect(content).toContain("## Last Updated");
    expect(content).toContain("2026-03-01T00:00:00Z");
  });

  test("reads context.md back into structured data", () => {
    const data: MemoryContext = {
      activeEvolutions: [
        { skillName: "pptx", status: "deployed", description: "Added slide deck triggers" },
        { skillName: "csv", status: "pending", description: "Investigating CSV handling" },
      ],
      knownIssues: ["Low session count", "Grading flaky"],
      lastUpdated: "2026-03-01T00:00:00Z",
    };

    writeContext(data, memDir);
    const parsed = readContext(memDir);

    expect(parsed.activeEvolutions).toHaveLength(2);
    expect(parsed.activeEvolutions[0].skillName).toBe("pptx");
    expect(parsed.activeEvolutions[0].status).toBe("deployed");
    expect(parsed.activeEvolutions[1].skillName).toBe("csv");
    expect(parsed.knownIssues).toHaveLength(2);
    expect(parsed.lastUpdated).toBe("2026-03-01T00:00:00Z");
  });

  test("returns empty context when file does not exist", () => {
    const parsed = readContext(memDir);

    expect(parsed.activeEvolutions).toHaveLength(0);
    expect(parsed.knownIssues).toHaveLength(0);
    expect(parsed.lastUpdated).toBe("");
  });

  test("creates memory directory if it does not exist", () => {
    const nested = join(memDir, "deep", "memory");
    const data: MemoryContext = {
      activeEvolutions: [],
      knownIssues: [],
      lastUpdated: "2026-03-01T00:00:00Z",
    };

    writeContext(data, nested);
    expect(existsSync(join(nested, "context.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// plan.md — write and read
// ---------------------------------------------------------------------------

describe("writePlan / readPlan", () => {
  test("writes a valid plan.md file", () => {
    const data: MemoryPlan = {
      currentPriorities: ["Evolve pptx skill", "Monitor csv skill"],
      strategy: "Focus on high-traffic skills first",
      lastUpdated: "2026-03-01T00:00:00Z",
    };

    writePlan(data, memDir);

    const filePath = join(memDir, "plan.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Evolution Plan");
    expect(content).toContain("## Current Priorities");
    expect(content).toContain("Evolve pptx skill");
    expect(content).toContain("Monitor csv skill");
    expect(content).toContain("## Strategy");
    expect(content).toContain("Focus on high-traffic skills first");
    expect(content).toContain("## Last Updated");
  });

  test("reads plan.md back into structured data", () => {
    const data: MemoryPlan = {
      currentPriorities: ["Priority A", "Priority B"],
      strategy: "Do the thing",
      lastUpdated: "2026-03-01T00:00:00Z",
    };

    writePlan(data, memDir);
    const parsed = readPlan(memDir);

    expect(parsed.currentPriorities).toHaveLength(2);
    expect(parsed.currentPriorities[0]).toBe("Priority A");
    expect(parsed.strategy).toBe("Do the thing");
    expect(parsed.lastUpdated).toBe("2026-03-01T00:00:00Z");
  });

  test("returns empty plan when file does not exist", () => {
    const parsed = readPlan(memDir);

    expect(parsed.currentPriorities).toHaveLength(0);
    expect(parsed.strategy).toBe("");
    expect(parsed.lastUpdated).toBe("");
  });
});

// ---------------------------------------------------------------------------
// decisions.md — append and read
// ---------------------------------------------------------------------------

describe("appendDecision / readDecisions", () => {
  test("creates decisions.md with header on first append", () => {
    const record: DecisionRecord = {
      timestamp: "2026-03-01T00:00:00Z",
      actionType: "evolve",
      skillName: "pptx",
      action: "evolved",
      rationale: "Failure patterns found in implicit triggers",
      result: "Pass rate improved from 0.70 to 0.92",
    };

    appendDecision(record, memDir);

    const filePath = join(memDir, "decisions.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Decision Log");
    expect(content).toContain("2026-03-01T00:00:00Z");
    expect(content).toContain("evolve");
    expect(content).toContain("pptx");
    expect(content).toContain("evolved");
    expect(content).toContain("Failure patterns found");
    expect(content).toContain("Pass rate improved");
  });

  test("appends multiple decisions sequentially", () => {
    const record1: DecisionRecord = {
      timestamp: "2026-03-01T01:00:00Z",
      actionType: "evolve",
      skillName: "pptx",
      action: "evolved",
      rationale: "First evolution",
      result: "Success",
    };
    const record2: DecisionRecord = {
      timestamp: "2026-03-01T02:00:00Z",
      actionType: "rollback",
      skillName: "pptx",
      action: "rolled-back",
      rationale: "Regression detected",
      result: "Rolled back to previous version",
    };

    appendDecision(record1, memDir);
    appendDecision(record2, memDir);

    const decisions = readDecisions(memDir);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].action).toBe("evolved");
    expect(decisions[1].action).toBe("rolled-back");
  });

  test("reads decisions back into structured data", () => {
    const record: DecisionRecord = {
      timestamp: "2026-03-01T00:00:00Z",
      actionType: "watch",
      skillName: "csv",
      action: "watched",
      rationale: "Routine monitoring check",
      result: "No regression detected",
    };

    appendDecision(record, memDir);
    const decisions = readDecisions(memDir);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].timestamp).toBe("2026-03-01T00:00:00Z");
    expect(decisions[0].skillName).toBe("csv");
    expect(decisions[0].action).toBe("watched");
    expect(decisions[0].rationale).toBe("Routine monitoring check");
    expect(decisions[0].result).toBe("No regression detected");
  });

  test("returns empty array when file does not exist", () => {
    const decisions = readDecisions(memDir);
    expect(decisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateContextAfterEvolve — high-level helper
// ---------------------------------------------------------------------------

describe("updateContextAfterEvolve", () => {
  test("adds an active evolution entry and a decision record", () => {
    const proposal = {
      proposal_id: "evo-pptx-001",
      skill_name: "pptx",
      rationale: "Added implicit triggers for slide deck queries",
      confidence: 0.85,
      status: "deployed",
    } as Partial<EvolutionProposal>;

    const result = {
      deployed: true,
      reason: "Evolution deployed successfully",
    } as Partial<EvolveResult>;

    updateContextAfterEvolve("pptx", proposal as EvolutionProposal, result as EvolveResult, memDir);

    const context = readContext(memDir);
    expect(context.activeEvolutions).toHaveLength(1);
    expect(context.activeEvolutions[0].skillName).toBe("pptx");
    expect(context.activeEvolutions[0].status).toBe("deployed");

    const decisions = readDecisions(memDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].skillName).toBe("pptx");
    expect(decisions[0].action).toBe("evolved");
  });

  test("updates existing evolution entry for same skill", () => {
    // Pre-seed context with an existing entry
    writeContext(
      {
        activeEvolutions: [
          { skillName: "pptx", status: "pending", description: "Previous state" },
        ],
        knownIssues: [],
        lastUpdated: "2026-02-28T00:00:00Z",
      },
      memDir,
    );

    const proposal = {
      proposal_id: "evo-pptx-002",
      skill_name: "pptx",
      rationale: "Second evolution attempt",
      confidence: 0.90,
      status: "deployed",
    } as Partial<EvolutionProposal>;

    const result = {
      deployed: true,
      reason: "Evolution deployed successfully",
    } as Partial<EvolveResult>;

    updateContextAfterEvolve("pptx", proposal as EvolutionProposal, result as EvolveResult, memDir);

    const context = readContext(memDir);
    // Should have one entry (updated, not duplicated)
    expect(context.activeEvolutions).toHaveLength(1);
    expect(context.activeEvolutions[0].status).toBe("deployed");
  });
});

// ---------------------------------------------------------------------------
// updateContextAfterRollback — high-level helper
// ---------------------------------------------------------------------------

describe("updateContextAfterRollback", () => {
  test("marks skill as rolled-back in context and appends decision", () => {
    // Pre-seed context with a deployed evolution
    writeContext(
      {
        activeEvolutions: [
          { skillName: "pptx", status: "deployed", description: "Some evolution" },
        ],
        knownIssues: [],
        lastUpdated: "2026-02-28T00:00:00Z",
      },
      memDir,
    );

    const result = {
      rolledBack: true,
      reason: "Restored from backup file",
    } as Partial<RollbackResult>;

    updateContextAfterRollback("pptx", result as RollbackResult, memDir);

    const context = readContext(memDir);
    expect(context.activeEvolutions).toHaveLength(1);
    expect(context.activeEvolutions[0].status).toBe("rolled-back");

    const decisions = readDecisions(memDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("rolled-back");
    expect(decisions[0].skillName).toBe("pptx");
  });

  test("adds new entry when skill not in context", () => {
    const result = {
      rolledBack: true,
      reason: "Restored from audit trail",
    } as Partial<RollbackResult>;

    updateContextAfterRollback("csv", result as RollbackResult, memDir);

    const context = readContext(memDir);
    expect(context.activeEvolutions).toHaveLength(1);
    expect(context.activeEvolutions[0].skillName).toBe("csv");
    expect(context.activeEvolutions[0].status).toBe("rolled-back");
  });
});

// ---------------------------------------------------------------------------
// updateContextAfterWatch — high-level helper
// ---------------------------------------------------------------------------

describe("updateContextAfterWatch", () => {
  test("updates context with monitoring snapshot and adds decision", () => {
    const snapshot = {
      skill_name: "pptx",
      pass_rate: 0.89,
      baseline_pass_rate: 0.92,
      regression_detected: false,
    } as Partial<MonitoringSnapshot>;

    updateContextAfterWatch("pptx", snapshot as MonitoringSnapshot, memDir);

    const context = readContext(memDir);
    expect(context.activeEvolutions).toHaveLength(1);
    expect(context.activeEvolutions[0].skillName).toBe("pptx");
    expect(context.activeEvolutions[0].status).toBe("healthy");

    const decisions = readDecisions(memDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("watched");
  });

  test("marks regression in context when detected", () => {
    const snapshot = {
      skill_name: "pptx",
      pass_rate: 0.45,
      baseline_pass_rate: 0.92,
      regression_detected: true,
    } as Partial<MonitoringSnapshot>;

    updateContextAfterWatch("pptx", snapshot as MonitoringSnapshot, memDir);

    const context = readContext(memDir);
    expect(context.activeEvolutions[0].status).toBe("regression");
    expect(context.knownIssues.length).toBeGreaterThan(0);
    expect(context.knownIssues[0]).toContain("pptx");
  });
});
