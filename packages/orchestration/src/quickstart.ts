/* oxlint-disable no-console, no-array-sort -- legacy CLI output and stable ordering */
/**
 * selftune quickstart — Guided onboarding that runs init, ingest, and status.
 *
 * Steps:
 *  1. Run `init` if config doesn't exist
 *  2. Sync new or appended Claude transcripts
 *  3. Run `status` to display current state
 *  4. Suggest top 3 skills to evolve
 */

import { existsSync } from "node:fs";

import {
  CLAUDE_CODE_MARKER,
  CLAUDE_CODE_PROJECTS_DIR,
  SELFTUNE_CONFIG_DIR,
  SELFTUNE_CONFIG_PATH,
} from "@selftune/runtime/constants";
import {
  findTranscriptFiles,
  parseSession,
  writeSession,
} from "@selftune/harness-claude-code/ingestors/claude-replay";
import { getDb } from "@selftune/local-store";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "@selftune/runtime/localdb/queries";
import { doctor } from "@selftune/runtime/observability";
import { NORMALIZER_VERSION } from "@selftune/runtime/normalization";
import { readAuditTrail } from "@selftune/runtime/evolution/audit";
import type { SkillStatus } from "@selftune/runtime/status";
import { computeStatus, formatStatus } from "@selftune/runtime/status";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import {
  fingerprintIngestionFile,
  isFileIngestionCurrent,
  loadFileIngestionMarker,
  saveFileIngestionMarker,
} from "@selftune/runtime/utils/jsonl";

import { runInit } from "./init.js";

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

  // Step 2: Sync new and appended transcripts.
  console.log("[2/3] Syncing Claude Code transcripts...");
  try {
    const transcriptFiles = findTranscriptFiles(CLAUDE_CODE_PROJECTS_DIR);
    if (transcriptFiles.length === 0) {
      console.log("      No Claude Code transcripts found. Skipping.");
    } else {
      const marker = loadFileIngestionMarker(CLAUDE_CODE_MARKER);
      const pending = transcriptFiles
        .map((path) => ({
          path,
          fingerprint: fingerprintIngestionFile(path, NORMALIZER_VERSION),
        }))
        .filter(({ path, fingerprint }) => !isFileIngestionCurrent(marker, path, fingerprint));
      let ingestedCount = 0;
      let markerChanged = false;

      for (const { path: transcriptFile, fingerprint } of pending) {
        const session = parseSession(transcriptFile);
        if (session === null) {
          marker.set(transcriptFile, fingerprint);
          markerChanged = true;
          continue;
        }
        writeSession(session, false);
        marker.set(transcriptFile, fingerprint);
        markerChanged = true;
        ingestedCount++;
      }

      if (markerChanged) {
        saveFileIngestionMarker(CLAUDE_CODE_MARKER, marker);
      }
      console.log(`      Ingested ${ingestedCount} changed sessions.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`      Ingest failed: ${msg}`);
    console.log("      You can run `selftune ingest claude` manually to troubleshoot.");
  }

  // Check if any telemetry was produced after ingest
  const db = getDb();
  let telemetry: SessionTelemetryRecord[];
  let skillRecords: SkillUsageRecord[];
  let queryRecords: QueryLogRecord[];
  try {
    telemetry = querySessionTelemetry(db);
    skillRecords = querySkillUsageRecords(db);
    queryRecords = queryQueryLog(db);
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
      auditEntries = readAuditTrail();
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
