#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  PortfolioAuditEntry,
  PortfolioAuditResult,
  PortfolioClassification,
  PortfolioRecommendation,
  QuarantineReceipt,
  QuarantineRecord,
} from "./dashboard-contract.js";
import { analyzeSkillFamilyOverlap } from "./eval/family-overlap.js";
import { getDb } from "./localdb/db.js";
import {
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
  queryTrustedSkillObservationRows,
  type TrustedSkillObservationRow,
} from "./localdb/queries.js";
import type { QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "./types.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "./utils/skill-discovery.js";

export const DEFAULT_MIN_SESSIONS = 20;
export const DEFAULT_INACTIVE_DAYS = 30;
export const DEFAULT_MIN_CHECKS = 10;
export const DEFAULT_ROUTING_MISS_RATE = 0.85;
export const QUARANTINE_DIR = join(SELFTUNE_CONFIG_DIR, "quarantine");

export type {
  PortfolioAuditEntry,
  PortfolioAuditResult,
  PortfolioClassification,
  PortfolioRecommendation,
  QuarantineReceipt,
  QuarantineRecord,
} from "./dashboard-contract.js";

interface BuildAuditOptions {
  now?: Date;
  minSessions?: number;
  inactiveDays?: number;
  minChecks?: number;
  routingMissRate?: number;
  consolidationSkillNames?: ReadonlySet<string>;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function daysBetween(later: Date, earlierIso: string): number {
  const earlier = new Date(earlierIso);
  if (Number.isNaN(earlier.getTime())) return 0;
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

function sessionsAfter(sessions: SessionTelemetryRecord[], timestamp: string): number {
  return new Set(
    sessions
      .filter((session) => session.timestamp > timestamp)
      .map((session) => session.session_id),
  ).size;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sessionsEligibleForSkill(
  installed: InstalledSkillPackage,
  sessions: SessionTelemetryRecord[],
): SessionTelemetryRecord[] {
  if (installed.skill_scope !== "project" || !installed.skill_project_root) return sessions;
  return sessions.filter(
    (session) => session.cwd && isWithinPath(installed.skill_project_root!, session.cwd),
  );
}

function classifyEntry(options: {
  installed: InstalledSkillPackage;
  observations: TrustedSkillObservationRow[];
  sessions: SessionTelemetryRecord[];
  now: Date;
  minSessions: number;
  inactiveDays: number;
  minChecks: number;
  routingMissRate: number;
  consolidationCandidate: boolean;
}): PortfolioAuditEntry {
  const { installed, observations, sessions, now } = options;
  const triggered = observations.filter((row) => row.triggered === 1);
  const lastSeenAt =
    observations
      .map((row) => row.occurred_at)
      .filter((value): value is string => value != null)
      .toSorted((left, right) => right.localeCompare(left))[0] ?? null;
  const lastInvokedAt =
    triggered
      .map((row) => row.occurred_at)
      .filter((value): value is string => value != null)
      .toSorted((left, right) => right.localeCompare(left))[0] ?? null;
  const evidenceStart = lastInvokedAt ?? installed.modified_at;
  const eligibleSessions = sessionsEligibleForSkill(installed, sessions);
  const sessionsSinceInvocation = sessionsAfter(eligibleSessions, evidenceStart);
  const inactiveDays = daysBetween(now, evidenceStart);
  const missRate = observations.length > 0 ? 1 - triggered.length / observations.length : null;
  const protectedSkill =
    normalizedName(installed.name) === "selftune" ||
    installed.skill_scope === "system" ||
    installed.skill_scope === "admin";

  let classification: PortfolioClassification;
  let recommendation: PortfolioRecommendation;
  let reason: string;

  if (protectedSkill) {
    classification = "protected";
    recommendation = "keep";
    reason = "SelfTune and system/admin-managed skills are excluded from portfolio mutation.";
  } else if (
    observations.length >= options.minChecks &&
    (missRate ?? 0) >= options.routingMissRate
  ) {
    classification = "routing_problem";
    recommendation = "repair_routing";
    reason = `${observations.length - triggered.length} of ${observations.length} trusted contextual checks missed invocation; repair routing before considering removal.`;
  } else if (options.consolidationCandidate) {
    classification = "consolidation_candidate";
    recommendation = "review_consolidation";
    reason =
      "Sibling skill evidence suggests overlapping entry points; test a parent workflow before removing any package.";
  } else if (
    lastInvokedAt &&
    inactiveDays >= options.inactiveDays &&
    sessionsSinceInvocation >= options.minSessions
  ) {
    classification = "inactive_candidate";
    recommendation = "review_quarantine";
    reason = `No trusted invocation for ${inactiveDays} days across ${sessionsSinceInvocation} subsequent sessions; review rare-use obligations before quarantine.`;
  } else if (observations.length === 0) {
    classification = "unobserved";
    recommendation = "measure";
    reason =
      "No trustworthy usage evidence exists; absence of observations is not evidence that the skill is unused.";
  } else if (observations.length < options.minChecks) {
    classification = "under_observed";
    recommendation = "measure";
    reason = `Only ${observations.length} trusted checks are available; collect at least ${options.minChecks} before a portfolio decision.`;
  } else {
    classification = "active";
    recommendation = "keep";
    reason = "Recent trusted invocation evidence supports keeping the skill active.";
  }

  return {
    skill_name: installed.name,
    skill_path: installed.skill_path,
    package_path: installed.package_path,
    scope: installed.skill_scope,
    classification,
    recommendation,
    reason,
    evidence: {
      trusted_checks: observations.length,
      triggered_count: triggered.length,
      miss_rate: missRate,
      last_seen_at: lastSeenAt,
      last_invoked_at: lastInvokedAt,
      sessions_since_invocation: sessionsSinceInvocation,
      inactive_days: inactiveDays,
      package_modified_at: installed.modified_at,
    },
  };
}

export function buildPortfolioAudit(
  installedSkills: InstalledSkillPackage[],
  observations: TrustedSkillObservationRow[],
  sessions: SessionTelemetryRecord[],
  options: BuildAuditOptions = {},
): PortfolioAuditResult {
  const now = options.now ?? new Date();
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
  const inactiveDays = options.inactiveDays ?? DEFAULT_INACTIVE_DAYS;
  const minChecks = options.minChecks ?? DEFAULT_MIN_CHECKS;
  const routingMissRate = options.routingMissRate ?? DEFAULT_ROUTING_MISS_RATE;
  const installedNameCounts = new Map<string, number>();
  for (const installed of installedSkills) {
    const name = normalizedName(installed.name);
    installedNameCounts.set(name, (installedNameCounts.get(name) ?? 0) + 1);
  }

  const observationMap = new Map<string, TrustedSkillObservationRow[]>();
  for (const observation of observations) {
    const name = normalizedName(observation.skill_name);
    const existing = observationMap.get(name);
    if (existing) existing.push(observation);
    else observationMap.set(name, [observation]);
  }

  const skills = installedSkills.map((installed) => {
    const name = normalizedName(installed.name);
    const installedPath = resolve(installed.skill_path);
    const matchingObservations = (observationMap.get(name) ?? []).filter((observation) => {
      if (observation.skill_path) return resolve(observation.skill_path) === installedPath;
      return installedNameCounts.get(name) === 1;
    });
    return classifyEntry({
      installed,
      observations: matchingObservations,
      sessions,
      now,
      minSessions,
      inactiveDays,
      minChecks,
      routingMissRate,
      consolidationCandidate:
        options.consolidationSkillNames?.has(normalizedName(installed.name)) ?? false,
    });
  });
  const counts: Record<PortfolioClassification, number> = {
    protected: 0,
    unobserved: 0,
    under_observed: 0,
    routing_problem: 0,
    active: 0,
    inactive_candidate: 0,
    consolidation_candidate: 0,
  };
  for (const skill of skills) counts[skill.classification]++;

  return {
    generated_at: now.toISOString(),
    thresholds: {
      min_sessions: minSessions,
      inactive_days: inactiveDays,
      min_checks: minChecks,
      routing_miss_rate: routingMissRate,
    },
    session_count: new Set(sessions.map((session) => session.session_id)).size,
    installed_count: skills.length,
    counts,
    skills,
  };
}

export function loadPortfolioAudit(
  searchDirs: string[] = getDefaultSkillSearchDirs(),
): PortfolioAuditResult {
  const db = getDb();
  const installed = findInstalledSkillPackages(searchDirs);
  const skillRecords = querySkillUsageRecords(db);
  const queryRecords = queryQueryLog(db);
  const consolidations = detectConsolidationCandidates(
    installed,
    skillRecords,
    queryRecords,
    searchDirs,
  );
  return buildPortfolioAudit(
    installed,
    queryTrustedSkillObservationRows(db),
    querySessionTelemetry(db) as SessionTelemetryRecord[],
    { consolidationSkillNames: consolidations },
  );
}

function inferFamilyPrefix(skillName: string): string | null {
  const hyphenIndex = skillName.indexOf("-");
  return hyphenIndex > 0 ? skillName.slice(0, hyphenIndex + 1) : null;
}

export function detectConsolidationCandidates(
  installedSkills: InstalledSkillPackage[],
  skillRecords: SkillUsageRecord[],
  queryRecords: QueryLogRecord[],
  searchDirs: string[],
): Set<string> {
  const families = new Map<string, Set<string>>();
  for (const skill of installedSkills) {
    const prefix = inferFamilyPrefix(skill.name);
    if (!prefix) continue;
    const members = families.get(prefix) ?? new Set<string>();
    members.add(skill.name);
    families.set(prefix, members);
  }

  const candidates = new Set<string>();
  for (const [prefix, memberSet] of families) {
    const members = [...memberSet].toSorted();
    if (members.length < 2) continue;
    const report = analyzeSkillFamilyOverlap(members, skillRecords, queryRecords, {
      familyPrefix: prefix,
      searchDirs,
    });
    if (!report.consolidation_candidate && !report.cold_start_suspicion?.candidate) continue;
    for (const member of members) candidates.add(normalizedName(member));
  }
  return candidates;
}

function recordPath(quarantineRoot: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new CLIError(
      `Invalid quarantine ID "${id}".`,
      "INVALID_FLAG",
      "selftune skills quarantined --json",
    );
  }
  return join(quarantineRoot, id, "record.json");
}

function writeRecord(quarantineRoot: string, record: QuarantineRecord): void {
  const path = recordPath(quarantineRoot, record.quarantine_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function readRecord(quarantineRoot: string, id: string): QuarantineRecord {
  const path = recordPath(quarantineRoot, id);
  if (!existsSync(path)) {
    throw new CLIError(
      `No quarantine receipt found for "${id}".`,
      "FILE_NOT_FOUND",
      "selftune skills quarantined --json",
    );
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as QuarantineRecord;
    if (record.schema_version !== 1 || record.quarantine_id !== id) throw new Error("bad schema");
    const resolvedPackagePath = resolve(record.quarantined_package_path);
    const resolvedRoot = resolve(quarantineRoot);
    if (!resolvedPackagePath.startsWith(`${resolvedRoot}${sep}`)) throw new Error("bad path");
    return record;
  } catch {
    throw new CLIError(
      `Quarantine receipt "${id}" is invalid.`,
      "OPERATION_FAILED",
      "Inspect the receipt before retrying restore.",
    );
  }
}

export function listQuarantinedSkills(quarantineRoot: string = QUARANTINE_DIR): QuarantineRecord[] {
  return listQuarantineRecords(quarantineRoot)
    .filter(
      (record) =>
        record.status !== "restored" &&
        entryExists(record.quarantined_package_path) &&
        !entryExists(record.original_package_path),
    )
    .map((record): QuarantineRecord => ({ ...record, status: "quarantined" }))
    .toSorted((left, right) => right.quarantined_at.localeCompare(left.quarantined_at));
}

function listQuarantineRecords(quarantineRoot: string): QuarantineRecord[] {
  if (!existsSync(quarantineRoot)) return [];
  const records: QuarantineRecord[] = [];
  for (const entry of readdirSync(quarantineRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(readRecord(quarantineRoot, entry.name));
    } catch {
      // A damaged receipt should not hide other valid quarantines.
    }
  }
  return records;
}

function receiptFromRecord(
  record: QuarantineRecord,
  status: QuarantineReceipt["status"],
  dryRun: boolean,
): QuarantineReceipt {
  const quarantined = status === "quarantined" || status === "already_quarantined";
  return {
    success: true,
    status,
    skill_name: record.skill_name,
    quarantine_id: record.quarantine_id,
    original_package_path: record.original_package_path,
    quarantined_package_path: record.quarantined_package_path,
    package_version_hash: record.package_version_hash,
    dry_run: dryRun,
    undo_command:
      quarantined && !dryRun ? `selftune skills restore --id ${record.quarantine_id} --json` : null,
  };
}

function movePackage(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
  }

  const tombstone = join(dirname(source), `.${basename(source)}.selftune-moving-${randomUUID()}`);
  const partialDestination = `${destination}.partial-${randomUUID()}`;
  renameSync(source, tombstone);
  const sourceStat = lstatSync(tombstone);
  const sourceFingerprint = sourceStat.isSymbolicLink()
    ? `symlink:${readlinkSync(tombstone)}`
    : computeSkillVersionHash(join(tombstone, "SKILL.md"));
  if (!sourceFingerprint) {
    renameSync(tombstone, source);
    throw new Error(`Could not verify skill package before moving ${source}.`);
  }
  let destinationFinalized = false;
  try {
    cpSync(tombstone, partialDestination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copiedStat = lstatSync(partialDestination);
    const copiedFingerprint = copiedStat.isSymbolicLink()
      ? `symlink:${readlinkSync(partialDestination)}`
      : computeSkillVersionHash(join(partialDestination, "SKILL.md"));
    if (copiedFingerprint !== sourceFingerprint) {
      throw new Error(`Copied skill package failed verification for ${source}.`);
    }
    renameSync(partialDestination, destination);
    destinationFinalized = true;
    try {
      rmSync(tombstone, { recursive: sourceStat.isDirectory(), force: false });
    } catch {
      // The verified destination is authoritative; leave a tombstone for manual cleanup.
    }
  } catch (error) {
    rmSync(partialDestination, { recursive: true, force: true });
    if (!destinationFinalized && entryExists(tombstone) && !entryExists(source)) {
      renameSync(tombstone, source);
    }
    throw error;
  }
}

export function quarantineSkill(options: {
  installedSkills: InstalledSkillPackage[];
  skillName: string;
  skillPath?: string;
  quarantineRoot?: string;
  dryRun?: boolean;
  now?: Date;
}): QuarantineReceipt {
  const quarantineRoot = resolve(options.quarantineRoot ?? QUARANTINE_DIR);
  const requestedPath = options.skillPath ? resolve(options.skillPath) : null;
  const matches = options.installedSkills.filter(
    (skill) =>
      normalizedName(skill.name) === normalizedName(options.skillName) &&
      (!requestedPath ||
        requestedPath === resolve(skill.skill_path) ||
        requestedPath === resolve(skill.package_path)),
  );

  if (matches.length === 0) {
    const existing = listQuarantinedSkills(quarantineRoot).find(
      (record) => normalizedName(record.skill_name) === normalizedName(options.skillName),
    );
    if (existing) return receiptFromRecord(existing, "already_quarantined", false);
    throw new CLIError(
      `Installed skill "${options.skillName}" was not found.`,
      "FILE_NOT_FOUND",
      "selftune skills audit --json",
    );
  }
  if (matches.length > 1) {
    throw new CLIError(
      `Skill "${options.skillName}" is installed in multiple registries.`,
      "INVALID_FLAG",
      "Rerun with --skill-path <exact-SKILL.md-path> from selftune skills audit --json.",
    );
  }

  const installed = matches[0]!;
  if (
    normalizedName(installed.name) === "selftune" ||
    installed.skill_scope === "system" ||
    installed.skill_scope === "admin"
  ) {
    throw new CLIError(
      `Skill "${installed.name}" is protected and cannot be quarantined by SelfTune.`,
      "GUARD_BLOCKED",
      "Keep the skill active or use its platform administrator workflow.",
      2,
    );
  }

  const preparedRecord = listQuarantineRecords(quarantineRoot).find(
    (candidate) =>
      candidate.status === "preparing" &&
      resolve(candidate.original_package_path) === resolve(installed.package_path),
  );
  const id =
    preparedRecord?.quarantine_id ??
    `${installed.name.replace(/[^A-Za-z0-9_-]/g, "-")}--${randomUUID()}`;
  const quarantinedPackagePath =
    preparedRecord?.quarantined_package_path ?? join(quarantineRoot, id, "package");
  const record: QuarantineRecord = preparedRecord ?? {
    schema_version: 1,
    quarantine_id: id,
    status: "preparing",
    skill_name: installed.name,
    skill_scope: installed.skill_scope,
    original_package_path: installed.package_path,
    original_skill_path: installed.skill_path,
    quarantined_package_path: quarantinedPackagePath,
    package_version_hash: computeSkillVersionHash(installed.skill_path) ?? null,
    quarantined_at: (options.now ?? new Date()).toISOString(),
    restored_at: null,
  };

  if (options.dryRun) {
    return receiptFromRecord({ ...record, status: "quarantined" }, "quarantined", true);
  }

  writeRecord(quarantineRoot, record);
  try {
    movePackage(installed.package_path, quarantinedPackagePath);
    const completed = { ...record, status: "quarantined" as const };
    writeRecord(quarantineRoot, completed);
    return receiptFromRecord(completed, "quarantined", false);
  } catch (error) {
    if (entryExists(installed.package_path)) {
      rmSync(dirname(recordPath(quarantineRoot, id)), { recursive: true, force: true });
    }
    throw new CLIError(
      `Could not quarantine "${installed.name}": ${error instanceof Error ? error.message : String(error)}`,
      "OPERATION_FAILED",
      `Retry selftune skills quarantine --skill ${installed.name} --yes --json`,
    );
  }
}

export function restoreQuarantinedSkill(options: {
  quarantineId: string;
  quarantineRoot?: string;
  dryRun?: boolean;
  now?: Date;
}): QuarantineReceipt {
  const quarantineRoot = resolve(options.quarantineRoot ?? QUARANTINE_DIR);
  const record = readRecord(quarantineRoot, options.quarantineId);
  const hasOriginal = entryExists(record.original_package_path);
  const hasQuarantine = entryExists(record.quarantined_package_path);

  if (record.status === "restored" || (hasOriginal && !hasQuarantine)) {
    if (record.status !== "restored" && !options.dryRun) {
      writeRecord(quarantineRoot, {
        ...record,
        status: "restored",
        restored_at: (options.now ?? new Date()).toISOString(),
      });
    }
    return receiptFromRecord(record, "already_restored", false);
  }
  if (hasOriginal && hasQuarantine) {
    throw new CLIError(
      `Restore destination already exists: ${record.original_package_path}`,
      "GUARD_BLOCKED",
      "Resolve the destination conflict without overwriting either package, then retry restore.",
      2,
    );
  }
  if (!hasQuarantine) {
    throw new CLIError(
      `Quarantined package is missing: ${record.quarantined_package_path}`,
      "FILE_NOT_FOUND",
      "Inspect the quarantine receipt and local backups before retrying.",
    );
  }
  if (options.dryRun) return receiptFromRecord(record, "restored", true);

  mkdirSync(dirname(record.original_package_path), { recursive: true });
  writeRecord(quarantineRoot, { ...record, status: "restoring" });
  try {
    movePackage(record.quarantined_package_path, record.original_package_path);
    const restored = {
      ...record,
      status: "restored" as const,
      restored_at: (options.now ?? new Date()).toISOString(),
    };
    writeRecord(quarantineRoot, restored);
    return receiptFromRecord(restored, "restored", false);
  } catch (error) {
    throw new CLIError(
      `Could not restore "${record.skill_name}": ${error instanceof Error ? error.message : String(error)}`,
      "OPERATION_FAILED",
      `Retry selftune skills restore --id ${record.quarantine_id} --json`,
    );
  }
}

function parsePositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CLIError(
      `${flag} must be a positive integer.`,
      "INVALID_FLAG",
      `selftune skills audit ${flag} ${fallback} --json`,
    );
  }
  return Number(value);
}

function printAudit(result: PortfolioAuditResult): void {
  emit(`Installed skill portfolio: ${result.installed_count} packages`);
  for (const skill of result.skills) {
    emit(`\n${skill.skill_name} [${skill.classification}]`);
    emit(`  Recommendation: ${skill.recommendation}`);
    emit(`  ${skill.reason}`);
    emit(`  Path: ${skill.skill_path}`);
  }
}

function printQuarantined(records: QuarantineRecord[]): void {
  if (records.length === 0) {
    emit("No skills are currently quarantined.");
    return;
  }
  emit(`Quarantined skills: ${records.length}`);
  for (const record of records) {
    emit(`- ${record.skill_name} (${record.quarantine_id})`);
  }
}

function printReceipt(receipt: QuarantineReceipt): void {
  emit(`${receipt.skill_name}: ${receipt.status}`);
  emit(`  Quarantine ID: ${receipt.quarantine_id}`);
  if (receipt.undo_command) emit(`  Undo: ${receipt.undo_command}`);
}

function emit(value: string): void {
  process.stdout.write(`${value}\n`);
}

function printHelp(): void {
  emit(`selftune skills — Audit and manage the installed skill portfolio

Usage:
  selftune skills audit [--min-sessions N] [--inactive-days N] [--search-dir PATH] [--json]
  selftune skills quarantine --skill NAME [--skill-path PATH] --yes [--dry-run] [--json]
  selftune skills quarantined [--json]
  selftune skills restore --id ID [--dry-run] [--json]

Safety:
  Audits never remove packages. Quarantine requires explicit approval, moves the
  complete package outside active registries, and returns an exact restore command.`);
}

export async function cliMain(): Promise<void> {
  const subcommand = process.argv[2];
  const args = process.argv.slice(3);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand === "audit") {
    const { values } = parseArgs({
      args,
      options: {
        "min-sessions": { type: "string" },
        "inactive-days": { type: "string" },
        "search-dir": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    const minSessions = parsePositiveInteger(
      values["min-sessions"],
      "--min-sessions",
      DEFAULT_MIN_SESSIONS,
    );
    const inactiveDays = parsePositiveInteger(
      values["inactive-days"],
      "--inactive-days",
      DEFAULT_INACTIVE_DAYS,
    );
    const searchDirs = [
      ...getDefaultSkillSearchDirs(),
      ...(values["search-dir"] ?? []).map((value) => resolve(value)),
    ];
    const db = getDb();
    const installed = findInstalledSkillPackages(searchDirs);
    const skillRecords = querySkillUsageRecords(db);
    const queryRecords = queryQueryLog(db);
    const consolidations = detectConsolidationCandidates(
      installed,
      skillRecords,
      queryRecords,
      searchDirs,
    );
    const result = buildPortfolioAudit(
      installed,
      queryTrustedSkillObservationRows(db),
      querySessionTelemetry(db) as SessionTelemetryRecord[],
      { minSessions, inactiveDays, consolidationSkillNames: consolidations },
    );
    if (values.json) emit(JSON.stringify(result, null, 2));
    else printAudit(result);
    return;
  }

  if (subcommand === "quarantined") {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    const records = listQuarantinedSkills();
    if (values.json) emit(JSON.stringify({ quarantined: records }, null, 2));
    else printQuarantined(records);
    return;
  }

  if (subcommand === "quarantine") {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        "skill-path": { type: "string" },
        yes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    if (!values.skill) {
      throw new CLIError(
        "--skill NAME is required.",
        "MISSING_FLAG",
        "selftune skills quarantine --skill NAME --dry-run --json",
      );
    }
    if (!values.yes && !values["dry-run"]) {
      throw new CLIError(
        "Quarantine requires explicit approval through --yes.",
        "GUARD_BLOCKED",
        `Review selftune skills audit --json, then run selftune skills quarantine --skill ${values.skill} --yes --json.`,
        2,
      );
    }
    const searchDirs = getDefaultSkillSearchDirs();
    if (values["skill-path"]) {
      const explicitPath = resolve(values["skill-path"]);
      searchDirs.push(
        explicitPath.toLowerCase().endsWith("skill.md")
          ? dirname(dirname(explicitPath))
          : dirname(explicitPath),
      );
    }
    const installed = findInstalledSkillPackages(searchDirs);
    const receipt = quarantineSkill({
      installedSkills: installed,
      skillName: values.skill,
      skillPath: values["skill-path"],
      dryRun: values["dry-run"],
    });
    if (values.json) emit(JSON.stringify(receipt, null, 2));
    else printReceipt(receipt);
    return;
  }

  if (subcommand === "restore") {
    const { values } = parseArgs({
      args,
      options: {
        id: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    if (!values.id) {
      throw new CLIError(
        "--id ID is required.",
        "MISSING_FLAG",
        "selftune skills quarantined --json",
      );
    }
    const receipt = restoreQuarantinedSkill({
      quarantineId: values.id,
      dryRun: values["dry-run"],
    });
    if (values.json) emit(JSON.stringify(receipt, null, 2));
    else printReceipt(receipt);
    return;
  }

  throw new CLIError(
    `Unknown skills subcommand: ${subcommand}`,
    "UNKNOWN_COMMAND",
    "selftune skills --help",
  );
}

if (import.meta.main) cliMain().catch(handleCLIError);
