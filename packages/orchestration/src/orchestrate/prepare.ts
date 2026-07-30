import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildDefaultGradingOutputPath,
  deriveExpectationsFromSkill,
  gradeSession,
  resolveLatestSessionForSkill,
} from "@selftune/runtime/grading/grade-session";
import { selectAcceptedPackageFrontierCandidate } from "@selftune/runtime/create/package-candidate-state";
import { writeGradingResultToDb } from "@selftune/runtime/localdb/direct-write";
import { createDefaultSyncOptions } from "../sync.js";
import { getDb } from "@selftune/local-store";
import {
  captureCorrectionSignalStudies,
  type CorrectionSignalStudyStageSummary,
} from "./correction-signal-studies.js";
import { readCanonicalPackageEvaluationArtifact } from "@selftune/runtime/testing-readiness";
import type {
  ImprovementSignalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import { readExcerpt } from "@selftune/runtime/utils/transcript";
import type { OrchestrateOptions, SkillAction } from "../orchestrate.js";
import { MIN_CANDIDATE_EVIDENCE, selectCandidates } from "./plan.js";
import { groupSignalsBySkill, readPendingSignals } from "./signals.js";
import type { ResolvedOrchestrateRuntime } from "./runtime.js";

export interface PreparedOrchestrateRun {
  syncResult: Awaited<ReturnType<ResolvedOrchestrateRuntime["syncSources"]>>;
  statusResult: ReturnType<ResolvedOrchestrateRuntime["computeStatus"]>;
  telemetry: SessionTelemetryRecord[];
  skillRecords: SkillUsageRecord[];
  pendingSignals: ImprovementSignalRecord[];
  candidates: SkillAction[];
  evolveCandidates: SkillAction[];
  agent: string | null;
  autoGradedCount: number;
}

export function collectPackageSearchEligibleSkills(
  skillNames: string[],
  options?: {
    db?: import("bun:sqlite").Database;
    resolveSkillPath?: (skillName: string) => string | undefined;
  },
): Set<string> {
  const eligible = new Set<string>();

  for (const skillName of skillNames) {
    if (
      selectAcceptedPackageFrontierCandidate(skillName) != null ||
      readCanonicalPackageEvaluationArtifact(skillName) != null
    ) {
      eligible.add(skillName);
      continue;
    }

    // Second tier: skills with a draft package and sufficient grading evidence
    if (!options?.db || !options?.resolveSkillPath) continue;

    const skillPath = options.resolveSkillPath(skillName);
    if (!skillPath) continue;

    const hasDraft = existsSync(join(dirname(skillPath), "selftune.create.json"));
    if (!hasDraft) continue;

    try {
      const row = options.db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM grading_results WHERE skill_name = ?",
        )
        .get(skillName);
      if (row && row.count >= MIN_CANDIDATE_EVIDENCE) {
        eligible.add(skillName);
      }
    } catch {
      // Fail-open: table may not exist yet
    }
  }

  return eligible;
}

/**
 * Detects significant overlap between the positive eval sets of evolution
 * candidates. When two skills share >30% of their positive queries, it
 * suggests a routing boundary problem. Console-only — no persistence.
 */
export async function detectCrossSkillOverlap(
  candidates: Array<{ skill: string }>,
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
): Promise<
  Array<{ skill_a: string; skill_b: string; overlap_pct: number; shared_queries: string[] }>
> {
  if (candidates.length < 2) return [];

  const { buildEvalSet } = await import("@selftune/runtime/eval/hooks-to-evals");

  const evalSets = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const evalSet = buildEvalSet(skillRecords, queryRecords, candidate.skill);
    const positives = new Set(
      evalSet
        .filter((entry: { should_trigger: boolean }) => entry.should_trigger)
        .map((entry: { query: string }) => entry.query.toLowerCase()),
    );
    evalSets.set(candidate.skill, positives);
  }

  const overlaps: Array<{
    skill_a: string;
    skill_b: string;
    overlap_pct: number;
    shared_queries: string[];
  }> = [];
  const skillNames = [...evalSets.keys()];

  for (let i = 0; i < skillNames.length; i++) {
    for (let j = i + 1; j < skillNames.length; j++) {
      const setA = evalSets.get(skillNames[i]);
      const setB = evalSets.get(skillNames[j]);
      if (!setA || !setB || setA.size === 0 || setB.size === 0) continue;

      const shared: string[] = [];
      for (const query of setA) {
        if (setB.has(query)) shared.push(query);
      }

      const overlapPct = shared.length / Math.min(setA.size, setB.size);
      if (overlapPct > 0.3) {
        overlaps.push({
          skill_a: skillNames[i],
          skill_b: skillNames[j],
          overlap_pct: overlapPct,
          shared_queries: shared.slice(0, 10),
        });
      }
    }
  }

  return overlaps;
}

/**
 * Auto-grade the top ungraded skills that have some session data.
 * Fail-open: individual grading errors are logged but never propagated.
 */
export async function autoGradeTopUngraded(
  skills: Array<ReturnType<ResolvedOrchestrateRuntime["computeStatus"]>["skills"][number]>,
  maxAutoGrade: number,
  agent: string,
  deps: {
    readTelemetry: () => SessionTelemetryRecord[];
    readSkillRecords: () => SkillUsageRecord[];
  },
): Promise<number> {
  const ungradedWithData = skills
    .filter((skill) => skill.status === "UNGRADED" && (skill.snapshot?.skill_checks ?? 0) > 0)
    .sort((a, b) => (b.snapshot?.skill_checks ?? 0) - (a.snapshot?.skill_checks ?? 0))
    .slice(0, maxAutoGrade);

  if (ungradedWithData.length === 0) return 0;

  // Cache data reads outside the loop — SQLite tables don't change during grading
  // iterations, so re-reading per-skill is wasteful.
  const cachedTelemetry = deps.readTelemetry();
  const cachedSkillUsage = deps.readSkillRecords();

  let graded = 0;

  for (const skill of ungradedWithData) {
    try {
      const resolved = resolveLatestSessionForSkill(cachedTelemetry, cachedSkillUsage, skill.name);
      if (!resolved) {
        console.error(`  [auto-grade] ${skill.name}: no session found, skipping`);
        continue;
      }

      const derived = deriveExpectationsFromSkill(skill.name);
      let transcriptExcerpt = "(no transcript)";
      if (resolved.transcriptPath) {
        try {
          transcriptExcerpt = readExcerpt(resolved.transcriptPath);
        } catch {
          transcriptExcerpt = "(no transcript)";
        }
      }

      console.error(`  [auto-grade] Grading "${skill.name}" (session ${resolved.sessionId})...`);

      const result = await gradeSession({
        expectations: derived.expectations,
        telemetry: resolved.telemetry,
        sessionId: resolved.sessionId,
        skillName: skill.name,
        transcriptExcerpt,
        transcriptPath: resolved.transcriptPath,
        agent,
      });

      let persisted = false;
      try {
        persisted = writeGradingResultToDb(result);
      } catch {
        persisted = false;
      }

      if (!persisted) {
        console.error(`  [auto-grade] ${skill.name}: graded but failed to persist result`);
        continue;
      }

      try {
        const basePath = buildDefaultGradingOutputPath(resolved.sessionId);
        const safeName = skill.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = basePath.replace(/\.json$/, `_${safeName}.json`);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
      } catch {
        // DB is authoritative; file output is supplementary only.
      }

      const passRate = result.summary.pass_rate;
      console.error(
        `  [auto-grade] ${skill.name}: ${result.summary.passed}/${result.summary.total} passed (${Math.round(passRate * 100)}%)`,
      );
      graded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  [auto-grade] ${skill.name}: error — ${msg}. Retry with: selftune grade ${skill.name}`,
      );
    }
  }

  return graded;
}

export async function prepareOrchestrateRun(
  options: OrchestrateOptions,
  runtime: ResolvedOrchestrateRuntime,
): Promise<PreparedOrchestrateRun> {
  console.error("[orchestrate] Syncing source-truth telemetry...");
  const syncResult = await runtime.syncSources(
    createDefaultSyncOptions({ force: options.syncForce }),
  );
  const sourceSynced = Object.values(syncResult.sources).reduce(
    (sum, source) => sum + source.synced,
    0,
  );
  console.error(
    `[orchestrate] Sync complete: ${sourceSynced} sessions synced, ${syncResult.repair.repaired_records} repaired`,
  );
  let correctionSignals: CorrectionSignalStudyStageSummary = {
    detected: 0,
    persisted: 0,
    drafted: 0,
    deferred: 0,
    errors: 0,
  };
  try {
    correctionSignals = await captureCorrectionSignalStudies({ database: getDb() });
  } catch (error) {
    correctionSignals = { ...correctionSignals, errors: 1 };
    console.error(
      `[orchestrate] Correction signal capture failed (non-blocking): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  console.error(
    `[orchestrate] Correction signals: detected=${correctionSignals.detected} persisted=${correctionSignals.persisted} drafted=${correctionSignals.drafted} deferred=${correctionSignals.deferred} errors=${correctionSignals.errors}`,
  );

  console.error("[orchestrate] Computing skill status...");
  const telemetry = runtime.readTelemetry();
  const skillRecords = runtime.readSkillRecords();
  const queryRecords = runtime.readQueryRecords();
  const auditEntries = runtime.readAuditEntries();
  const doctorResult = await runtime.doctor();

  let statusResult = runtime.computeStatus(
    telemetry,
    skillRecords,
    queryRecords,
    auditEntries,
    doctorResult,
  );
  console.error(
    `[orchestrate] Status: ${statusResult.skills.length} skills, system=${statusResult.system.healthy ? "healthy" : "unhealthy"}`,
  );

  let autoGradedCount = 0;
  const scopedSkills = options.skillFilter
    ? statusResult.skills.filter((skill) => skill.name === options.skillFilter)
    : statusResult.skills;
  const ungradedWithData = scopedSkills.filter(
    (skill) => skill.status === "UNGRADED" && (skill.snapshot?.skill_checks ?? 0) > 0,
  );

  if (!options.dryRun && options.maxAutoGrade > 0 && ungradedWithData.length > 0) {
    const gradeAgent = runtime.detectAgent();
    if (gradeAgent) {
      console.error(
        `[orchestrate] Auto-grading ${Math.min(ungradedWithData.length, options.maxAutoGrade)} ungraded skill(s)...`,
      );
      autoGradedCount = await autoGradeTopUngraded(scopedSkills, options.maxAutoGrade, gradeAgent, {
        readTelemetry: runtime.readTelemetry,
        readSkillRecords: runtime.readSkillRecords,
      });

      if (autoGradedCount > 0) {
        console.error(
          `[orchestrate] Recomputing status after grading ${autoGradedCount} skill(s)...`,
        );
        try {
          // Re-read telemetry and skill records (grading writes new rows), but
          // reuse queryRecords and auditEntries — auto-grading doesn't touch those tables.
          statusResult = runtime.computeStatus(
            runtime.readTelemetry(),
            runtime.readSkillRecords(),
            queryRecords,
            auditEntries,
            doctorResult,
          );
        } catch (recomputeErr) {
          console.error(
            `[orchestrate] Warning: failed to recompute status after grading — using pre-grade status. ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
          );
        }
      }
    } else {
      console.error(
        "[orchestrate] No agent CLI found — skipping auto-grade. To disable, rerun with: selftune orchestrate --max-auto-grade 0",
      );
    }
  }

  const pendingSignals = readPendingSignals(runtime.readSignals);
  const signaledSkills = groupSignalsBySkill(pendingSignals);
  let localDatabase: import("bun:sqlite").Database | undefined;
  try {
    localDatabase = getDb();
  } catch (error) {
    console.error(
      `[orchestrate] Package-search eligibility unavailable (non-blocking): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const packageFrontierSkills = collectPackageSearchEligibleSkills(
    statusResult.skills.map((skill) => skill.name),
    { db: localDatabase, resolveSkillPath: runtime.resolveSkillPath },
  );
  if (signaledSkills.size > 0) {
    console.error(
      `[orchestrate] Improvement signals: ${pendingSignals.length} pending for ${signaledSkills.size} skill(s)`,
    );
  }

  const candidates = selectCandidates(statusResult.skills, {
    skillFilter: options.skillFilter,
    maxSkills: options.maxSkills,
    auditEntries,
    signaledSkills,
    packageFrontierSkills,
  });

  const evolveCandidates = candidates.filter((candidate) => candidate.action === "evolve");
  const packageSearchCount = candidates.filter(
    (candidate) => candidate.action === "package-search",
  ).length;
  const skipCount = candidates.filter((candidate) => candidate.action === "skip").length;
  console.error(
    `[orchestrate] Candidates: ${evolveCandidates.length} to evolve, ${packageSearchCount} to package-search, ${skipCount} skipped`,
  );
  for (const candidate of candidates) {
    console.error(
      `  ${candidate.action === "skip" ? "⊘" : "→"} ${candidate.skill}: ${candidate.reason}`,
    );
  }

  if (evolveCandidates.length >= 2) {
    try {
      const overlap = await detectCrossSkillOverlap(evolveCandidates, skillRecords, queryRecords);
      if (overlap.length > 0) {
        console.error("\n[orchestrate] Cross-skill eval overlap detected:");
        for (const entry of overlap) {
          console.error(
            `  ⚠ ${entry.skill_a} ↔ ${entry.skill_b}: ${(entry.overlap_pct * 100).toFixed(0)}% shared queries (${entry.shared_queries.length} queries)`,
          );
        }
        console.error("");
      }
    } catch {
      // Overlap detection is informative only.
    }
  }

  const agent = runtime.detectAgent();
  if (!agent && evolveCandidates.length > 0) {
    console.error("[orchestrate] WARNING: No agent CLI found in PATH. Evolve will be skipped.");
    for (const candidate of evolveCandidates) {
      candidate.action = "skip";
      candidate.reason = "no agent CLI available";
    }
  }

  return {
    syncResult,
    statusResult,
    telemetry,
    skillRecords,
    pendingSignals,
    candidates,
    evolveCandidates,
    agent,
    autoGradedCount,
  };
}
