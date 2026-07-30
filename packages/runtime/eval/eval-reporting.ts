import type {
  EvalEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { MIN_LOG_READY_POSITIVES } from "../utils/eval-readiness.js";
import {
  extractPositiveEvalQueryText,
  filterActionableQueryRecords,
  filterActionableSkillUsageRecords,
} from "../utils/query-filter.js";
import {
  findInstalledSkillNames,
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "../utils/skill-discovery.js";
import { isHighConfidencePositiveSkillRecord } from "../utils/skill-usage-confidence.js";

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

export function getEvalSkillSearchDirs(): string[] {
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
  for (const record of actionableSkillRecords) {
    const name = record.skill_name ?? "unknown";
    rawTriggerCounts.set(name, (rawTriggerCounts.get(name) ?? 0) + 1);
    if (!rawSessionCounts.has(name)) rawSessionCounts.set(name, new Set<string>());
    if (record.session_id) rawSessionCounts.get(name)?.add(record.session_id);

    if (!isHighConfidencePositiveSkillRecord(record, name)) continue;
    if (!extractPositiveEvalQueryText(record.query ?? "", name)) continue;
    trustedTriggerCounts.set(name, (trustedTriggerCounts.get(name) ?? 0) + 1);
    if (!trustedSessionCounts.has(name)) trustedSessionCounts.set(name, new Set<string>());
    if (record.session_id) trustedSessionCounts.get(name)?.add(record.session_id);
  }

  const installedNames = findInstalledSkillNames(searchDirs);
  const allNames = new Set<string>([...rawTriggerCounts.keys(), ...installedNames]);
  return [...allNames]
    .sort((left, right) => left.localeCompare(right))
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
          trustedTriggerCount >= MIN_LOG_READY_POSITIVES
            ? "log_ready"
            : installed
              ? "cold_start_ready"
              : "telemetry_only",
      } satisfies EvalSkillReadiness;
    });
}

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
    console.log("  log-ready    enough clean real triggers exist; run eval generate normally");
    console.log(
      "  cold-start   installed locally but not enough clean trusted triggers yet; use --auto-synthetic",
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

export function showTelemetryStats(
  telemetryRecords: SessionTelemetryRecord[],
  skillName: string,
): void {
  const sessions = telemetryRecords.filter((record) =>
    (record.skills_triggered ?? []).includes(skillName),
  );
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
  for (const session of sessions) {
    for (const [tool, count] of Object.entries(session.tool_calls ?? {})) {
      if (!allTools.has(tool)) allTools.set(tool, []);
      allTools.get(tool)?.push(count);
    }
    allTurns.push(session.assistant_turns ?? 0);
    allErrors.push(session.errors_encountered ?? 0);
    allBashCounts.push((session.bash_commands ?? []).length);
  }
  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((left, right) => left + right, 0) / values.length : 0;
  console.log(
    `  Assistant turns:   avg ${average(allTurns).toFixed(1)}  (min ${Math.min(...allTurns)}, max ${Math.max(...allTurns)})`,
  );
  console.log(
    `  Errors:            avg ${average(allErrors).toFixed(1)}  (min ${Math.min(...allErrors)}, max ${Math.max(...allErrors)})`,
  );
  console.log(`  Bash commands:     avg ${average(allBashCounts).toFixed(1)}`);
  console.log();
  console.log("  Tool call averages:");
  for (const [tool, counts] of [...allTools.entries()].sort(
    (left, right) => average(right[1]) - average(left[1]),
  )) {
    console.log(`    ${tool.padEnd(20)} avg ${average(counts).toFixed(1)}`);
  }

  const highError = sessions.filter((session) => (session.errors_encountered ?? 0) > 2);
  if (highError.length > 0) {
    console.log(
      `\n  WARNING: ${highError.length} session(s) had >2 errors -- inspect transcripts:`,
    );
    for (const session of highError) {
      console.log(
        `    session ${session.session_id.slice(0, 12)}... -- ${session.errors_encountered} errors, transcript: ${session.transcript_path ?? "?"}`,
      );
    }
  }
}

export function printEvalStats(
  evalSet: EvalEntry[],
  skillName: string,
  outputPath: string,
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  annotateTaxonomy: boolean,
): void {
  const positives = evalSet.filter((entry) => entry.should_trigger);
  const negatives = evalSet.filter((entry) => !entry.should_trigger);
  const actionableSkillRecords = filterActionableSkillUsageRecords(skillRecords);
  const actionableQueryRecords = filterActionableQueryRecords(queryRecords);
  const totalTriggers = actionableSkillRecords.filter(
    (record) => record.skill_name === skillName,
  ).length;

  console.log(`Wrote ${evalSet.length} eval entries to ${outputPath}`);
  console.log(
    `  Positives (should_trigger=true) : ${positives.length}  (from ${totalTriggers} logged triggers)`,
  );
  console.log(
    `  Negatives (should_trigger=false): ${negatives.length}  (from ${actionableQueryRecords.length} actionable logged queries)`,
  );
  if (annotateTaxonomy && positives.length > 0) {
    const types = new Map<string, number>();
    for (const entry of positives) {
      const type = entry.invocation_type ?? "?";
      types.set(type, (types.get(type) ?? 0) + 1);
    }
    console.log("\n  Positive invocation types:");
    for (const [type, count] of [...types.entries()].sort()) {
      console.log(`    ${type.padEnd(15)}  ${count}`);
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
  if (positives.length === 0) {
    console.log(`[WARN] No positives for skill '${skillName}'.`);
    const names = [...new Set(actionableSkillRecords.map((record) => record.skill_name))].sort();
    if (names.length > 0) console.log(`       Known skills: ${names.join(", ")}`);
  }
  if (negatives.length === 0) {
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

export function printSyntheticFallbackHint(skillName: string, skillPath: string): void {
  console.log("");
  console.log(`[TIP] No trusted trigger data found yet for '${skillName}'.`);
  console.log(
    "      This skill is installed locally, so you can still generate a cold-start eval set:",
  );
  console.log(
    `      selftune eval generate --skill ${skillName} --auto-synthetic --skill-path ${skillPath}`,
  );
}
