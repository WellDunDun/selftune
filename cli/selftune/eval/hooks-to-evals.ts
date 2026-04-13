#!/usr/bin/env bun
/**
 * hooks-to-evals.ts
 *
 * Converts hook logs into trigger eval sets compatible with the current
 * eval-generate -> evolve --dry-run validation loop.
 *
 * Default read path is SQLite (via localdb/queries). JSONL fallback is used only
 * when custom --skill-log / --query-log / --telemetry-log paths are supplied
 * (test/custom-path override).
 *
 * Three underlying log sources (all written automatically by hooks):
 *   skill_usage     - queries that DID trigger a skill
 *   query_log       - ALL queries, triggered or not
 *   session_telemetry - per-session process metrics (Stop hook)
 *
 * For a given skill:
 *   Positives (should_trigger=true)  -> queries in skill_usage for that skill
 *   Negatives (should_trigger=false) -> queries in query_log that never triggered
 *                                       that skill (cross-skill AND untriggered queries)
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { GENERIC_NEGATIVES, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import { getDb } from "../localdb/db.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../localdb/queries.js";
import type {
  EvalEntry,
  EvalSourceStats,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { detectLlmAgent } from "../utils/llm-call.js";
import {
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../utils/query-filter.js";
import { seededShuffle } from "../utils/seeded-random.js";
import {
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";
import { isHighConfidencePositiveSkillRecord } from "../utils/skill-usage-confidence.js";
import { readJsonl } from "../utils/jsonl.js";
import { classifyInvocation } from "./invocation-classifier.js";
import { generateSyntheticEvals } from "./synthetic-evals.js";
import { writeCanonicalEvalSet } from "../testing-readiness.js";

export { classifyInvocation } from "./invocation-classifier.js";

// ---------------------------------------------------------------------------
// Query truncation
// ---------------------------------------------------------------------------

export const MAX_QUERY_LENGTH = 500;

function truncateQuery(query: string): string {
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
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
  const buildTimestamp = new Date().toISOString();

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
    const entry: EvalEntry = {
      query: truncateQuery(q),
      should_trigger: true,
      source: "log",
      created_at: buildTimestamp,
    };
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
      const entry: EvalEntry = {
        query: truncateQuery(q),
        should_trigger: false,
        source: "log",
        created_at: buildTimestamp,
      };
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
        const entry: EvalEntry = {
          query: q,
          should_trigger: false,
          source: "log",
          created_at: buildTimestamp,
        };
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
// Normalized Levenshtein distance
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use two-row optimization to keep memory O(min(la, lb))
  let prev = Array.from<number>({ length: lb + 1 });
  let curr = Array.from<number>({ length: lb + 1 });

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

function normalizedLevenshtein(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshteinDistance(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Blend eval sets (log + synthetic)
// ---------------------------------------------------------------------------

/**
 * Blend log-based and synthetic eval entries.
 *
 * Policy:
 *   - Keep ALL log-based entries (source: "log")
 *   - Add synthetic entries that cover gaps (boundary cases, underrepresented types)
 *   - Deduplicate: drop synthetic if normalizedLevenshtein(synthetic, anyLog) < 0.3
 *   - Mark surviving synthetic entries as source: "blended"
 *   - Cap total at 2x the log-based count
 */
export function blendEvalSets(logEntries: EvalEntry[], syntheticEntries: EvalEntry[]): EvalEntry[] {
  const result: EvalEntry[] = [...logEntries];
  const logCount = logEntries.length;
  const cap = logCount * 2;

  if (logCount === 0 || syntheticEntries.length === 0) {
    return result.slice(0, cap);
  }

  // Normalize log queries for comparison
  const logQueries = logEntries.map((e) => e.query.toLowerCase().trim());

  // Filter synthetic entries: drop those too similar to any log entry
  const candidates: EvalEntry[] = [];
  for (const synth of syntheticEntries) {
    const synthNorm = synth.query.toLowerCase().trim();
    let tooSimilar = false;
    for (const logQ of logQueries) {
      // Length pre-filter: skip Levenshtein if lengths differ by >70%
      const maxLen = Math.max(synthNorm.length, logQ.length);
      if (maxLen > 0 && Math.abs(synthNorm.length - logQ.length) / maxLen > 0.7) continue;
      if (normalizedLevenshtein(synthNorm, logQ) < 0.3) {
        tooSimilar = true;
        break;
      }
    }
    if (!tooSimilar) {
      candidates.push({ ...synth, source: "blended" });
    }
  }

  // Add candidates up to the cap
  const slotsAvailable = cap - result.length;
  result.push(...candidates.slice(0, slotsAvailable));

  return result;
}

// ---------------------------------------------------------------------------
// Eval source stats
// ---------------------------------------------------------------------------

export function computeEvalSourceStats(entries: EvalEntry[]): EvalSourceStats {
  const stats: EvalSourceStats = { total: entries.length, synthetic: 0, log: 0, blended: 0 };
  const timestamps: string[] = [];

  for (const entry of entries) {
    if (entry.source === "synthetic") stats.synthetic++;
    else if (entry.source === "log") stats.log++;
    else if (entry.source === "blended") stats.blended++;
    if (entry.created_at) timestamps.push(entry.created_at);
  }

  if (timestamps.length > 0) {
    timestamps.sort();
    stats.oldest = timestamps[0];
    stats.newest = timestamps[timestamps.length - 1];
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Installed skill discovery / readiness
// ---------------------------------------------------------------------------

export interface EvalSkillReadiness {
  name: string;
  trusted_trigger_count: number;
  raw_trigger_count: number;
  trusted_session_count: number;
  raw_session_count: number;
  installed: boolean;
  skill_path?: string;
  readiness: "log_ready" | "cold_start_ready" | "telemetry_only";
}

function getEvalSkillSearchDirs(): string[] {
  const cwd = process.cwd();
  const homeDir = process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME ?? `${homeDir}/.codex`;
  return [
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
    `${homeDir}/.agents/skills`,
    `${homeDir}/.claude/skills`,
    `${codexHome}/skills`,
  ];
}

export function listEvalSkillReadiness(
  skillRecords: SkillUsageRecord[],
  searchDirs: string[] = getEvalSkillSearchDirs(),
): EvalSkillReadiness[] {
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const rawTriggerCounts = new Map<string, number>();
  const rawSessionCounts = new Map<string, Set<string>>();
  const trustedTriggerCounts = new Map<string, number>();
  const trustedSessionCounts = new Map<string, Set<string>>();
  for (const r of actionableSkillRecords) {
    const name = r.skill_name ?? "unknown";
    rawTriggerCounts.set(name, (rawTriggerCounts.get(name) ?? 0) + 1);
    if (!rawSessionCounts.has(name)) rawSessionCounts.set(name, new Set<string>());
    if (r.session_id) rawSessionCounts.get(name)?.add(r.session_id);

    if (!isHighConfidencePositiveSkillRecord(r, name)) continue;
    trustedTriggerCounts.set(name, (trustedTriggerCounts.get(name) ?? 0) + 1);
    if (!trustedSessionCounts.has(name)) trustedSessionCounts.set(name, new Set<string>());
    if (r.session_id) trustedSessionCounts.get(name)?.add(r.session_id);
  }

  const installedNames = findInstalledSkillNames(searchDirs);
  const allNames = new Set<string>([...rawTriggerCounts.keys(), ...installedNames]);

  return [...allNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const trustedTriggerCount = trustedTriggerCounts.get(name) ?? 0;
      const rawTriggerCount = rawTriggerCounts.get(name) ?? 0;
      const installed = installedNames.has(name);
      return {
        name,
        trusted_trigger_count: trustedTriggerCount,
        raw_trigger_count: rawTriggerCount,
        trusted_session_count: trustedSessionCounts.get(name)?.size ?? 0,
        raw_session_count: rawSessionCounts.get(name)?.size ?? 0,
        installed,
        skill_path: installed ? findInstalledSkillPath(name, searchDirs) : undefined,
        readiness:
          trustedTriggerCount > 0 ? "log_ready" : installed ? "cold_start_ready" : "telemetry_only",
      } satisfies EvalSkillReadiness;
    });
}

// ---------------------------------------------------------------------------
// List skills
// ---------------------------------------------------------------------------

export function listSkills(
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  telemetryRecords: SessionTelemetryRecord[],
): void {
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const readiness = listEvalSkillReadiness(skillRecords);

  console.log(`Skills with eval readiness (${readiness.length} total):`);
  if (readiness.length > 0) {
    for (const skill of readiness) {
      const readinessLabel =
        skill.readiness === "log_ready"
          ? "log-ready"
          : skill.readiness === "cold_start_ready"
            ? "cold-start"
            : "telemetry-only";
      const installLabel = skill.installed ? "installed" : "not installed";
      const trustedLabel = `${String(skill.trusted_trigger_count).padStart(3)} trusted`;
      const rawLabel =
        skill.raw_trigger_count !== skill.trusted_trigger_count
          ? ` / ${String(skill.raw_trigger_count).padStart(3)} raw`
          : "";
      console.log(
        `  ${skill.name.padEnd(30)}  ${trustedLabel}${rawLabel}  ${String(skill.trusted_session_count).padStart(3)} trusted sessions  ${readinessLabel} / ${installLabel}`,
      );
    }
    console.log("");
    console.log("Legend:");
    console.log("  log-ready    real triggers exist; run eval generate normally");
    console.log(
      "  cold-start   installed locally but no trusted triggers yet; use --auto-synthetic",
    );
    console.log("  telemetry-only  trigger data exists but local SKILL.md was not found");
  } else {
    console.log("  (none yet -- install skills or sync source data first)");
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
  console.log(`  selftune evolve --skill ${skillName} \\`);
  console.log(`    --skill-path /path/to/skills/${skillName}/SKILL.md \\`);
  console.log(`    --eval-set ${outputPath} \\`);
  console.log("    --dry-run --verbose");
  console.log();
  console.log(`  selftune evolve --skill ${skillName} \\`);
  console.log(`    --skill-path /path/to/skills/${skillName}/SKILL.md \\`);
  console.log(`    --eval-set ${outputPath}`);
}

function printSyntheticFallbackHint(skillName: string, skillPath: string): void {
  console.log("");
  console.log(`[TIP] No trusted trigger data found yet for '${skillName}'.`);
  console.log(
    "      This skill is installed locally, so you can still generate a cold-start eval set:",
  );
  console.log(
    `      selftune eval generate --skill ${skillName} --auto-synthetic --skill-path ${skillPath}`,
  );
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
      "auto-synthetic": { type: "boolean", default: false },
      blend: { type: "boolean", default: false },
      "skill-path": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.evalGenerate));
    process.exit(0);
  }

  // --- Synthetic mode: generate evals from SKILL.md via LLM ---
  if (values.synthetic) {
    if (!values.skill) {
      throw new CLIError(
        "--skill required with --synthetic",
        "MISSING_FLAG",
        "selftune eval generate --synthetic --skill <name> --skill-path <path>",
      );
    }
    if (!values["skill-path"]) {
      throw new CLIError(
        "--skill-path required with --synthetic",
        "MISSING_FLAG",
        "selftune eval generate --synthetic --skill <name> --skill-path <path>",
      );
    }

    const agent = detectLlmAgent();
    if (!agent) {
      throw new CLIError(
        "No agent CLI found (claude/codex/opencode/pi)",
        "AGENT_NOT_FOUND",
        "Install one of the supported agent CLIs",
      );
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
    const canonicalPath = writeCanonicalEvalSet(values.skill, evalSet);

    const pos = evalSet.filter((e) => e.should_trigger);
    const neg = evalSet.filter((e) => !e.should_trigger);

    console.log(`Wrote ${evalSet.length} synthetic eval entries to ${outputPath}`);
    console.log(`Canonical eval copy: ${canonicalPath}`);
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
    console.log(`  selftune evolve --skill ${values.skill} \\`);
    console.log(`    --skill-path ${values["skill-path"]} \\`);
    console.log(`    --eval-set ${outputPath} \\`);
    console.log("    --dry-run --verbose");
    return;
  }

  // --- SQLite-based mode ---
  let skillRecords: SkillUsageRecord[];
  let queryRecords: QueryLogRecord[];
  let telemetryRecords: SessionTelemetryRecord[];

  const skillLogPath = values["skill-log"] ?? SKILL_LOG;
  const queryLogPath = values["query-log"] ?? QUERY_LOG;
  const telemetryLogPath = values["telemetry-log"] ?? TELEMETRY_LOG;
  const hasCustomSkillLog = skillLogPath !== SKILL_LOG;
  const hasCustomQueryLog = queryLogPath !== QUERY_LOG;
  const hasCustomTelemetryLog = telemetryLogPath !== TELEMETRY_LOG;

  const db = hasCustomSkillLog && hasCustomQueryLog && hasCustomTelemetryLog ? undefined : getDb();
  skillRecords = hasCustomSkillLog
    ? readJsonl<SkillUsageRecord>(skillLogPath)
    : (querySkillUsageRecords(db!) as SkillUsageRecord[]);
  queryRecords = hasCustomQueryLog
    ? readJsonl<QueryLogRecord>(queryLogPath)
    : (queryQueryLog(db!) as QueryLogRecord[]);
  telemetryRecords = hasCustomTelemetryLog
    ? readJsonl<SessionTelemetryRecord>(telemetryLogPath)
    : (querySessionTelemetry(db!) as SessionTelemetryRecord[]);

  if (values["list-skills"]) {
    listSkills(skillRecords, queryRecords, telemetryRecords);
    process.exit(0);
  }

  if (!values.skill) {
    throw new CLIError(
      "--skill required (or use --list-skills)",
      "MISSING_FLAG",
      "selftune eval generate --skill <name> or selftune eval generate --list-skills",
    );
  }

  if (values.stats) {
    showTelemetryStats(telemetryRecords, values.skill);
    process.exit(0);
  }

  const maxPerSide = Number.parseInt(values.max ?? "50", 10);
  const seed = Number.parseInt(values.seed ?? "42", 10);
  const annotateTaxonomy = !values["no-taxonomy"];
  const searchDirs = getEvalSkillSearchDirs();
  const detectedSkillPath = findInstalledSkillPath(values.skill, searchDirs);

  const evalSet = buildEvalSet(
    skillRecords,
    queryRecords,
    values.skill,
    maxPerSide,
    !values["no-negatives"],
    seed,
    annotateTaxonomy,
  );

  const positiveCount = evalSet.filter((entry) => entry.should_trigger).length;
  if (positiveCount === 0 && values["auto-synthetic"]) {
    const skillPath = values["skill-path"] ?? detectedSkillPath;
    if (!skillPath) {
      throw new CLIError(
        `No trusted triggers found for '${values.skill}', and no SKILL.md path could be resolved for synthetic fallback.`,
        "FILE_NOT_FOUND",
        `Run 'selftune eval generate --list-skills' or rerun with --skill-path /path/to/SKILL.md`,
      );
    }

    const agent = detectLlmAgent();
    if (!agent) {
      throw new CLIError(
        "No agent CLI found (claude/codex/opencode/pi)",
        "AGENT_NOT_FOUND",
        "Install one of the supported agent CLIs",
      );
    }

    console.log(
      `No trusted triggers found for '${values.skill}'. Falling back to synthetic cold-start eval generation...`,
    );
    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
    const syntheticEvalSet = await generateSyntheticEvals(skillPath, values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
    });
    const outputPath = values.output ?? values.out ?? `${values.skill}_trigger_eval.json`;
    writeFileSync(outputPath, JSON.stringify(syntheticEvalSet, null, 2), "utf-8");
    const canonicalPath = writeCanonicalEvalSet(values.skill, syntheticEvalSet);
    const pos = syntheticEvalSet.filter((e) => e.should_trigger);
    const neg = syntheticEvalSet.filter((e) => !e.should_trigger);

    console.log(`Wrote ${syntheticEvalSet.length} synthetic eval entries to ${outputPath}`);
    console.log(`Canonical eval copy: ${canonicalPath}`);
    console.log(`  Positives (should_trigger=true) : ${pos.length}`);
    console.log(`  Negatives (should_trigger=false): ${neg.length}`);
    console.log("\nNext steps:");
    console.log(`  selftune evolve --skill ${values.skill} \\`);
    console.log(`    --skill-path ${skillPath} \\`);
    console.log(`    --eval-set ${outputPath} \\`);
    console.log("    --dry-run --verbose");
    return;
  }

  // --- Blend mode: merge log-based evals with synthetic gap-fillers ---
  let finalEvalSet = evalSet;
  if (values.blend) {
    const skillPath = values["skill-path"] ?? detectedSkillPath;
    if (!skillPath) {
      throw new CLIError(
        `--blend requires a resolvable SKILL.md path. Use --skill-path or install the skill locally.`,
        "MISSING_FLAG",
        `selftune eval generate --skill ${values.skill} --blend --skill-path /path/to/SKILL.md`,
      );
    }

    const agent = detectLlmAgent();
    if (!agent) {
      throw new CLIError(
        "No agent CLI found (claude/codex/opencode/pi)",
        "AGENT_NOT_FOUND",
        "Install one of the supported agent CLIs",
      );
    }

    // Fail fast before expensive LLM calls — blending with zero logs always produces []
    if (evalSet.length === 0) {
      throw new CLIError(
        `--blend requires log-based eval entries to blend with synthetic entries. No log data found for skill "${values.skill}".`,
        "BLEND_NO_LOGS",
        `Use --synthetic instead for cold-start skills, or run selftune sync first to ingest session data.`,
      );
    }

    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
    console.log(`Generating synthetic evals for blending with '${values.skill}'...`);
    const syntheticEvalSet = await generateSyntheticEvals(skillPath, values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
    });

    finalEvalSet = blendEvalSets(evalSet, syntheticEvalSet);
    const stats = computeEvalSourceStats(finalEvalSet);
    console.log(
      `Blended: ${stats.log} log + ${stats.blended} synthetic gap-fillers = ${stats.total} total`,
    );
  }

  const outputPath = values.output ?? values.out ?? `${values.skill}_trigger_eval.json`;
  writeFileSync(outputPath, JSON.stringify(finalEvalSet, null, 2), "utf-8");
  const canonicalPath = writeCanonicalEvalSet(values.skill, finalEvalSet);
  printEvalStats(
    finalEvalSet,
    values.skill,
    outputPath,
    skillRecords,
    queryRecords,
    annotateTaxonomy,
  );
  console.log(`Canonical eval copy: ${canonicalPath}`);
  if (positiveCount === 0 && detectedSkillPath) {
    printSyntheticFallbackHint(values.skill, detectedSkillPath);
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
