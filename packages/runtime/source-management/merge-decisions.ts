import * as Schema from "effect/Schema";

import {
  createDurableDecisionStore,
  DEFAULT_DECISION_EXPIRY_MS,
  type DurableDecisionAuditEntry,
  type DurableDecisionBase,
  type DurableDecisionOptions,
  type DurableDecisionStatus,
} from "../durable-decisions.js";
import {
  applyPreparedSkillSourceMerge,
  inspectPreparedSkillSourceMerge,
  prepareSkillSourceMerge,
  SkillSourceUpdateFailure,
  type SkillSourceMergePreview,
  type SkillSourceUpdateOptions,
  type SkillSourceUpdateReceipt,
} from "./update-adapter.js";

export type SourceMergeDecisionStatus = DurableDecisionStatus;
export type SourceMergeDecisionAuditEntry = DurableDecisionAuditEntry;

export interface SourceMergeDecision extends DurableDecisionBase {
  readonly merge_id: string;
  readonly requested_action: "apply_source_merge";
  readonly skill_name: string;
  readonly source: string;
  readonly harness_id: string;
  readonly agent: string;
  readonly model: string | null;
  readonly installed_hash: string;
  readonly latest_hash: string;
  readonly upstream_diff: string;
  readonly targets: ReadonlyArray<{
    readonly target_path: string;
    readonly observed_paths: readonly string[];
    readonly local_diff: string | null;
    readonly merged_diff: string;
    readonly conflict_files: readonly string[];
    readonly summary: string;
    readonly local_fingerprint: string;
    readonly candidate_fingerprint: string;
  }>;
  readonly receipt: SkillSourceUpdateReceipt | null;
}

export type SourceMergeDecisionOptions = SkillSourceUpdateOptions & DurableDecisionOptions;

const ReceiptOperation = Schema.Struct({
  target_path: Schema.String,
  observed_paths: Schema.Array(Schema.String),
  backup_path: Schema.String,
});
const Receipt = Schema.Struct({
  schema_version: Schema.Literal(1),
  receipt_id: Schema.String,
  skill_name: Schema.String,
  source: Schema.String,
  previous_hash: Schema.String,
  installed_hash: Schema.String,
  status: Schema.Literals(["applying", "applied", "failed"]),
  strategy: Schema.Literals(["abort", "take_upstream", "agent_merge"]),
  operations: Schema.Array(ReceiptOperation),
  applied_at: Schema.String,
});
const AuditEntry = Schema.Struct({
  event: Schema.Literals(["prepared", "approved", "declined", "stale", "expired", "failed"]),
  at: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
const Decision = Schema.Struct({
  schema_version: Schema.Literal(1),
  approval_id: Schema.String,
  merge_id: Schema.String,
  requested_action: Schema.Literal("apply_source_merge"),
  status: Schema.Literals(["pending", "approved", "declined", "stale", "expired", "failed"]),
  skill_name: Schema.String,
  source: Schema.String,
  harness_id: Schema.String,
  agent: Schema.String,
  model: Schema.NullOr(Schema.String),
  installed_hash: Schema.String,
  latest_hash: Schema.String,
  upstream_diff: Schema.String,
  targets: Schema.Array(
    Schema.Struct({
      target_path: Schema.String,
      observed_paths: Schema.Array(Schema.String),
      local_diff: Schema.NullOr(Schema.String),
      merged_diff: Schema.String,
      conflict_files: Schema.Array(Schema.String),
      summary: Schema.String,
      local_fingerprint: Schema.String,
      candidate_fingerprint: Schema.String,
    }),
  ),
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Receipt),
  failure: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  audit: Schema.Array(AuditEntry),
});

function now(options: SourceMergeDecisionOptions): Date {
  return new Date(options.now ?? Date.now());
}

const sourceMergeDecisionStore = createDurableDecisionStore<SourceMergeDecision>({
  directory: "source-merges",
  notFoundMessage: "Source merge decision was not found.",
  schema: Decision,
  expiryFailure: {
    code: "APPROVAL_EXPIRED",
    message: "This source merge approval expired. Prepare a fresh candidate.",
  },
});

export function getSourceMergeDecision(
  approvalId: string,
  options: SourceMergeDecisionOptions = {},
): SourceMergeDecision {
  return sourceMergeDecisionStore.get(approvalId, options);
}

export function listSourceMergeDecisions(
  options: SourceMergeDecisionOptions = {},
): SourceMergeDecision[] {
  return sourceMergeDecisionStore.list(options);
}

export async function prepareSourceMergeDecision(
  input: {
    readonly skillName: string;
    readonly harnessId: string;
    readonly agent: string;
    readonly model: string | null;
  },
  options: SourceMergeDecisionOptions = {},
): Promise<{
  readonly approval_id: string;
  readonly decision: SourceMergeDecision;
  readonly preview: SkillSourceMergePreview;
}> {
  const preview = await prepareSkillSourceMerge(input.skillName, input.agent, input.model, options);
  const material = inspectPreparedSkillSourceMerge(preview.merge_id, options);
  const created = now(options);
  const createdAt = created.toISOString();
  const decision: SourceMergeDecision = {
    schema_version: 1,
    approval_id: preview.merge_id,
    merge_id: preview.merge_id,
    requested_action: "apply_source_merge",
    status: "pending",
    skill_name: material.skill_name,
    source: material.source,
    harness_id: input.harnessId,
    agent: material.agent,
    model: material.model,
    installed_hash: material.installed_hash,
    latest_hash: material.latest_hash,
    upstream_diff: material.upstream_diff,
    targets: material.targets,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: new Date(
      created.getTime() + (options.decisionExpiryMs ?? DEFAULT_DECISION_EXPIRY_MS),
    ).toISOString(),
    decided_at: null,
    receipt: null,
    failure: null,
    audit: [{ event: "prepared", at: createdAt, reason: null }],
  };
  sourceMergeDecisionStore.persist(decision, options);
  return { approval_id: decision.approval_id, decision, preview };
}

export async function decideSourceMerge(
  approvalId: string,
  action: "approve" | "decline",
  options: SourceMergeDecisionOptions = {},
): Promise<SourceMergeDecision> {
  return sourceMergeDecisionStore.decide(approvalId, action, options, async (latest) => {
    try {
      const receipt = await applyPreparedSkillSourceMerge(latest.merge_id, options);
      return { status: "approved", receipt };
    } catch (cause) {
      const error = cause instanceof SkillSourceUpdateFailure ? cause : null;
      const stale = error?.code === "MERGE_STALE" || error?.code === "MERGE_INVALID";
      const message = stale
        ? `${error?.message ?? "The reviewed merge changed."} Prepare a fresh candidate.`
        : (error?.message ??
          (cause instanceof Error ? cause.message : "The merge could not be applied."));
      return {
        status: stale ? "stale" : "failed",
        failure: { code: error?.code ?? "MERGE_APPLY_FAILED", message },
        reason: message,
      };
    }
  });
}
