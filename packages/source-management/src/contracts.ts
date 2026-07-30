import * as Schema from "effect/Schema";

export type SourceSkillScope = "project" | "global" | "admin" | "system" | "unknown";
export type SourceMergeAgent = "claude" | "codex" | "opencode" | "pi";
export type SkillSourceUpdateLocalState = "clean" | "modified" | "unverifiable";
export type SkillSourceUpdateApplyStrategy = "abort" | "take_upstream";
export type SkillSourceUpdateStrategy = SkillSourceUpdateApplyStrategy | "agent_merge";

export interface SkillSourceUpdateLocation {
  package_path: string;
  skill_path: string;
  scope: SourceSkillScope;
  project_root: string | null;
  canonical_target: string;
  local_state: SkillSourceUpdateLocalState;
  reason: string;
  local_diff: string | null;
}

export interface SkillSourceUpdatePreview {
  skill_name: string;
  source: string;
  source_url: string | null;
  installed_hash: string;
  latest_hash: string;
  status: "available" | "current";
  locations: SkillSourceUpdateLocation[];
  conflicts: number;
  can_apply: boolean;
  upstream_diff: string | null;
}

export interface SkillSourceMergeTargetPreview {
  target_path: string;
  observed_paths: string[];
  local_diff: string | null;
  merged_diff: string;
  conflict_files: string[];
  summary: string;
}

export interface SkillSourceMergePreview {
  merge_id: string;
  skill_name: string;
  source: string;
  installed_hash: string;
  latest_hash: string;
  agent: SourceMergeAgent;
  model: string | null;
  upstream_diff: string;
  targets: SkillSourceMergeTargetPreview[];
  created_at: string;
}

export interface SkillSourceUpdateReceiptOperation {
  target_path: string;
  observed_paths: readonly string[];
  backup_path: string;
}

export interface SkillSourceUpdateReceipt {
  schema_version: 1;
  receipt_id: string;
  skill_name: string;
  source: string;
  previous_hash: string;
  installed_hash: string;
  status: "applying" | "applied" | "failed";
  strategy: SkillSourceUpdateStrategy;
  operations: readonly SkillSourceUpdateReceiptOperation[];
  applied_at: string;
}

export interface PreparedSkillSourceMergeAudit {
  readonly merge_id: string;
  readonly skill_name: string;
  readonly source: string;
  readonly installed_hash: string;
  readonly latest_hash: string;
  readonly agent: SourceMergeAgent;
  readonly model: string | null;
  readonly upstream_diff: string;
  readonly created_at: string;
  readonly targets: ReadonlyArray<
    SkillSourceMergeTargetPreview & {
      readonly local_fingerprint: string;
      readonly candidate_fingerprint: string;
    }
  >;
}

export class SkillSourceUpdateFailure extends Schema.TaggedErrorClass<SkillSourceUpdateFailure>()(
  "SkillSourceUpdateFailure",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}
