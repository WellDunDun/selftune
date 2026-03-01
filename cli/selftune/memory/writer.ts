/**
 * Memory writer — pure functions for reading/writing evolution memory files.
 *
 * Memory files live at ~/.selftune/memory/ and provide human-readable session
 * context that survives context resets. Three files:
 *   - context.md  — active evolutions, known issues
 *   - plan.md     — current priorities, strategy
 *   - decisions.md — append-only decision log
 *
 * All functions accept an optional memoryDir parameter for testability.
 * Default: MEMORY_DIR from constants.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_DIR } from "../constants.js";
import type { EvolveResult } from "../evolution/evolve.js";
import type { RollbackResult } from "../evolution/rollback.js";
import type {
  DecisionRecord,
  EvolutionProposal,
  MemoryContext,
  MemoryPlan,
  MonitoringSnapshot,
} from "../types.js";

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

export function ensureMemoryDir(memoryDir: string = MEMORY_DIR): void {
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// context.md
// ---------------------------------------------------------------------------

function formatContext(data: MemoryContext): string {
  const lines: string[] = ["# Selftune Context", ""];

  lines.push("## Active Evolutions");
  if (data.activeEvolutions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const evo of data.activeEvolutions) {
      lines.push(`- ${evo.skillName}: ${evo.status} — ${evo.description}`);
    }
  }
  lines.push("");

  lines.push("## Known Issues");
  if (data.knownIssues.length === 0) {
    lines.push("- (none)");
  } else {
    for (const issue of data.knownIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("");

  lines.push("## Last Updated");
  lines.push(data.lastUpdated);
  lines.push("");

  return lines.join("\n");
}

function parseContext(content: string): MemoryContext {
  const result: MemoryContext = {
    activeEvolutions: [],
    knownIssues: [],
    lastUpdated: "",
  };

  const lines = content.split("\n");
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "## Active Evolutions") {
      section = "evolutions";
      continue;
    }
    if (trimmed === "## Known Issues") {
      section = "issues";
      continue;
    }
    if (trimmed === "## Last Updated") {
      section = "updated";
      continue;
    }
    if (trimmed.startsWith("# ")) {
      section = "";
      continue;
    }

    if (section === "evolutions" && trimmed.startsWith("- ") && trimmed !== "- (none)") {
      // Format: "- skillName: status — description"
      const body = trimmed.slice(2);
      const colonIdx = body.indexOf(":");
      if (colonIdx === -1) continue;
      const skillName = body.slice(0, colonIdx).trim();
      const rest = body.slice(colonIdx + 1).trim();
      const dashIdx = rest.indexOf("—");
      if (dashIdx === -1) {
        result.activeEvolutions.push({ skillName, status: rest.trim(), description: "" });
      } else {
        const status = rest.slice(0, dashIdx).trim();
        const description = rest.slice(dashIdx + 1).trim();
        result.activeEvolutions.push({ skillName, status, description });
      }
    }

    if (section === "issues" && trimmed.startsWith("- ") && trimmed !== "- (none)") {
      result.knownIssues.push(trimmed.slice(2));
    }

    if (section === "updated" && trimmed.length > 0) {
      result.lastUpdated = trimmed;
      section = "";
    }
  }

  return result;
}

export function writeContext(data: MemoryContext, memoryDir: string = MEMORY_DIR): void {
  ensureMemoryDir(memoryDir);
  const filePath = join(memoryDir, "context.md");
  writeFileSync(filePath, formatContext(data), "utf-8");
}

export function readContext(memoryDir: string = MEMORY_DIR): MemoryContext {
  const filePath = join(memoryDir, "context.md");
  if (!existsSync(filePath)) {
    return { activeEvolutions: [], knownIssues: [], lastUpdated: "" };
  }
  const content = readFileSync(filePath, "utf-8");
  return parseContext(content);
}

// ---------------------------------------------------------------------------
// plan.md
// ---------------------------------------------------------------------------

function formatPlan(data: MemoryPlan): string {
  const lines: string[] = ["# Evolution Plan", ""];

  lines.push("## Current Priorities");
  if (data.currentPriorities.length === 0) {
    lines.push("1. (none)");
  } else {
    for (let i = 0; i < data.currentPriorities.length; i++) {
      lines.push(`${i + 1}. ${data.currentPriorities[i]}`);
    }
  }
  lines.push("");

  lines.push("## Strategy");
  lines.push(data.strategy || "(no strategy defined)");
  lines.push("");

  lines.push("## Last Updated");
  lines.push(data.lastUpdated);
  lines.push("");

  return lines.join("\n");
}

function parsePlan(content: string): MemoryPlan {
  const result: MemoryPlan = {
    currentPriorities: [],
    strategy: "",
    lastUpdated: "",
  };

  const lines = content.split("\n");
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "## Current Priorities") {
      section = "priorities";
      continue;
    }
    if (trimmed === "## Strategy") {
      section = "strategy";
      continue;
    }
    if (trimmed === "## Last Updated") {
      section = "updated";
      continue;
    }
    if (trimmed.startsWith("# ")) {
      section = "";
      continue;
    }

    if (section === "priorities") {
      // Format: "1. priority text"
      const match = trimmed.match(/^\d+\.\s+(.+)$/);
      if (match && match[1] !== "(none)") {
        result.currentPriorities.push(match[1]);
      }
    }

    if (section === "strategy" && trimmed.length > 0 && trimmed !== "(no strategy defined)") {
      result.strategy = trimmed;
    }

    if (section === "updated" && trimmed.length > 0) {
      result.lastUpdated = trimmed;
      section = "";
    }
  }

  return result;
}

export function writePlan(data: MemoryPlan, memoryDir: string = MEMORY_DIR): void {
  ensureMemoryDir(memoryDir);
  const filePath = join(memoryDir, "plan.md");
  writeFileSync(filePath, formatPlan(data), "utf-8");
}

export function readPlan(memoryDir: string = MEMORY_DIR): MemoryPlan {
  const filePath = join(memoryDir, "plan.md");
  if (!existsSync(filePath)) {
    return { currentPriorities: [], strategy: "", lastUpdated: "" };
  }
  const content = readFileSync(filePath, "utf-8");
  return parsePlan(content);
}

// ---------------------------------------------------------------------------
// decisions.md (append-only)
// ---------------------------------------------------------------------------

function formatDecisionEntry(record: DecisionRecord): string {
  const lines: string[] = [
    `## ${record.timestamp} — ${record.actionType}`,
    `- **Skill:** ${record.skillName}`,
    `- **Action:** ${record.action}`,
    `- **Rationale:** ${record.rationale}`,
    `- **Result:** ${record.result}`,
    "",
    "---",
    "",
  ];
  return lines.join("\n");
}

function parseDecisions(content: string): DecisionRecord[] {
  const records: DecisionRecord[] = [];
  // Split on --- separators
  const blocks = content.split(/^---$/m);

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let timestamp = "";
    let actionType = "";
    let skillName = "";
    let action: DecisionRecord["action"] = "watched";
    let rationale = "";
    let result = "";

    for (const line of lines) {
      // Header: "## 2026-03-01T00:00:00Z — evolve"
      const headerMatch = line.match(/^## (.+?) — (.+)$/);
      if (headerMatch) {
        timestamp = headerMatch[1];
        actionType = headerMatch[2];
        continue;
      }

      if (line.startsWith("- **Skill:**")) {
        skillName = line.replace("- **Skill:**", "").trim();
      } else if (line.startsWith("- **Action:**")) {
        const raw = line.replace("- **Action:**", "").trim();
        if (raw === "evolved" || raw === "rolled-back" || raw === "watched") {
          action = raw;
        }
      } else if (line.startsWith("- **Rationale:**")) {
        rationale = line.replace("- **Rationale:**", "").trim();
      } else if (line.startsWith("- **Result:**")) {
        result = line.replace("- **Result:**", "").trim();
      }
    }

    if (timestamp && skillName) {
      records.push({ timestamp, actionType, skillName, action, rationale, result });
    }
  }

  return records;
}

export function appendDecision(record: DecisionRecord, memoryDir: string = MEMORY_DIR): void {
  ensureMemoryDir(memoryDir);
  const filePath = join(memoryDir, "decisions.md");

  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  } else {
    existing = "# Decision Log\n\n";
  }

  const entry = formatDecisionEntry(record);
  writeFileSync(filePath, existing + entry, "utf-8");
}

export function readDecisions(memoryDir: string = MEMORY_DIR): DecisionRecord[] {
  const filePath = join(memoryDir, "decisions.md");
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  return parseDecisions(content);
}

// ---------------------------------------------------------------------------
// High-level helpers for integration
// ---------------------------------------------------------------------------

export function updateContextAfterEvolve(
  skillName: string,
  proposal: EvolutionProposal,
  result: EvolveResult,
  memoryDir: string = MEMORY_DIR,
): void {
  const now = new Date().toISOString();
  const context = readContext(memoryDir);

  const status = result.deployed ? "deployed" : "failed";
  const description = proposal.rationale || result.reason;

  // Update or add the evolution entry
  const idx = context.activeEvolutions.findIndex((e) => e.skillName === skillName);
  if (idx >= 0) {
    context.activeEvolutions[idx] = { skillName, status, description };
  } else {
    context.activeEvolutions.push({ skillName, status, description });
  }

  context.lastUpdated = now;
  writeContext(context, memoryDir);

  // Append decision
  appendDecision(
    {
      timestamp: now,
      actionType: "evolve",
      skillName,
      action: "evolved",
      rationale: proposal.rationale || "Evolution triggered",
      result: result.reason,
    },
    memoryDir,
  );
}

export function updateContextAfterRollback(
  skillName: string,
  result: RollbackResult,
  memoryDir: string = MEMORY_DIR,
): void {
  const now = new Date().toISOString();
  const context = readContext(memoryDir);

  const status = result.rolledBack ? "rolled-back" : "rollback-failed";
  const description = result.reason;

  const idx = context.activeEvolutions.findIndex((e) => e.skillName === skillName);
  if (idx >= 0) {
    context.activeEvolutions[idx] = { skillName, status, description };
  } else {
    context.activeEvolutions.push({ skillName, status, description });
  }

  context.lastUpdated = now;
  writeContext(context, memoryDir);

  appendDecision(
    {
      timestamp: now,
      actionType: "rollback",
      skillName,
      action: "rolled-back",
      rationale: result.reason,
      result: result.rolledBack ? "Successfully rolled back" : "Rollback failed",
    },
    memoryDir,
  );
}

export function updateContextAfterWatch(
  skillName: string,
  snapshot: MonitoringSnapshot,
  memoryDir: string = MEMORY_DIR,
): void {
  const now = new Date().toISOString();
  const context = readContext(memoryDir);

  const status = snapshot.regression_detected ? "regression" : "healthy";
  const description = `pass_rate=${snapshot.pass_rate.toFixed(2)}, baseline=${snapshot.baseline_pass_rate.toFixed(2)}`;

  const idx = context.activeEvolutions.findIndex((e) => e.skillName === skillName);
  if (idx >= 0) {
    context.activeEvolutions[idx] = { skillName, status, description };
  } else {
    context.activeEvolutions.push({ skillName, status, description });
  }

  // Add known issue if regression detected
  if (snapshot.regression_detected) {
    const issue = `Regression detected for ${skillName}: pass_rate=${snapshot.pass_rate.toFixed(2)} below baseline=${snapshot.baseline_pass_rate.toFixed(2)}`;
    if (!context.knownIssues.some((i) => i.includes(skillName) && i.includes("Regression"))) {
      context.knownIssues.push(issue);
    }
  }

  context.lastUpdated = now;
  writeContext(context, memoryDir);

  appendDecision(
    {
      timestamp: now,
      actionType: "watch",
      skillName,
      action: "watched",
      rationale: `Monitoring check: pass_rate=${snapshot.pass_rate.toFixed(2)}, regression=${snapshot.regression_detected}`,
      result: snapshot.regression_detected
        ? `Regression detected (pass_rate=${snapshot.pass_rate.toFixed(2)})`
        : `Healthy (pass_rate=${snapshot.pass_rate.toFixed(2)})`,
    },
    memoryDir,
  );
}
