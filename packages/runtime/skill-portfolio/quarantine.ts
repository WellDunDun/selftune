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
import { basename, dirname, join, resolve, sep } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { QuarantineReceipt, QuarantineRecord } from "../dashboard-contract.js";
import { CLIError } from "../utils/cli-error.js";
import { computeSkillVersionHash, type InstalledSkillPackage } from "../utils/skill-discovery.js";
export const QUARANTINE_DIR = join(SELFTUNE_CONFIG_DIR, "quarantine");

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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
  quarantineId?: string;
  expectedPackageVersionHash?: string | null;
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
    const existing = listQuarantinedSkills(quarantineRoot).find((record) =>
      options.quarantineId
        ? record.quarantine_id === options.quarantineId
        : normalizedName(record.skill_name) === normalizedName(options.skillName),
    );
    if (existing) {
      if (
        options.expectedPackageVersionHash !== undefined &&
        existing.package_version_hash !== options.expectedPackageVersionHash
      ) {
        throw new CLIError(
          `Quarantined skill "${existing.skill_name}" does not match the reviewed package.`,
          "GUARD_BLOCKED",
          "Prepare a fresh removal decision before changing this package.",
          2,
        );
      }
      return receiptFromRecord(existing, "already_quarantined", false);
    }
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
  const currentPackageVersionHash = computeSkillVersionHash(installed.skill_path) ?? null;
  if (
    options.expectedPackageVersionHash !== undefined &&
    currentPackageVersionHash !== options.expectedPackageVersionHash
  ) {
    throw new CLIError(
      `Installed skill "${installed.name}" changed after removal review.`,
      "GUARD_BLOCKED",
      "Prepare a fresh removal decision before changing this package.",
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
    options.quarantineId ??
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
    package_version_hash: currentPackageVersionHash,
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
  const archivedIsLink = lstatSync(record.quarantined_package_path).isSymbolicLink();
  const quarantinedHash = archivedIsLink
    ? record.package_version_hash
    : computeSkillVersionHash(join(record.quarantined_package_path, "SKILL.md"));
  if (record.package_version_hash && quarantinedHash !== record.package_version_hash) {
    throw new CLIError(
      `Archived package integrity check failed for "${record.skill_name}".`,
      "GUARD_BLOCKED",
      "Keep both the archive receipt and changed package for manual recovery; SelfTune will not restore altered content automatically.",
      2,
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
