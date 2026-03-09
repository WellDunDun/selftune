/**
 * selftune quickstart — Guided onboarding that runs init, replay, and status.
 *
 * Steps:
 *  1. Run `init` if config doesn't exist
 *  2. Run `replay` if marker file doesn't exist
 *  3. Run `status` to display current state
 *  4. Suggest top 3 skills to evolve
 */

import { existsSync } from "node:fs";

import {
  CLAUDE_CODE_MARKER,
  CLAUDE_CODE_PROJECTS_DIR,
  EVOLUTION_AUDIT_LOG,
  QUERY_LOG,
  SELFTUNE_CONFIG_DIR,
  SELFTUNE_CONFIG_PATH,
  SKILL_LOG,
  TELEMETRY_LOG,
} from "./constants.js";
import { runInit } from "./init.js";
import {
  findTranscriptFiles,
  parseSession,
  writeSession,
} from "./ingestors/claude-replay.js";
import { doctor } from "./observability.js";
import { computeStatus, formatStatus } from "./status.js";
import type { SkillStatus } from "./status.js";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { loadMarker, readJsonl, saveMarker } from "./utils/jsonl.js";

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
      console.log("      You can run \`selftune init\` manually to troubleshoot.");
    }
  }

  // Step 2: Replay if marker doesn't exist
  if (existsSync(CLAUDE_CODE_MARKER)) {
    console.log("[2/3] Replay marker exists, skipping replay.");
  } else {
    console.log("[2/3] Running replay...");
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
      console.error(`      Replay failed: ${msg}`);
      console.log("      You can run \`selftune replay\` manually to troubleshoot.");
    }
  }

  // Step 3: Status
  console.log("[3/3] Current status:");
  console.log("");

  try {
    const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
    const skillRecords = readJsonl<SkillUsageRecord>(SKILL_LOG);
    const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
    const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);
    const doctorResult = doctor();

    const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
    const output = formatStatus(result);
    console.log(output);

    // Step 4: Suggest top 3 skills to evolve
    console.log("");
    suggestSkillsToEvolve(result.skills);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Status failed: ${msg}`);
    console.log("Run \`selftune status\` manually to troubleshoot.");
  }
}

// ---------------------------------------------------------------------------
// Suggest skills to evolve
// ---------------------------------------------------------------------------

function suggestSkillsToEvolve(
  skills: SkillStatus[],
): void {
  if (skills.length === 0) {
    console.log("No skills found. Create skills and run sessions to get started.");
    return;
  }

  // Score each skill: prioritize highest trigger count with lowest pass rate or no data
  const scored: Array<{ name: string; score: number; reason: string }> = skills.map((s) => {
    let score = 0;
    let reason: string;

    if (s.status === "UNGRADED" || s.status === "UNKNOWN") {
      score = 100; // Highest priority: needs grading
      reason = "needs grading — run `selftune grade --skill " + s.name + "`";
    } else if (s.status === "CRITICAL") {
      score = 90;
      reason = `pass rate ${s.passRate !== null ? Math.round(s.passRate * 100) + "%" : "unknown"} — needs evolution`;
    } else if (s.status === "WARNING") {
      score = 70;
      reason = `pass rate ${s.passRate !== null ? Math.round(s.passRate * 100) + "%" : "unknown"} — could improve`;
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
  2. Runs replay if session marker doesn't exist
  3. Shows current status
  4. Suggests top skills to evolve`);
    process.exit(0);
  }

  await quickstart();
}
