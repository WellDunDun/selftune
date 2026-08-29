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

import { GENERIC_NEGATIVES, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "../constants.js";
import {
  createDashboardLlmObserver,
  emitDashboardStepProgress,
} from "../dashboard-action-instrumentation.js";
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
import { CLIError } from "../utils/cli-error.js";
import { MIN_LOG_READY_POSITIVES } from "../utils/eval-readiness.js";
import { detectLlmAgent, isLlmBackedAgent } from "../utils/llm-call.js";
import {
  extractPositiveEvalQueryText,
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../utils/query-filter.js";
import { seededShuffle } from "../utils/seeded-random.js";
import { findInstalledSkillPath } from "../utils/skill-discovery.js";
import { isHighConfidencePositiveSkillRecord } from "../utils/skill-usage-confidence.js";
import { readJsonl } from "../utils/jsonl.js";
import { classifyInvocation } from "./invocation-classifier.js";
import { generateSyntheticEvals } from "./synthetic-evals.js";
import { getPackageEvalSetPath, writeCanonicalEvalSet } from "../testing-readiness.js";
import type { EvalGenerateInput } from "./cli-contract.js";
import {
  getEvalSkillSearchDirs,
  listSkills,
  printEvalStats,
  printSyntheticFallbackHint,
  showTelemetryStats,
} from "./eval-reporting.js";

export { classifyInvocation } from "./invocation-classifier.js";
export { listEvalSkillReadiness } from "./eval-reporting.js";

function resolveEvalGenerateAgent(requestedAgent?: string | null): string {
  if (requestedAgent) {
    if (!isLlmBackedAgent(requestedAgent)) {
      throw new CLIError(
        `Unsupported --agent value "${requestedAgent}".`,
        "INVALID_FLAG",
        "Use claude, codex, opencode, or pi.",
      );
    }
    if (!Bun.which(requestedAgent)) {
      throw new CLIError(
        `Agent CLI '${requestedAgent}' not found in PATH`,
        "AGENT_NOT_FOUND",
        "Install it or omit --agent to use auto-detection",
      );
    }
    return requestedAgent;
  }

  const detected = detectLlmAgent();
  if (!detected) {
    throw new CLIError(
      "No agent CLI found (claude/codex/opencode/pi)",
      "AGENT_NOT_FOUND",
      "Install one of the supported agent CLIs",
    );
  }
  return detected;
}

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
  const actionableQueryRecords = includeNegatives ? filterActionableQueryRecords(queryRecords) : [];
  const effectiveMaxPerSide = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
  const effectiveSeed = Number.isNaN(seed) ? 42 : seed;
  const buildTimestamp = new Date().toISOString();

  // Build set of positive query texts (for exclusion from negatives)
  const positiveQueries = new Set<string>();
  for (const r of actionableSkillRecords) {
    if (!r || typeof r.skill_name !== "string" || typeof r.query !== "string") continue;
    if (isHighConfidencePositiveSkillRecord(r, skillName)) {
      const q = extractPositiveEvalQueryText(r.query, skillName);
      if (q) {
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
    const q = extractPositiveEvalQueryText(r.query, skillName);
    if (!q || seen.has(q)) continue;
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
// CLI entry point
// ---------------------------------------------------------------------------

export async function runEvalGenerate(input: EvalGenerateInput): Promise<void> {
  const max = Number(input.max);
  if (!/^[1-9]\d*$/.test(input.max) || !Number.isSafeInteger(max)) {
    throw new CLIError(
      "Invalid --max value. Use a positive integer within the safe integer range.",
      "INVALID_FLAG",
      "selftune eval generate --skill <name> --max 50",
    );
  }
  const seed = Number(input.seed);
  if (!/^-?\d+$/.test(input.seed) || !Number.isSafeInteger(seed)) {
    throw new CLIError(
      "Invalid --seed value. Use an integer within the safe integer range.",
      "INVALID_FLAG",
      "selftune eval generate --skill <name> --seed 42",
    );
  }
  const values = {
    skill: input.skill,
    output: input.output,
    out: undefined,
    agent: input.agent,
    max: String(max),
    seed: String(seed),
    "list-skills": input.listSkills,
    stats: input.stats,
    "no-negatives": input.noNegatives,
    "no-taxonomy": input.noTaxonomy,
    "skill-log": input.skillLog,
    "query-log": input.queryLog,
    "telemetry-log": input.telemetryLog,
    synthetic: input.synthetic,
    "auto-synthetic": input.autoSynthetic,
    blend: input.blend,
    "skill-path": input.skillPath,
    model: input.model,
  };

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

    const agent = resolveEvalGenerateAgent(values.agent);

    const maxPerSide = max;
    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;

    emitDashboardStepProgress({
      current: 1,
      total: 4,
      status: "started",
      phase: "load_skill",
      label: "Load skill content",
    });
    console.log(`Generating synthetic evals for skill '${values.skill}'...`);
    const evalSet = await generateSyntheticEvals(values["skill-path"], values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
      llmObserverFactory: createDashboardLlmObserver,
    });
    emitDashboardStepProgress({
      current: 1,
      total: 4,
      status: "finished",
      phase: "load_skill",
      label: "Load skill content",
      passed: true,
      evidence: values["skill-path"],
    });

    const packageEvalPath = getPackageEvalSetPath(values["skill-path"]);
    const outputPath = values.output ?? values.out ?? packageEvalPath;
    emitDashboardStepProgress({
      current: 4,
      total: 4,
      status: "started",
      phase: "write_eval_set",
      label: "Write eval set",
    });
    const canonicalPath = writeCanonicalEvalSet(values.skill, evalSet, values["skill-path"]);
    if (outputPath !== canonicalPath) {
      writeFileSync(outputPath, JSON.stringify(evalSet, null, 2), "utf-8");
    }
    emitDashboardStepProgress({
      current: 4,
      total: 4,
      status: "finished",
      phase: "write_eval_set",
      label: "Write eval set",
      passed: true,
      evidence: outputPath,
    });

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

  emitDashboardStepProgress({
    current: 1,
    total: values.blend ? 5 : 3,
    status: "started",
    phase: "load_records",
    label: "Load telemetry and query records",
  });
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
  emitDashboardStepProgress({
    current: 1,
    total: values.blend ? 5 : 3,
    status: "finished",
    phase: "load_records",
    label: "Load telemetry and query records",
    passed: true,
    evidence: `${skillRecords.length} skill rows · ${queryRecords.length} query rows`,
  });

  if (values["list-skills"]) {
    listSkills(skillRecords, queryRecords, telemetryRecords);
    return;
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
    return;
  }

  const maxPerSide = max;
  const annotateTaxonomy = !values["no-taxonomy"];
  const searchDirs = getEvalSkillSearchDirs();
  const detectedSkillPath = findInstalledSkillPath(values.skill, searchDirs);

  emitDashboardStepProgress({
    current: 2,
    total: values.blend ? 5 : 3,
    status: "started",
    phase: "build_eval_set",
    label: "Build eval set",
  });
  const evalSet = buildEvalSet(
    skillRecords,
    queryRecords,
    values.skill,
    maxPerSide,
    !values["no-negatives"],
    seed,
    annotateTaxonomy,
  );
  emitDashboardStepProgress({
    current: 2,
    total: values.blend ? 5 : 3,
    status: "finished",
    phase: "build_eval_set",
    label: "Build eval set",
    passed: true,
    evidence: `${evalSet.length} entries`,
  });

  const positiveCount = evalSet.filter((entry) => entry.should_trigger).length;
  if (positiveCount < MIN_LOG_READY_POSITIVES && values["auto-synthetic"]) {
    const skillPath = values["skill-path"] ?? detectedSkillPath;
    if (!skillPath) {
      throw new CLIError(
        `Not enough clean trusted triggers found for '${values.skill}', and no SKILL.md path could be resolved for synthetic fallback.`,
        "FILE_NOT_FOUND",
        `Run 'selftune eval generate --list-skills' or rerun with --skill-path /path/to/SKILL.md`,
      );
    }

    const agent = resolveEvalGenerateAgent(values.agent);

    emitDashboardStepProgress({
      current: 1,
      total: 4,
      status: "started",
      phase: "load_skill",
      label: "Load skill content",
    });
    console.log(
      `Only ${positiveCount} clean trusted positive eval candidate(s) found for '${values.skill}'. Falling back to synthetic cold-start eval generation...`,
    );
    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
    const syntheticEvalSet = await generateSyntheticEvals(skillPath, values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
      llmObserverFactory: createDashboardLlmObserver,
    });
    emitDashboardStepProgress({
      current: 1,
      total: 4,
      status: "finished",
      phase: "load_skill",
      label: "Load skill content",
      passed: true,
      evidence: skillPath,
    });
    const packageEvalPath = getPackageEvalSetPath(skillPath);
    const outputPath = values.output ?? values.out ?? packageEvalPath;
    emitDashboardStepProgress({
      current: 4,
      total: 4,
      status: "started",
      phase: "write_eval_set",
      label: "Write eval set",
    });
    const canonicalPath = writeCanonicalEvalSet(values.skill, syntheticEvalSet, skillPath);
    if (outputPath !== canonicalPath) {
      writeFileSync(outputPath, JSON.stringify(syntheticEvalSet, null, 2), "utf-8");
    }
    emitDashboardStepProgress({
      current: 4,
      total: 4,
      status: "finished",
      phase: "write_eval_set",
      label: "Write eval set",
      passed: true,
      evidence: outputPath,
    });
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

  if (positiveCount > 0 && positiveCount < MIN_LOG_READY_POSITIVES) {
    console.warn(
      `[WARN] Only ${positiveCount} clean positive eval candidate(s) were found for '${values.skill}'. The log-derived eval set may be low-confidence. Consider rerunning with --auto-synthetic or --blend.`,
    );
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

    const agent = resolveEvalGenerateAgent(values.agent);

    // Fail fast before expensive LLM calls — blending with zero logs always produces []
    if (evalSet.length === 0) {
      throw new CLIError(
        `--blend requires log-based eval entries to blend with synthetic entries. No log data found for skill "${values.skill}".`,
        "BLEND_NO_LOGS",
        `Use --synthetic instead for cold-start skills, or run selftune sync first to ingest session data.`,
      );
    }

    const effectiveMax = Number.isNaN(maxPerSide) || maxPerSide <= 0 ? 50 : maxPerSide;
    emitDashboardStepProgress({
      current: 1,
      total: 5,
      status: "started",
      phase: "build_log_eval_set",
      label: "Build log eval set",
    });
    emitDashboardStepProgress({
      current: 1,
      total: 5,
      status: "finished",
      phase: "build_log_eval_set",
      label: "Build log eval set",
      passed: true,
      evidence: `${evalSet.length} entries`,
    });
    console.log(`Generating synthetic evals for blending with '${values.skill}'...`);
    const syntheticEvalSet = await generateSyntheticEvals(skillPath, values.skill, agent, {
      maxPositives: effectiveMax,
      maxNegatives: effectiveMax,
      modelFlag: values.model,
      llmObserverFactory: ({ current, total, phase, label }) =>
        createDashboardLlmObserver({
          current: current + 1,
          total: total + 1,
          phase,
          label,
        }),
    });

    emitDashboardStepProgress({
      current: 4,
      total: 5,
      status: "started",
      phase: "blend_eval_sets",
      label: "Blend log and synthetic evals",
    });
    finalEvalSet = blendEvalSets(evalSet, syntheticEvalSet);
    const stats = computeEvalSourceStats(finalEvalSet);
    emitDashboardStepProgress({
      current: 4,
      total: 5,
      status: "finished",
      phase: "blend_eval_sets",
      label: "Blend log and synthetic evals",
      passed: true,
      evidence: `${stats.total} total entries`,
    });
    console.log(
      `Blended: ${stats.log} log + ${stats.blended} synthetic gap-fillers = ${stats.total} total`,
    );
  }

  const resolvedSkillPath = values["skill-path"] ?? detectedSkillPath;
  const outputPath =
    values.output ??
    values.out ??
    (resolvedSkillPath
      ? getPackageEvalSetPath(resolvedSkillPath)
      : `${values.skill}_trigger_eval.json`);
  emitDashboardStepProgress({
    current: values.blend ? 5 : 3,
    total: values.blend ? 5 : 3,
    status: "started",
    phase: "write_eval_set",
    label: "Write eval set",
  });
  const canonicalPath = writeCanonicalEvalSet(values.skill, finalEvalSet, resolvedSkillPath);
  if (outputPath !== canonicalPath) {
    writeFileSync(outputPath, JSON.stringify(finalEvalSet, null, 2), "utf-8");
  }
  emitDashboardStepProgress({
    current: values.blend ? 5 : 3,
    total: values.blend ? 5 : 3,
    status: "finished",
    phase: "write_eval_set",
    label: "Write eval set",
    passed: true,
    evidence: outputPath,
  });
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
