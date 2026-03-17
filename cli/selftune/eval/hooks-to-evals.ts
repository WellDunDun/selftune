#!/usr/bin/env bun
/**
 * hooks-to-evals.ts
 *
 * Converts hook logs into trigger eval sets compatible with run_eval / run_loop.
 *
 * Three input logs (all written automatically by hooks):
 *   ~/.claude/skill_usage_log.jsonl      - queries that DID trigger a skill
 *   ~/.claude/all_queries_log.jsonl      - ALL queries, triggered or not
 *   ~/.claude/session_telemetry_log.jsonl - per-session process metrics (Stop hook)
 *
 * For a given skill:
 *   Positives (should_trigger=true)  -> queries in skill_usage_log for that skill
 *   Negatives (should_trigger=false) -> queries in all_queries_log that never triggered
 *                                       that skill (cross-skill AND untriggered queries)
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GENERIC_NEGATIVES, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import { getDb } from "../localdb/db.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../localdb/queries.js";
import type {
  EvalEntry,
  InvocationType,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { detectAgent } from "../utils/llm-call.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../utils/query-filter.js";
import { seededShuffle } from "../utils/seeded-random.js";
import { isHighConfidencePositiveSkillRecord } from "../utils/skill-usage-confidence.js";
import { generateSyntheticEvals } from "./synthetic-evals.js";

// ---------------------------------------------------------------------------
// Query truncation
// ---------------------------------------------------------------------------

export const MAX_QUERY_LENGTH = 500;

function truncateQuery(query: string): string {
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
}

// ---------------------------------------------------------------------------
// Invocation taxonomy classifier
// ---------------------------------------------------------------------------

export function classifyInvocation(query: string, skillName: string): InvocationType {
  const qLower = query.toLowerCase();
  const skillLower = skillName.toLowerCase();

  // --- Explicit checks ---

  // Explicit: mentions skill name or $skill syntax
  if (
    qLower.includes(`$${skillLower}`) ||
    query.includes(`$${skillName}`) ||
    qLower.includes(skillLower)
  ) {
    return "explicit";
  }

  // Handle hyphenated skill names: check if all parts appear
  if (skillLower.includes("-")) {
    const parts = skillLower.split("-");
    if (parts.every((part) => qLower.includes(part))) {
      return "explicit";
    }
  }

  // Convert skill-name to camelCase and check
  const camelCase = skillLower.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (camelCase !== skillLower && qLower.includes(camelCase)) {
    return "explicit";
  }

  // --- Contextual checks ---

  const wordCount = query.split(/\s+/).length;
  const hasProperNoun = /\b[A-Z][a-z]{2,}\b/.test(query);

  // Temporal references suggest domain context
  const hasTemporalRef =
    /\b(next week|last week|tomorrow|yesterday|Q[1-4]|monday|tuesday|wednesday|thursday|friday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      query,
    );

  // Filenames suggest contextual usage
  const hasFilename = /\b\w+\.\w{2,4}\b/.test(query);

  // Email addresses suggest contextual usage
  const hasEmail = /\b\S+@\S+\.\S+\b/.test(query);

  if (wordCount > 15 || hasProperNoun || hasTemporalRef || hasFilename || hasEmail) {
    return "contextual";
  }

  // Borderline: 10-15 words with domain signals (multi-digit numbers, uppercase acronyms)
  const hasDomainSignal = /\b\d{2,}\b/.test(query) || /[A-Z]{2,}/.test(query);
  if (wordCount >= 10 && hasDomainSignal) {
    return "contextual";
  }

  return "implicit";
}

// ---------------------------------------------------------------------------
// Build eval set
// ---------------------------------------------------------------------------

export function buildEvalSet(
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  skillName: string,
  maxPerSide = 50,
  includeNegatives = true,
  seed = 42,
  annotateTaxonomy = true,
): EvalEntry[] {
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const effectiveMaxPerSide = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
  const effectiveSeed = Number.isNaN(seed) ? 42 : seed;

  // Build set of positive query texts (for exclusion from negatives)
  const positiveQueries = new Set<string>();
  for (const r of actionableSkillRecords) {
    if (!r || typeof r.skill_name !== "string" || typeof r.query !== "string") continue;
    if (isHighConfidencePositiveSkillRecord(r, skillName)) {
      const q = (r.query ?? "").trim();
      if (q && q !== "(query not found)") {
        positiveQueries.add(q);
      }
    }
  }

  // Build deduplicated positives with taxonomy classification
  const seen = new Set<string>();
  const positives: EvalEntry[] = [];
  for (const r of actionableSkillRecords) {
    if (!r || typeof r.skill_name !== "string" || typeof r.query !== "string") continue;
    if (!isHighConfidencePositiveSkillRecord(r, skillName)) continue;
    const q = (r.query ?? "").trim();
    if (!q || q === "(query not found)" || seen.has(q)) continue;
    seen.add(q);
    const entry: EvalEntry = { query: truncateQuery(q), should_trigger: true };
    if (annotateTaxonomy) {
      entry.invocation_type = classifyInvocation(q, skillName);
    }
    positives.push(entry);
  }

  const shuffledPositives = seededShuffle(positives, effectiveSeed).slice(0, effectiveMaxPerSide);

  let negatives: EvalEntry[] = [];
  if (includeNegatives) {
    const negCandidates: string[] = [];
    const negSeen = new Set<string>();
    for (const r of actionableQueryRecords) {
      if (!r || typeof r.query !== "string") continue;
      const q = (r.query ?? "").trim();
      if (!q || positiveQueries.has(q) || negSeen.has(q)) continue;
      negSeen.add(q);
      negCandidates.push(q);
    }

    const shuffledNeg = seededShuffle(negCandidates, effectiveSeed).slice(0, effectiveMaxPerSide);
    negatives = shuffledNeg.map((q) => {
      const entry: EvalEntry = { query: truncateQuery(q), should_trigger: false };
      if (annotateTaxonomy) {
        entry.invocation_type = "negative";
      }
      return entry;
    });

    // Pad with generic fallbacks if needed
    if (negatives.length < shuffledPositives.length) {
      const needed = shuffledPositives.length - negatives.length;
      const fallbacks: EvalEntry[] = [];
      for (const q of GENERIC_NEGATIVES) {
        if (negSeen.has(q) || positiveQueries.has(q)) continue;
        const entry: EvalEntry = { query: q, should_trigger: false };
        if (annotateTaxonomy) {
          entry.invocation_type = "negative";
        }
        fallbacks.push(entry);
      }
      negatives.push(...fallbacks.slice(0, needed));
    }
  }

  return [...shuffledPositives, ...negatives];
}

// ---------------------------------------------------------------------------
// List skills
// ---------------------------------------------------------------------------

export function listSkills(
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  telemetryRecords: SessionTelemetryRecord[],
): void {
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const counts = new Map<string, number>();
  for (const r of actionableSkillRecords) {
    const name = r.skill_name ?? "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  console.log(
    `Skill triggers in skill_usage_log (${actionableSkillRecords.length} actionable records):`,
  );
  if (counts.size > 0) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name.padEnd(30)}  ${String(count).padStart(4)} triggers`);
    }
  } else {
    console.log("  (none yet -- trigger some skills in Claude Code to populate)");
  }

  console.log(`\nActionable queries in all_queries_log: ${actionableQueryRecords.length}`);
  if (actionableQueryRecords.length === 0) {
    console.log("  (none yet -- make sure prompt_log_hook is installed)");
  }

  console.log(`\nSessions in session_telemetry_log: ${telemetryRecords.length}`);
  if (telemetryRecords.length === 0) {
    console.log("  (none yet -- make sure session_stop_hook is installed)");
  }
}

// ---------------------------------------------------------------------------
// Telemetry stats
// ---------------------------------------------------------------------------

export function showTelemetryStats(
  telemetryRecords: SessionTelemetryRecord[],
  skillName: string,
): void {
  const sessions = telemetryRecords.filter((r) => (r.skills_triggered ?? []).includes(skillName));

  if (sessions.length === 0) {
    console.log(`No telemetry sessions found for skill '${skillName}'.`);
    console.log("Make sure session_stop_hook is installed.");
    return;
  }

  console.log(`Process telemetry for skill '${skillName}' (${sessions.length} sessions):\n`);

  const allTools = new Map<string, number[]>();
  const allTurns: number[] = [];
  const allErrors: number[] = [];
  const allBashCounts: number[] = [];

  for (const s of sessions) {
    for (const [tool, count] of Object.entries(s.tool_calls ?? {})) {
      if (!allTools.has(tool)) allTools.set(tool, []);
      allTools.get(tool)?.push(count);
    }
    allTurns.push(s.assistant_turns ?? 0);
    allErrors.push(s.errors_encountered ?? 0);
    allBashCounts.push((s.bash_commands ?? []).length);
  }

  const avg = (lst: number[]) => (lst.length > 0 ? lst.reduce((a, b) => a + b, 0) / lst.length : 0);

  console.log(
    `  Assistant turns:   avg ${avg(allTurns).toFixed(1)}  (min ${Math.min(...allTurns)}, max ${Math.max(...allTurns)})`,
  );
  console.log(
    `  Errors:            avg ${avg(allErrors).toFixed(1)}  (min ${Math.min(...allErrors)}, max ${Math.max(...allErrors)})`,
  );
  console.log(`  Bash commands:     avg ${avg(allBashCounts).toFixed(1)}`);
  console.log();
  console.log("  Tool call averages:");

  const sortedTools = [...allTools.entries()].sort((a, b) => avg(b[1]) - avg(a[1]));
  for (const [tool, counts] of sortedTools) {
    console.log(`    ${tool.padEnd(20)} avg ${avg(counts).toFixed(1)}`);
  }

  // Flag high-error sessions
  const highError = sessions.filter((s) => (s.errors_encountered ?? 0) > 2);
  if (highError.length > 0) {
    console.log(
      `\n  WARNING: ${highError.length} session(s) had >2 errors -- inspect transcripts:`,
    );
    for (const s of highError) {
      console.log(
        `    session ${s.session_id.slice(0, 12)}... -- ${s.errors_encountered} errors, transcript: ${s.transcript_path ?? "?"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Print eval stats
// ---------------------------------------------------------------------------

export function printEvalStats(
  evalSet: EvalEntry[],
  skillName: string,
  outputPath: string,
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  annotateTaxonomy: boolean,
): void {
  const pos = evalSet.filter((e) => e.should_trigger);
  const neg = evalSet.filter((e) => !e.should_trigger);
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const totalTriggers = actionableSkillRecords.filter((r) => r.skill_name === skillName).length;

  console.log(`Wrote ${evalSet.length} eval entries to ${outputPath}`);
  console.log(
    `  Positives (should_trigger=true) : ${pos.length}  (from ${totalTriggers} logged triggers)`,
  );
  console.log(
    `  Negatives (should_trigger=false): ${neg.length}  (from ${actionableQueryRecords.length} actionable logged queries)`,
  );

  if (annotateTaxonomy && pos.length > 0) {
    const types = new Map<string, number>();
    for (const e of pos) {
      const t = e.invocation_type ?? "?";
      types.set(t, (types.get(t) ?? 0) + 1);
    }
    console.log("\n  Positive invocation types:");
    for (const [t, c] of [...types.entries()].sort()) {
      console.log(`    ${t.padEnd(15)}  ${c}`);
    }
    if (!types.has("explicit")) {
      console.log("\n  [TIP] No explicit positives (queries naming the skill directly).");
      console.log("        Consider adding some for a complete taxonomy.");
    }
    if (!types.has("contextual")) {
      console.log("\n  [TIP] No contextual positives (implicit + domain noise).");
      console.log("        These are important for realistic triggering tests.");
    }
  }

  console.log();
  if (pos.length === 0) {
    console.log(`[WARN] No positives for skill '${skillName}'.`);
    const names = [...new Set(actionableSkillRecords.map((r) => r.skill_name))].sort();
    if (names.length > 0) {
      console.log(`       Known skills: ${names.join(", ")}`);
    }
  }
  if (neg.length === 0) {
    console.log("[WARN] No negatives -- install prompt_log_hook for real negatives.");
  }

  console.log("Next steps:");
  console.log("  bun run cli/selftune/eval/run-eval.ts \\");
  console.log(`    --eval-set ${outputPath} \\`);
  console.log(`    --skill-path /path/to/skills/${skillName} \\`);
  console.log("    --runs-per-query 3 --verbose");
  console.log();
  console.log("  bun run cli/selftune/eval/run-loop.ts \\");
  console.log(`    --eval-set ${outputPath} \\`);
  console.log(`    --skill-path /path/to/skills/${skillName} \\`);
  console.log("    --max-iterations 5 --verbose");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      output: { type: "string" },
      out: { type: "string" },
      max: { type: "string", default: "50" },
      seed: { type: "string", default: "42" },
      "list-skills": { type: "boolean", default: false },
      stats: { type: "boolean", default: false },
      "no-negatives": { type: "boolean", default: false },
      "no-taxonomy": { type: "boolean", default: false },
      "skill-log": { type: "string", default: SKILL_LOG },
      "query-log": { type: "string", default: QUERY_LOG },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      synthetic: { type: "boolean", default: false },
      "skill-path": { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });

  // --- Synthetic mode: generate evals from SKILL.md via LLM ---
  if (values.synthetic) {
    if (!values.skill) {
      console.error("[ERROR] --skill required with --synthetic");
      process.exit(1);
    }
    if (!values["skill-path"]) {
      console.error("[ERROR] --skill-path required with --synthetic");
      process.exit(1);
    }

    const agent = detectAgent();
    if (!agent) {
      console.error("[ERROR] No agent CLI found (claude/codex/opencode). Install one first.");
      process.exit(1);
    }

    const maxPerSide = Number.parseInt(values.max ?? "50", 10);
    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;

    console.log(`Generating synthetic evals for skill '${values.skill}'...`);
    const evalSet = await generateSyntheticEvals(values["skill-path"], values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
    });

    const outputPath = values.output ?? values.out ?? `${values.skill}_trigger_eval.json`;
    writeFileSync(outputPath, JSON.stringify(evalSet, null, 2), "utf-8");

    const pos = evalSet.filter((e) => e.should_trigger);
    const neg = evalSet.filter((e) => !e.should_trigger);

    console.log(`Wrote ${evalSet.length} synthetic eval entries to ${outputPath}`);
    console.log(`  Positives (should_trigger=true) : ${pos.length}`);
    console.log(`  Negatives (should_trigger=false): ${neg.length}`);

    if (pos.length > 0) {
      const types = new Map<string, number>();
      for (const e of pos) {
        const t = e.invocation_type ?? "?";
        types.set(t, (types.get(t) ?? 0) + 1);
      }
      console.log("\n  Positive invocation types:");
      for (const [t, c] of [...types.entries()].sort()) {
        console.log(`    ${t.padEnd(15)}  ${c}`);
      }
    }

    console.log("\nNext steps:");
    console.log("  bun run cli/selftune/eval/run-eval.ts \\");
    console.log(`    --eval-set ${outputPath} \\`);
    console.log(`    --skill-path ${values["skill-path"]} \\`);
    console.log("    --runs-per-query 3 --verbose");
    return;
  }

  // --- Log-based mode (original behavior) ---
  const skillLogPath = values["skill-log"] ?? SKILL_LOG;
  const queryLogPath = values["query-log"] ?? QUERY_LOG;
  const telemetryLogPath = values["telemetry-log"] ?? TELEMETRY_LOG;

  let skillRecords: SkillUsageRecord[];
  let queryRecords: QueryLogRecord[];
  let telemetryRecords: SessionTelemetryRecord[];

  if (
    skillLogPath === SKILL_LOG &&
    queryLogPath === QUERY_LOG &&
    telemetryLogPath === TELEMETRY_LOG
  ) {
    const db = getDb();
    skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
    queryRecords = queryQueryLog(db) as QueryLogRecord[];
    telemetryRecords = querySessionTelemetry(db) as SessionTelemetryRecord[];
  } else {
    skillRecords = readJsonl<SkillUsageRecord>(skillLogPath);
    queryRecords = readJsonl<QueryLogRecord>(queryLogPath);
    telemetryRecords = readJsonl<SessionTelemetryRecord>(telemetryLogPath);
  }

  if (values["list-skills"]) {
    listSkills(skillRecords, queryRecords, telemetryRecords);
    process.exit(0);
  }

  if (!values.skill) {
    console.error("[ERROR] --skill required (or use --list-skills)");
    process.exit(1);
  }

  if (values.stats) {
    showTelemetryStats(telemetryRecords, values.skill);
    process.exit(0);
  }

  const maxPerSide = Number.parseInt(values.max ?? "50", 10);
  const seed = Number.parseInt(values.seed ?? "42", 10);
  const annotateTaxonomy = !values["no-taxonomy"];

  const evalSet = buildEvalSet(
    skillRecords,
    queryRecords,
    values.skill,
    maxPerSide,
    !values["no-negatives"],
    seed,
    annotateTaxonomy,
  );

  const outputPath = values.output ?? values.out ?? `${values.skill}_trigger_eval.json`;
  writeFileSync(outputPath, JSON.stringify(evalSet, null, 2), "utf-8");
  printEvalStats(evalSet, values.skill, outputPath, skillRecords, queryRecords, annotateTaxonomy);
}

if (import.meta.main) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
