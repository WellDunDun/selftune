#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook: evolution-guard.ts
 *
 * Fires before Write/Edit tool calls. If the target is a SKILL.md file
 * that has a deployed evolution (i.e., is under active monitoring), and
 * no recent `selftune watch` snapshot exists, this hook BLOCKS the write
 * with exit code 2 and a message suggesting to run watch first.
 *
 * Exit codes:
 *   0 = allow (not a SKILL.md, not monitored, or watch is recent)
 *   2 = block with message (Claude Code convention for PreToolUse hooks)
 *
 * Fail-open: any error → exit 0 (never block accidentally).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { EVOLUTION_AUDIT_LOG, SELFTUNE_CONFIG_DIR } from "../constants.js";
import { getDb } from "../localdb/db.js";
import { queryEvolutionAudit } from "../localdb/queries.js";
import type { PreToolUsePayload } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";

// ---------------------------------------------------------------------------
// Detection helpers (same pattern as skill-change-guard)
// ---------------------------------------------------------------------------

function isSkillMdWrite(toolName: string, filePath: string): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  return basename(filePath).toUpperCase() === "SKILL.MD";
}

function extractSkillName(filePath: string): string {
  return basename(dirname(filePath)) || "unknown";
}

// ---------------------------------------------------------------------------
// Active monitoring check (reads audit log directly — no evolution imports)
// ---------------------------------------------------------------------------

/**
 * Check if a skill has an active deployed evolution (meaning it's under monitoring).
 * Reads the evolution audit JSONL directly to respect architecture lint rules.
 *
 * A skill is "actively monitored" if its last audit action is "deployed".
 * If the last action is "rolled_back", it's no longer monitored.
 */
export function checkActiveMonitoring(skillName: string, auditLogPath: string): boolean {
  // Try SQLite first, fall back to JSONL for non-default paths (e.g., tests)
  let entries: Array<{ skill_name?: string; action: string }>;
  if (auditLogPath === EVOLUTION_AUDIT_LOG) {
    try {
      const db = getDb();
      entries = queryEvolutionAudit(db, skillName) as Array<{
        skill_name?: string;
        action: string;
      }>;
    } catch {
      entries = readJsonl<{ skill_name?: string; action: string }>(auditLogPath);
    }
  } else {
    entries = readJsonl<{ skill_name?: string; action: string }>(auditLogPath);
  }

  // Filter entries for this skill by skill_name field
  const skillEntries = entries.filter((e) => e.skill_name === skillName);
  if (skillEntries.length === 0) return false;

  const lastEntry = skillEntries[skillEntries.length - 1];
  return lastEntry.action === "deployed";
}

// ---------------------------------------------------------------------------
// Recent watch snapshot check (reads monitoring dir directly)
// ---------------------------------------------------------------------------

/**
 * Check if there's a recent monitoring snapshot for the given skill.
 * "Recent" means within `maxAgeHours` hours.
 */
export function hasRecentWatchSnapshot(
  skillName: string,
  selftuneDir: string,
  maxAgeHours: number,
): boolean {
  const snapshotPath = join(selftuneDir, "monitoring", "latest-snapshot.json");
  if (!existsSync(snapshotPath)) return false;

  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
      timestamp: string;
      skill_name?: string;
    };

    // Must be for the same skill
    if (snapshot.skill_name !== skillName) return false;

    // Must be recent
    const snapshotAge = Date.now() - new Date(snapshot.timestamp).getTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    return snapshotAge <= maxAgeMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guard result type
// ---------------------------------------------------------------------------

export interface GuardResult {
  exitCode: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Core processing logic
// ---------------------------------------------------------------------------

export interface GuardOptions {
  auditLogPath: string;
  selftuneDir: string;
  maxSnapshotAgeHours?: number;
}

/**
 * Process a PreToolUse payload. Returns null if the write should be allowed,
 * or a GuardResult with exitCode 2 if the write should be blocked.
 */
export function processEvolutionGuard(
  payload: PreToolUsePayload,
  options: GuardOptions,
): GuardResult | null {
  const filePath =
    typeof payload.tool_input?.file_path === "string" ? payload.tool_input.file_path : "";

  if (!isSkillMdWrite(payload.tool_name, filePath)) return null;

  const skillName = extractSkillName(filePath);
  const { auditLogPath, selftuneDir, maxSnapshotAgeHours = 24 } = options;

  // Check if this skill is under active monitoring
  if (!checkActiveMonitoring(skillName, auditLogPath)) return null;

  // Check if there's a recent watch snapshot
  if (hasRecentWatchSnapshot(skillName, selftuneDir, maxSnapshotAgeHours)) return null;

  // Block: skill is monitored but no recent watch
  return {
    exitCode: 2,
    message: `[selftune] Skill "${skillName}" has a deployed evolution and is under active monitoring. Run \`selftune watch --skill ${skillName}\` before modifying SKILL.md to check current health.`,
  };
}

// ---------------------------------------------------------------------------
// stdin main (only when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const payload: PreToolUsePayload = JSON.parse(await Bun.stdin.text());

    const result = processEvolutionGuard(payload, {
      auditLogPath: EVOLUTION_AUDIT_LOG,
      selftuneDir: SELFTUNE_CONFIG_DIR,
    });

    if (result) {
      // Exit code 2 = block with message
      process.stderr.write(`${result.message}\n`);
      process.exit(2);
    }
  } catch {
    // Fail-open: any error → allow the write
  }
  process.exit(0);
}
