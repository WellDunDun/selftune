import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as Schema from "effect/Schema";

import {
  createDurableDecisionStore,
  DEFAULT_DECISION_EXPIRY_MS,
  type DurableDecisionAuditEntry,
  type DurableDecisionBase,
  type DurableDecisionOptions,
  type DurableDecisionStatus,
} from "./durable-decisions.js";
import {
  applySkillSet,
  planSkillSet,
  rollbackSkillSet,
  type SkillSetPlanOperation,
  type SkillSetReceipt,
  type SkillSetServiceOptions,
} from "@selftune/library";
import { computeSkillVersionHash } from "./utils/skill-discovery.js";

export type SkillSetConflictDecisionStatus = DurableDecisionStatus;
export type SkillSetConflictDecisionAuditEntry = DurableDecisionAuditEntry;

export interface SkillSetConflictImpact {
  readonly harness: string;
  readonly skill_name: string;
  readonly target_path: string;
  readonly replacement_source_path: string;
  readonly current_fingerprint: string | null;
  readonly replacement_fingerprint: string;
  readonly backup_path: string;
  readonly rollback: string;
}

export interface SkillSetConflictRecoveryReceipt {
  readonly receipt_id: string;
  readonly status: "applied" | "rolled_back";
  readonly skill_set_receipt: Readonly<Omit<SkillSetReceipt, "operations">> & {
    readonly operations: readonly SkillSetReceipt["operations"][number][];
  };
  readonly overwritten: ReadonlyArray<{
    readonly target_path: string;
    readonly backup_path: string;
    readonly original_fingerprint: string | null;
  }>;
  readonly rollback_behavior: string;
  readonly applied_at: string;
  readonly rolled_back_at: string | null;
}

export interface SkillSetConflictDecision extends DurableDecisionBase {
  readonly requested_action: "replace_skill_set_conflicts";
  readonly skill_set_id: string;
  readonly skill_set_name: string;
  readonly skill_set_revision_hash: string;
  readonly project_root: string;
  readonly creates: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly impacts: readonly SkillSetConflictImpact[];
  readonly receipt: SkillSetConflictRecoveryReceipt | null;
}

export type SkillSetConflictDecisionOptions = SkillSetServiceOptions & DurableDecisionOptions;

const ReceiptOperation = Schema.Struct({
  harness: Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]),
  skill_name: Schema.String,
  content_hash: Schema.String,
  source_path: Schema.String,
  target_path: Schema.String,
  strategy: Schema.NullOr(Schema.Literals(["symlink", "copy"])),
  state: Schema.optional(Schema.Literals(["pending", "materialized"])),
  target_device: Schema.optional(Schema.String),
  target_inode: Schema.optional(Schema.String),
});
const SkillSetReceiptSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  receipt_id: Schema.String,
  set_id: Schema.String,
  set_name: Schema.String,
  set_revision_hash: Schema.String,
  project_root: Schema.String,
  status: Schema.Literals(["applying", "applied", "unchanged", "rolled_back"]),
  operations: Schema.Array(ReceiptOperation),
  applied_at: Schema.String,
  rolled_back_at: Schema.NullOr(Schema.String),
});
const Audit = Schema.Struct({
  event: Schema.Literals(["prepared", "approved", "declined", "stale", "expired", "failed"]),
  at: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
const RecoveryReceipt = Schema.Struct({
  receipt_id: Schema.String,
  status: Schema.Literals(["applied", "rolled_back"]),
  skill_set_receipt: SkillSetReceiptSchema,
  overwritten: Schema.Array(
    Schema.Struct({
      target_path: Schema.String,
      backup_path: Schema.String,
      original_fingerprint: Schema.NullOr(Schema.String),
    }),
  ),
  rollback_behavior: Schema.String,
  applied_at: Schema.String,
  rolled_back_at: Schema.NullOr(Schema.String),
});
const Decision = Schema.Struct({
  schema_version: Schema.Literal(1),
  approval_id: Schema.String,
  requested_action: Schema.Literal("replace_skill_set_conflicts"),
  status: Schema.Literals(["pending", "approved", "declined", "stale", "expired", "failed"]),
  skill_set_id: Schema.String,
  skill_set_name: Schema.String,
  skill_set_revision_hash: Schema.String,
  project_root: Schema.String,
  creates: Schema.Number,
  unchanged: Schema.Number,
  conflicts: Schema.Number,
  impacts: Schema.Array(
    Schema.Struct({
      harness: Schema.String,
      skill_name: Schema.String,
      target_path: Schema.String,
      replacement_source_path: Schema.String,
      current_fingerprint: Schema.NullOr(Schema.String),
      replacement_fingerprint: Schema.String,
      backup_path: Schema.String,
      rollback: Schema.String,
    }),
  ),
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(RecoveryReceipt),
  failure: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  audit: Schema.Array(Audit),
});

const store = createDurableDecisionStore<SkillSetConflictDecision>({
  directory: "skill-set-conflicts",
  notFoundMessage: "Skill Set conflict decision was not found.",
  decode: Schema.decodeUnknownSync(Decision),
  expiryFailure: {
    code: "SKILL_SET_APPROVAL_EXPIRED",
    message: "This Skill Set conflict approval expired. Preview the project again.",
  },
});

function timestamp(options: SkillSetConflictDecisionOptions): Date {
  return new Date(options.now ?? Date.now());
}

function stateRoot(options: SkillSetConflictDecisionOptions): string {
  return resolve(
    options.configRoot ??
      join(resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir()), ".selftune"),
  );
}

function conflictFingerprint(operation: SkillSetPlanOperation): string | null {
  return computeSkillVersionHash(join(operation.target_path, "SKILL.md")) ?? null;
}

export function prepareSkillSetConflictDecision(
  input: { readonly skillSetId: string; readonly projectRoot: string },
  options: SkillSetConflictDecisionOptions = {},
): SkillSetConflictDecision {
  const plan = planSkillSet({ set_id: input.skillSetId, project_root: input.projectRoot }, options);
  const conflictOperations = plan.operations.filter((operation) => operation.action === "conflict");
  if (conflictOperations.length === 0) throw new Error("This Skill Set preview has no conflicts.");
  const approvalId = randomUUID();
  const impacts = conflictOperations.map((operation, index): SkillSetConflictImpact => {
    const backupPath = join(
      stateRoot(options),
      "decisions",
      "skill-set-conflicts",
      "recovery",
      approvalId,
      String(index),
      "package",
    );
    return {
      harness: operation.harness,
      skill_name: operation.skill_name,
      target_path: operation.target_path,
      replacement_source_path: operation.source_path,
      current_fingerprint: conflictFingerprint(operation),
      replacement_fingerprint: operation.content_hash,
      backup_path: backupPath,
      rollback: `Remove the applied Skill Set receipt, then restore ${backupPath} to ${operation.target_path}.`,
    };
  });
  const created = timestamp(options);
  const createdAt = created.toISOString();
  return store.persist(
    {
      schema_version: 1,
      approval_id: approvalId,
      requested_action: "replace_skill_set_conflicts",
      status: "pending",
      skill_set_id: plan.set_id,
      skill_set_name: plan.set_name,
      skill_set_revision_hash: plan.set_revision_hash,
      project_root: plan.project_root,
      creates: plan.creates,
      unchanged: plan.unchanged,
      conflicts: plan.conflicts,
      impacts,
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

export function getSkillSetConflictDecision(
  approvalId: string,
  options: SkillSetConflictDecisionOptions = {},
): SkillSetConflictDecision {
  return store.get(approvalId, options);
}

export function listSkillSetConflictDecisions(
  options: SkillSetConflictDecisionOptions = {},
): SkillSetConflictDecision[] {
  return store.list(options);
}

function validateDecision(
  decision: SkillSetConflictDecision,
  options: SkillSetConflictDecisionOptions,
): string | null {
  const plan = planSkillSet(
    { set_id: decision.skill_set_id, project_root: decision.project_root },
    options,
  );
  if (plan.set_revision_hash !== decision.skill_set_revision_hash) {
    return "The Skill Set revision changed after review.";
  }
  for (const impact of decision.impacts) {
    const operation = plan.operations.find(
      (candidate) =>
        candidate.action === "conflict" && candidate.target_path === impact.target_path,
    );
    if (!operation || conflictFingerprint(operation) !== impact.current_fingerprint) {
      return `The conflict at ${impact.target_path} changed after review.`;
    }
  }
  return null;
}

function restoreBackups(decision: SkillSetConflictDecision): void {
  for (const impact of decision.impacts.toReversed()) {
    if (!existsSync(impact.backup_path)) continue;
    if (existsSync(impact.target_path))
      rmSync(impact.target_path, { recursive: true, force: true });
    mkdirSync(dirname(impact.target_path), { recursive: true });
    renameSync(impact.backup_path, impact.target_path);
  }
}

export async function decideSkillSetConflict(
  approvalId: string,
  action: "approve" | "decline",
  options: SkillSetConflictDecisionOptions = {},
): Promise<SkillSetConflictDecision> {
  return store.decide(approvalId, action, options, async (decision) => {
    const staleReason = validateDecision(decision, options);
    if (staleReason) {
      return {
        status: "stale",
        failure: { code: "SKILL_SET_CONFLICT_STALE", message: staleReason },
        reason: staleReason,
      };
    }
    try {
      for (const impact of decision.impacts) {
        mkdirSync(dirname(impact.backup_path), { recursive: true });
        renameSync(impact.target_path, impact.backup_path);
      }
      const skillSetReceipt = applySkillSet(
        { set_id: decision.skill_set_id, project_root: decision.project_root },
        options,
      );
      const appliedAt = timestamp(options).toISOString();
      const receipt: SkillSetConflictRecoveryReceipt = {
        receipt_id: randomUUID(),
        status: "applied",
        skill_set_receipt: skillSetReceipt,
        overwritten: decision.impacts.map((impact) => ({
          target_path: impact.target_path,
          backup_path: impact.backup_path,
          original_fingerprint: impact.current_fingerprint,
        })),
        rollback_behavior:
          "Rollback removes SelfTune-owned materializations, then restores every overwritten package from its decision backup.",
        applied_at: appliedAt,
        rolled_back_at: null,
      };
      return { status: "approved", receipt };
    } catch (cause) {
      restoreBackups(decision);
      const message =
        cause instanceof Error ? cause.message : "The Skill Set could not be applied.";
      return {
        status: "failed",
        failure: { code: "SKILL_SET_CONFLICT_APPLY_FAILED", message },
        reason: message,
      };
    }
  });
}

export function rollbackSkillSetConflictDecision(
  approvalId: string,
  options: SkillSetConflictDecisionOptions = {},
): SkillSetConflictDecision {
  const decision = store.get(approvalId, options);
  if (decision.status !== "approved" || !decision.receipt) {
    throw new Error("Only an approved Skill Set conflict decision can be rolled back.");
  }
  if (decision.receipt.status === "rolled_back") return decision;
  rollbackSkillSet(decision.receipt.skill_set_receipt.receipt_id, options);
  restoreBackups(decision);
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
