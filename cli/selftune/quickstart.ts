/**
 * selftune quickstart — Guided onboarding that runs init, ingest, and status.
 *
 * Steps:
 *  1. Run `init` if config doesn't exist
 *  2. Run `ingest claude` if marker file doesn't exist
 *  3. Run `status` to display current state
 *  4. Suggest top 3 skills to evolve
 */

import { existsSync } from "node:fs";

import {
  CLAUDE_CODE_MARKER,
  CLAUDE_CODE_PROJECTS_DIR,
  SELFTUNE_CONFIG_DIR,
  SELFTUNE_CONFIG_PATH,
} from "./constants.js";
import { findTranscriptFiles, parseSession, writeSession } from "./ingestors/claude-replay.js";
import { runInit } from "./init.js";
import { getDb } from "./localdb/db.js";
import {
  queryEvolutionAudit,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "./localdb/queries.js";
import { doctor } from "./observability.js";
import type { SkillStatus } from "./status.js";
import { computeStatus, formatStatus } from "./status.js";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { loadMarker, saveMarker } from "./utils/jsonl.js";

// ---------------------------------------------------------------------------
// quickstart logic
// ---------------------------------------------------------------------------

export async function quickstart(): Promise<void> {
  console.log("selftune quickstart");
  console.log("=".repeat(20));
  console.log("");

  // Step 1: Init if needed
  if (existsSync(SELFTUNE_CONFIG_PATH)) {
    console.log("[1/3] Config exists, skipping init.");
  } else {
    console.log("[1/3] Running init...");
    try {
      await runInit({
        configDir: SELFTUNE_CONFIG_DIR,
        configPath: SELFTUNE_CONFIG_PATH,
        force: false,
      });
      console.log("      Config created.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      Init failed: ${msg}`);
      console.log("      You can run `selftune init` manually to troubleshoot.");
    }
  }

  // Step 2: Ingest if marker doesn't exist
  if (existsSync(CLAUDE_CODE_MARKER)) {
    console.log("[2/3] Ingest marker exists, skipping ingestion.");
  } else {
    console.log("[2/3] Running ingest claude...");
    try {
      const transcriptFiles = findTranscriptFiles(CLAUDE_CODE_PROJECTS_DIR);
      if (transcriptFiles.length === 0) {
        console.log("      No Claude Code transcripts found. Skipping.");
      } else {
        const alreadyIngested = loadMarker(CLAUDE_CODE_MARKER);
        const newIngested = new Set<string>();
        let ingestedCount = 0;

        for (const transcriptFile of transcriptFiles) {
          const session = parseSession(transcriptFile);
          if (session === null) continue;
          writeSession(session, false);
          newIngested.add(transcriptFile);
          ingestedCount++;
        }

        if (newIngested.size > 0) {
          saveMarker(CLAUDE_CODE_MARKER, new Set([...alreadyIngested, ...newIngested]));
        }
        console.log(`      Ingested ${ingestedCount} sessions.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      Ingest failed: ${msg}`);
      console.log("      You can run `selftune ingest claude` manually to troubleshoot.");
    }
  }

  // Check if any telemetry was produced after ingest
  const db = getDb();
  let telemetry: SessionTelemetryRecord[];
  let skillRecords: SkillUsageRecord[];
  let queryRecords: QueryLogRecord[];
  try {
    telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
    skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
    queryRecords = queryQueryLog(db) as QueryLogRecord[];
  } catch {
    // If DB read fails, use empty arrays
    telemetry = [];
    skillRecords = [];
    queryRecords = [];
  }
  const hasSessions = telemetry.length > 0 || queryRecords.length > 0;
  const hasSkills = skillRecords.length > 0;

  if (!hasSessions) {
    console.log("      No sessions found. Checking for skills from hooks...");
    if (hasSkills) {
      const skillNames = [...new Set(skillRecords.map((r) => r.skill_name))].sort();
      console.log(`      Found ${skillNames.length} skill(s) from hooks: ${skillNames.join(", ")}`);
    } else {
      console.log("      No skills detected yet. Use your agent normally, then run");
      console.log("      `selftune status` to see health scores.");
    }
    console.log("");
  }

  // Step 3: Status
  console.log("[3/3] Current status:");
  console.log("");

  try {
    let auditEntries: EvolutionAuditEntry[];
    try {
      auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
    } catch {
      auditEntries = [];
    }
    const doctorResult = await doctor();

    const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
    const output = formatStatus(result);
    console.log(output);

    // Step 4: Suggest top 3 skills to evolve
    console.log("");
    suggestSkillsToEvolve(result.skills);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Status failed: ${msg}`);
    console.log("Run `selftune status` manually to troubleshoot.");
  }
}

// ---------------------------------------------------------------------------
// Suggest skills to evolve
// ---------------------------------------------------------------------------

function suggestSkillsToEvolve(skills: SkillStatus[]): void {
  if (skills.length === 0) {
    console.log("No skills found. Create skills and run sessions to get started.");
    return;
  }

  // Score each skill: prioritize highest trigger count with lowest pass rate or no data
  const scored: Array<{ name: string; score: number; reason: string }> = skills.map((s) => {
    let score = 0;
    let reason: string;
    const passRateLabel = s.passRate !== null ? `${Math.round(s.passRate * 100)}%` : "unknown";

    if (s.status === "UNGRADED" || s.status === "UNKNOWN") {
      score = 100; // Highest priority: needs grading
      reason = `needs grading — run \`selftune grade --skill ${s.name}\``;
    } else if (s.status === "CRITICAL") {
      score = 90;
      reason = `pass rate ${passRateLabel} — needs evolution`;
    } else if (s.status === "WARNING") {
      score = 70;
      reason = `pass rate ${passRateLabel} — could improve`;
    } else {
      score = 10;
      reason = "healthy";
    }

    return { name: s.name, score, reason };
  });

  // Sort by score descending, take top 3
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).filter((s) => s.score > 10);

  if (top.length === 0) {
    console.log("All skills are healthy. No immediate actions needed.");
    return;
  }

  console.log("Suggested next steps:");
  for (const suggestion of top) {
    console.log(`  - ${suggestion.name}: ${suggestion.reason}`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  // Check for --help
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`selftune quickstart — Guided onboarding

Usage:
  selftune quickstart

Steps:
  1. Runs init if ~/.selftune/config.json doesn't exist
  2. Runs ingest claude if session marker doesn't exist
  3. Shows current status
  4. Suggests top skills to evolve`);
    process.exit(0);
  }

  await quickstart();
}
