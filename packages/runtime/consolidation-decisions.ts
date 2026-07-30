import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { cacheSkillPackage, libraryPackagePath } from "@selftune/library";
import * as Schema from "effect/Schema";

import {
  createDurableDecisionStore,
  DEFAULT_DECISION_EXPIRY_MS,
  type DurableDecisionAuditEntry,
  type DurableDecisionBase,
  type DurableDecisionOptions,
  type DurableDecisionStatus,
} from "./durable-decisions.js";
import { quarantineSkill, restoreQuarantinedSkill } from "./skill-portfolio/quarantine.js";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "./utils/skill-discovery.js";
import { inferSkillHarness } from "./utils/skill-harness.js";

export type SkillConsolidationDecisionStatus = DurableDecisionStatus;
export type SkillConsolidationDecisionAuditEntry = DurableDecisionAuditEntry;

export interface SkillConsolidationTarget {
  readonly action: "replace_with_link" | "archive_copy";
  readonly harness: string | null;
  readonly project_root: string | null;
  readonly original_package_path: string;
  readonly original_skill_path: string;
  readonly original_content_hash: string;
  readonly archive_destination: string;
  readonly quarantine_id: string;
}

export interface SkillConsolidationReceipt {
  readonly receipt_id: string;
  readonly status: "applied" | "rolled_back";
  readonly quarantine_ids: readonly string[];
  readonly linked_paths: readonly string[];
  readonly applied_at: string;
  readonly rolled_back_at: string | null;
  readonly rollback_behavior: string;
}

export interface SkillConsolidationDecision extends DurableDecisionBase {
  readonly requested_action: "consolidate_skill_installations";
  readonly skill_name: string;
  readonly canonical: {
    readonly source_package_path: string;
    readonly source_skill_path: string;
    readonly content_hash: string;
    readonly library_package_path: string;
  };
  readonly targets: readonly SkillConsolidationTarget[];
  readonly receipt: SkillConsolidationReceipt | null;
}

export interface SkillConsolidationDecisionOptions extends DurableDecisionOptions {
  readonly searchDirs?: readonly string[];
  readonly quarantineRoot?: string;
  readonly installedSkills?: readonly InstalledSkillPackage[];
}

const Target = Schema.Struct({
  action: Schema.Literals(["replace_with_link", "archive_copy"]),
  harness: Schema.NullOr(Schema.String),
  project_root: Schema.NullOr(Schema.String),
  original_package_path: Schema.String,
  original_skill_path: Schema.String,
  original_content_hash: Schema.String,
  archive_destination: Schema.String,
  quarantine_id: Schema.String,
});
const Receipt = Schema.Struct({
  receipt_id: Schema.String,
  status: Schema.Literals(["applied", "rolled_back"]),
  quarantine_ids: Schema.Array(Schema.String),
  linked_paths: Schema.Array(Schema.String),
  applied_at: Schema.String,
  rolled_back_at: Schema.NullOr(Schema.String),
  rollback_behavior: Schema.String,
});
const Audit = Schema.Struct({
  event: Schema.Literals(["prepared", "approved", "declined", "stale", "expired", "failed"]),
  at: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
const Decision = Schema.Struct({
  schema_version: Schema.Literal(1),
  approval_id: Schema.String,
  requested_action: Schema.Literal("consolidate_skill_installations"),
  status: Schema.Literals(["pending", "approved", "declined", "stale", "expired", "failed"]),
  skill_name: Schema.String,
  canonical: Schema.Struct({
    source_package_path: Schema.String,
    source_skill_path: Schema.String,
    content_hash: Schema.String,
    library_package_path: Schema.String,
  }),
  targets: Schema.Array(Target),
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Receipt),
  failure: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  audit: Schema.Array(Audit),
});

const store = createDurableDecisionStore<SkillConsolidationDecision>({
  directory: "skill-consolidations",
  notFoundMessage: "Skill consolidation decision was not found.",
  decode: Schema.decodeUnknownSync(Decision),
  expiryFailure: {
    code: "CONSOLIDATION_APPROVAL_EXPIRED",
    message: "This consolidation review expired. Refresh the Library recommendation.",
  },
});

function timestamp(options: SkillConsolidationDecisionOptions): Date {
  return new Date(options.now ?? Date.now());
}

function installed(options: SkillConsolidationDecisionOptions): readonly InstalledSkillPackage[] {
  return (
    options.installedSkills ??
    findInstalledSkillPackages([...(options.searchDirs ?? getDefaultSkillSearchDirs())])
  );
}

function matchingPackage(
  packages: readonly InstalledSkillPackage[],
  skillName: string,
  skillPath: string,
): InstalledSkillPackage {
  const requested = resolve(skillPath);
  const match = packages.find(
    (candidate) =>
      candidate.name.trim().toLowerCase() === skillName.trim().toLowerCase() &&
      (resolve(candidate.skill_path) === requested ||
        resolve(candidate.package_path) === requested),
  );
  if (!match) throw new Error(`Installed skill location was not found: ${requested}`);
  if (match.skill_scope === "admin" || match.skill_scope === "system") {
    throw new Error(`Protected skill location cannot be consolidated: ${match.package_path}`);
  }
  return match;
}

function packageHash(skill: InstalledSkillPackage): string {
  const hash = computeSkillVersionHash(skill.skill_path);
  if (!hash) throw new Error(`Could not verify the skill package at ${skill.package_path}.`);
  return hash;
}

export function prepareSkillConsolidationDecision(
  input: {
    readonly skillName: string;
    readonly canonicalSkillPath: string;
    readonly targetSkillPaths: readonly string[];
  },
  options: SkillConsolidationDecisionOptions = {},
): SkillConsolidationDecision {
  if (input.skillName.trim().toLowerCase() === "selftune") {
    throw new Error("SelfTune is protected and cannot be consolidated.");
  }
  const packages = installed(options);
  const canonical = matchingPackage(packages, input.skillName, input.canonicalSkillPath);
  const contentHash = packageHash(canonical);
  const expectedLibraryPath = libraryPackagePath(contentHash, canonical.name, {
    configRoot: options.configRoot,
  });
  const approvalId = randomUUID();
  const targetPaths = [...new Set(input.targetSkillPaths.map((path) => resolve(path)))];
  const targets = targetPaths.flatMap((targetPath, index): SkillConsolidationTarget[] => {
    const target = matchingPackage(packages, input.skillName, targetPath);
    const targetHash = packageHash(target);
    if (
      target.skill_scope === "project" &&
      targetHash === contentHash &&
      target.linked_package_path &&
      resolve(target.linked_package_path) === resolve(expectedLibraryPath)
    ) {
      return [];
    }
    const quarantineId = `${input.skillName.replace(/[^A-Za-z0-9_-]/g, "-")}--${approvalId}-${index}`;
    const preview = quarantineSkill({
      installedSkills: [...packages],
      skillName: input.skillName,
      skillPath: target.skill_path,
      quarantineRoot: options.quarantineRoot,
      quarantineId,
      expectedPackageVersionHash: targetHash,
      dryRun: true,
      now: timestamp(options),
    });
    return [
      {
        action: target.skill_scope === "project" ? "replace_with_link" : "archive_copy",
        harness: inferSkillHarness(target.registry_dir),
        project_root: target.skill_project_root ?? null,
        original_package_path: target.package_path,
        original_skill_path: target.skill_path,
        original_content_hash: targetHash,
        archive_destination: preview.quarantined_package_path,
        quarantine_id: quarantineId,
      },
    ];
  });
  if (targets.length === 0) throw new Error("These installations are already consolidated.");
  const created = timestamp(options);
  const createdAt = created.toISOString();
  return store.persist(
    {
      schema_version: 1,
      approval_id: approvalId,
      requested_action: "consolidate_skill_installations",
      status: "pending",
      skill_name: canonical.name,
      canonical: {
        source_package_path: canonical.package_path,
        source_skill_path: canonical.skill_path,
        content_hash: contentHash,
        library_package_path: expectedLibraryPath,
      },
      targets,
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: new Date(
        created.getTime() + (options.decisionExpiryMs ?? DEFAULT_DECISION_EXPIRY_MS),
      ).toISOString(),
      decided_at: null,
      receipt: null,
      failure: null,
      audit: [{ event: "prepared", at: createdAt, reason: null }],
    },
    options,
  );
}

export function listSkillConsolidationDecisions(
  options: SkillConsolidationDecisionOptions = {},
): SkillConsolidationDecision[] {
  return store.list(options);
}

function validateDecision(
  decision: SkillConsolidationDecision,
  options: SkillConsolidationDecisionOptions,
): string | null {
  const packages = installed(options);
  try {
    const canonical = matchingPackage(
      packages,
      decision.skill_name,
      decision.canonical.source_skill_path,
    );
    if (packageHash(canonical) !== decision.canonical.content_hash) {
      return "The canonical package changed after review.";
    }
    for (const target of decision.targets) {
      const current = matchingPackage(packages, decision.skill_name, target.original_skill_path);
      if (packageHash(current) !== target.original_content_hash) {
        return `The installation at ${target.original_package_path} changed after review.`;
      }
    }
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The reviewed installations changed.";
  }
}

function linkMatches(targetPath: string, sourcePath: string): boolean {
  try {
    return (
      lstatSync(targetPath).isSymbolicLink() &&
      resolve(dirname(targetPath), readlinkSync(targetPath)) === resolve(sourcePath)
    );
  } catch {
    return false;
  }
}

function restoreAppliedTargets(
  decision: SkillConsolidationDecision,
  linkedPaths: readonly string[],
  quarantineIds: readonly string[],
  options: SkillConsolidationDecisionOptions,
): void {
  for (const linkedPath of linkedPaths.toReversed()) {
    if (linkMatches(linkedPath, decision.canonical.library_package_path)) {
      rmSync(linkedPath, { force: false });
    }
  }
  for (const quarantineId of quarantineIds.toReversed()) {
    restoreQuarantinedSkill({
      quarantineId,
      quarantineRoot: options.quarantineRoot,
      now: timestamp(options),
    });
  }
}

export async function decideSkillConsolidation(
  approvalId: string,
  action: "approve" | "decline",
  options: SkillConsolidationDecisionOptions = {},
): Promise<SkillConsolidationDecision> {
  return store.decide(approvalId, action, options, async (decision) => {
    const staleReason = validateDecision(decision, options);
    if (staleReason) {
      return {
        status: "stale",
        failure: { code: "CONSOLIDATION_STALE", message: staleReason },
        reason: staleReason,
      };
    }
    const linkedPaths: string[] = [];
    const quarantineIds: string[] = [];
    try {
      const cached = cacheSkillPackage(
        { name: decision.skill_name, package_path: decision.canonical.source_package_path },
        { configRoot: options.configRoot, now: timestamp(options) },
      );
      if (
        cached.content_hash !== decision.canonical.content_hash ||
        resolve(cached.library_package_path) !== resolve(decision.canonical.library_package_path)
      ) {
        throw new Error("The canonical Library package did not match the reviewed revision.");
      }
      const packages = installed(options);
      for (const target of decision.targets) {
        quarantineSkill({
          installedSkills: [...packages],
          skillName: decision.skill_name,
          skillPath: target.original_skill_path,
          quarantineRoot: options.quarantineRoot,
          quarantineId: target.quarantine_id,
          expectedPackageVersionHash: target.original_content_hash,
          now: timestamp(options),
        });
        quarantineIds.push(target.quarantine_id);
        if (target.action === "replace_with_link") {
          mkdirSync(dirname(target.original_package_path), { recursive: true });
          symlinkSync(decision.canonical.library_package_path, target.original_package_path, "dir");
          linkedPaths.push(target.original_package_path);
        }
      }
      const appliedAt = timestamp(options).toISOString();
      const receipt: SkillConsolidationReceipt = {
        receipt_id: randomUUID(),
        status: "applied",
        quarantine_ids: quarantineIds,
        linked_paths: linkedPaths,
        applied_at: appliedAt,
        rolled_back_at: null,
        rollback_behavior:
          "Rollback removes SelfTune-owned project links and restores every archived installation to its exact original path.",
      };
      return { status: "approved", receipt };
    } catch (cause) {
      try {
        restoreAppliedTargets(decision, linkedPaths, quarantineIds, options);
      } catch {
        // The durable decision retains every reviewed archive path for manual recovery.
      }
      const message =
        cause instanceof Error ? cause.message : "Consolidation could not be applied.";
      return {
        status: "failed",
        failure: { code: "CONSOLIDATION_APPLY_FAILED", message },
        reason: message,
      };
    }
  });
}

export function rollbackSkillConsolidationDecision(
  approvalId: string,
  options: SkillConsolidationDecisionOptions = {},
): SkillConsolidationDecision {
  const decision = store.get(approvalId, options);
  if (decision.status !== "approved" || !decision.receipt) {
    throw new Error("Only an approved consolidation decision can be rolled back.");
  }
  if (decision.receipt.status === "rolled_back") return decision;
  for (const linkedPath of decision.receipt.linked_paths) {
    if (!linkMatches(linkedPath, decision.canonical.library_package_path)) {
      throw new Error(`A consolidated project link changed after apply: ${linkedPath}`);
    }
  }
  for (const target of decision.targets) {
    if (!existsSync(target.archive_destination)) {
      throw new Error(`An archived installation is missing: ${target.archive_destination}`);
    }
    if (
      computeSkillVersionHash(resolve(target.archive_destination, "SKILL.md")) !==
      target.original_content_hash
    ) {
      throw new Error(
        `An archived installation changed after apply: ${target.archive_destination}`,
      );
    }
  }
  restoreAppliedTargets(
    decision,
    decision.receipt.linked_paths,
    decision.receipt.quarantine_ids,
    options,
  );
  return store.persist(
    {
      ...decision,
      updated_at: timestamp(options).toISOString(),
      receipt: {
        ...decision.receipt,
        status: "rolled_back",
        rolled_back_at: timestamp(options).toISOString(),
      },
    },
    options,
  );
}
