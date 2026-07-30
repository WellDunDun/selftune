import { randomUUID } from "node:crypto";

import * as Schema from "effect/Schema";

import {
  createDurableDecisionStore,
  DEFAULT_DECISION_EXPIRY_MS,
  type DurableDecisionAuditEntry,
  type DurableDecisionBase,
  type DurableDecisionOptions,
  type DurableDecisionStatus,
} from "./durable-decisions.js";
import { quarantineSkill, type QuarantineReceipt } from "./skill-portfolio.js";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "./utils/skill-discovery.js";

export type RemovalDecisionStatus = DurableDecisionStatus;
export type RemovalDecisionAuditEntry = DurableDecisionAuditEntry;

export interface RemovalDecisionLocation {
  readonly connection: string | null;
  readonly original_package_path: string;
  readonly original_skill_path: string;
  readonly archive_destination: string;
  readonly package_version_hash: string | null;
  readonly quarantine_id: string;
  readonly recovery: string;
}

export interface RemovalDecision extends DurableDecisionBase {
  readonly requested_action: "quarantine_skill";
  readonly skill_name: string;
  readonly locations: readonly RemovalDecisionLocation[];
  readonly receipt: { readonly quarantines: readonly QuarantineReceipt[] } | null;
}

export interface RemovalDecisionOptions extends DurableDecisionOptions {
  readonly installedSkills?: readonly InstalledSkillPackage[];
  readonly searchDirs?: readonly string[];
  readonly quarantineRoot?: string;
}

const Receipt = Schema.Struct({
  success: Schema.Literal(true),
  status: Schema.Literals(["quarantined", "already_quarantined", "restored", "already_restored"]),
  skill_name: Schema.String,
  quarantine_id: Schema.String,
  original_package_path: Schema.String,
  quarantined_package_path: Schema.String,
  package_version_hash: Schema.NullOr(Schema.String),
  dry_run: Schema.Boolean,
  undo_command: Schema.NullOr(Schema.String),
});
const Audit = Schema.Struct({
  event: Schema.Literals(["prepared", "approved", "declined", "stale", "expired", "failed"]),
  at: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
const Decision = Schema.Struct({
  schema_version: Schema.Literal(1),
  approval_id: Schema.String,
  requested_action: Schema.Literal("quarantine_skill"),
  status: Schema.Literals(["pending", "approved", "declined", "stale", "expired", "failed"]),
  skill_name: Schema.String,
  locations: Schema.Array(
    Schema.Struct({
      connection: Schema.NullOr(Schema.String),
      original_package_path: Schema.String,
      original_skill_path: Schema.String,
      archive_destination: Schema.String,
      package_version_hash: Schema.NullOr(Schema.String),
      quarantine_id: Schema.String,
      recovery: Schema.String,
    }),
  ),
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Schema.Struct({ quarantines: Schema.Array(Receipt) })),
  failure: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  audit: Schema.Array(Audit),
});

const store = createDurableDecisionStore<RemovalDecision>({
  directory: "skill-removals",
  notFoundMessage: "Skill removal decision was not found.",
  decode: Schema.decodeUnknownSync(Decision),
  expiryFailure: {
    code: "REMOVAL_APPROVAL_EXPIRED",
    message: "This removal approval expired. Review the current locations again.",
  },
});

function installed(options: RemovalDecisionOptions): readonly InstalledSkillPackage[] {
  return (
    options.installedSkills ??
    findInstalledSkillPackages([...(options.searchDirs ?? getDefaultSkillSearchDirs())])
  );
}

function timestamp(options: RemovalDecisionOptions): Date {
  return new Date(options.now ?? Date.now());
}

export function prepareRemovalDecision(
  input: {
    readonly skillName: string;
    readonly locations: ReadonlyArray<{
      readonly skillPath: string;
      readonly connection: string | null;
    }>;
  },
  options: RemovalDecisionOptions = {},
): RemovalDecision {
  const approvalId = randomUUID();
  const installedSkills = installed(options);
  const locations = input.locations.map((location, index): RemovalDecisionLocation => {
    const quarantineId = `${input.skillName.replace(/[^A-Za-z0-9_-]/g, "-")}--${approvalId}-${index}`;
    const preview = quarantineSkill({
      installedSkills: [...installedSkills],
      skillName: input.skillName,
      skillPath: location.skillPath,
      quarantineRoot: options.quarantineRoot,
      quarantineId,
      dryRun: true,
      now: timestamp(options),
    });
    return {
      connection: location.connection,
      original_package_path: preview.original_package_path,
      original_skill_path: location.skillPath,
      archive_destination: preview.quarantined_package_path,
      package_version_hash: preview.package_version_hash,
      quarantine_id: preview.quarantine_id,
      recovery: `Restore from quarantine receipt ${preview.quarantine_id}.`,
    };
  });
  if (locations.length === 0) throw new Error("This skill has no removable locations.");
  const created = timestamp(options);
  const createdAt = created.toISOString();
  return store.persist(
    {
      schema_version: 1,
      approval_id: approvalId,
      requested_action: "quarantine_skill",
      status: "pending",
      skill_name: input.skillName,
      locations,
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

export function getRemovalDecision(
  approvalId: string,
  options: RemovalDecisionOptions = {},
): RemovalDecision {
  return store.get(approvalId, options);
}

export function listRemovalDecisions(options: RemovalDecisionOptions = {}): RemovalDecision[] {
  return store.list(options);
}

export async function decideRemoval(
  approvalId: string,
  action: "approve" | "decline",
  options: RemovalDecisionOptions = {},
): Promise<RemovalDecision> {
  return store.decide(approvalId, action, options, async (decision) => {
    const installedSkills = installed(options);
    for (const location of decision.locations) {
      try {
        quarantineSkill({
          installedSkills: [...installedSkills],
          skillName: decision.skill_name,
          skillPath: location.original_skill_path,
          quarantineRoot: options.quarantineRoot,
          quarantineId: location.quarantine_id,
          expectedPackageVersionHash: location.package_version_hash,
          dryRun: true,
          now: timestamp(options),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The reviewed removal changed.";
        return {
          status: "stale",
          failure: { code: "REMOVAL_STALE", message },
          reason: message,
        };
      }
    }

    const receipts: QuarantineReceipt[] = [];
    try {
      for (const location of decision.locations) {
        receipts.push(
          quarantineSkill({
            installedSkills: [...installedSkills],
            skillName: decision.skill_name,
            skillPath: location.original_skill_path,
            quarantineRoot: options.quarantineRoot,
            quarantineId: location.quarantine_id,
            expectedPackageVersionHash: location.package_version_hash,
            now: timestamp(options),
          }),
        );
      }
      return { status: "approved", receipt: { quarantines: receipts } };
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The skill could not be quarantined.";
      return {
        status: "failed",
        receipt: { quarantines: receipts },
        failure: { code: "REMOVAL_FAILED", message },
        reason: message,
      };
    }
  });
}
