import { dirname, resolve } from "node:path";

import { getDb } from "@selftune/local-store";

import type {
  PortfolioAuditResult,
  QuarantineReceipt,
  QuarantineRecord,
} from "../dashboard-contract.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
  queryTrustedSkillObservationRows,
} from "../localdb/queries.js";
import { CLIError } from "../utils/cli-error.js";
import { findInstalledSkillPackages, getDefaultSkillSearchDirs } from "../utils/skill-discovery.js";
import {
  buildPortfolioAudit,
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_MIN_SESSIONS,
  detectConsolidationCandidates,
} from "./audit.js";
import { listQuarantinedSkills, quarantineSkill, restoreQuarantinedSkill } from "./quarantine.js";

export {
  formatSkillsConsolidation,
  formatSkillsConsolidationRollback,
  runSkillsConsolidateProgram,
  runSkillsConsolidationRollbackProgram,
  type RunSkillsConsolidateOptions,
  type RunSkillsConsolidationRollbackOptions,
  type SkillsConsolidationResult,
  type SkillsConsolidationRollbackResult,
} from "./consolidation-programs.js";

export interface RunSkillsAuditOptions {
  readonly minSessions?: number;
  readonly inactiveDays?: number;
  readonly searchDirs?: ReadonlyArray<string>;
}

export function runSkillsAuditProgram(options: RunSkillsAuditOptions = {}): PortfolioAuditResult {
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
  const inactiveDays = options.inactiveDays ?? DEFAULT_INACTIVE_DAYS;
  const searchDirs = [
    ...getDefaultSkillSearchDirs(),
    ...(options.searchDirs ?? []).map((value) => resolve(value)),
  ];
  const db = getDb();
  const installed = findInstalledSkillPackages(searchDirs);
  const consolidations = detectConsolidationCandidates(
    installed,
    querySkillUsageRecords(db),
    queryQueryLog(db),
    searchDirs,
  );

  return buildPortfolioAudit(
    installed,
    queryTrustedSkillObservationRows(db),
    querySessionTelemetry(db),
    { minSessions, inactiveDays, consolidationSkillNames: consolidations },
  );
}

export function formatSkillsAudit(result: PortfolioAuditResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  const lines = [`Installed skill portfolio: ${result.installed_count} packages`];
  for (const skill of result.skills) {
    lines.push("");
    lines.push(`${skill.skill_name} [${skill.classification}]`);
    lines.push(`  Recommendation: ${skill.recommendation}`);
    lines.push(`  ${skill.reason}`);
    lines.push(`  Path: ${skill.skill_path}`);
  }
  return lines.join("\n");
}

export function runSkillsQuarantinedProgram(): ReadonlyArray<QuarantineRecord> {
  return listQuarantinedSkills();
}

export function formatSkillsQuarantined(
  records: ReadonlyArray<QuarantineRecord>,
  json: boolean,
): string {
  if (json) return JSON.stringify({ quarantined: records }, null, 2);
  if (records.length === 0) return "No skills are currently quarantined.";

  return [
    `Quarantined skills: ${records.length}`,
    ...records.map((record) => `- ${record.skill_name} (${record.quarantine_id})`),
  ].join("\n");
}

export interface RunSkillsQuarantineOptions {
  readonly skill?: string;
  readonly skillPath?: string;
  readonly approved?: boolean;
  readonly dryRun?: boolean;
}

export function runSkillsQuarantineProgram(options: RunSkillsQuarantineOptions): QuarantineReceipt {
  if (!options.skill) {
    throw new CLIError(
      "--skill NAME is required.",
      "MISSING_FLAG",
      "selftune skills quarantine --skill NAME --dry-run --json",
    );
  }
  if (!options.approved && !options.dryRun) {
    throw new CLIError(
      "Quarantine requires explicit approval through --yes.",
      "GUARD_BLOCKED",
      `Review selftune skills audit --json, then run selftune skills quarantine --skill ${options.skill} --yes --json.`,
      2,
    );
  }

  const searchDirs = getDefaultSkillSearchDirs();
  if (options.skillPath) {
    const explicitPath = resolve(options.skillPath);
    searchDirs.push(
      explicitPath.toLowerCase().endsWith("skill.md")
        ? dirname(dirname(explicitPath))
        : dirname(explicitPath),
    );
  }

  return quarantineSkill({
    installedSkills: findInstalledSkillPackages(searchDirs),
    skillName: options.skill,
    skillPath: options.skillPath,
    dryRun: options.dryRun,
  });
}

export interface RunSkillsRestoreOptions {
  readonly id?: string;
  readonly dryRun?: boolean;
}

export function runSkillsRestoreProgram(options: RunSkillsRestoreOptions): QuarantineReceipt {
  if (!options.id) {
    throw new CLIError(
      "--id ID is required.",
      "MISSING_FLAG",
      "selftune skills quarantined --json",
    );
  }

  return restoreQuarantinedSkill({
    quarantineId: options.id,
    dryRun: options.dryRun,
  });
}

export function formatSkillsReceipt(receipt: QuarantineReceipt, json: boolean): string {
  if (json) return JSON.stringify(receipt, null, 2);

  const lines = [
    `${receipt.skill_name}: ${receipt.status}`,
    `  Quarantine ID: ${receipt.quarantine_id}`,
  ];
  if (receipt.undo_command) lines.push(`  Undo: ${receipt.undo_command}`);
  return lines.join("\n");
}
