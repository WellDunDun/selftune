export type SkillSetHarnessId = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface SkillSetSkillInput {
  name: string;
  package_path: string;
}

export interface CreateSkillSetInput {
  name: string;
  description?: string;
  harnesses: SkillSetHarnessId[];
  skills: SkillSetSkillInput[];
}

export interface UpdateSkillSetInput extends CreateSkillSetInput {
  set_id: string;
  parent_revision_hash: string;
}

export interface SkillSetSkillReference {
  name: string;
  content_hash: string;
  library_package_path: string;
}

export interface SkillSetManifest {
  schema_version: 1;
  set_id: string;
  name: string;
  description: string;
  harnesses: SkillSetHarnessId[];
  skills: SkillSetSkillReference[];
  revision: number;
  revision_hash: string;
  parent_revision_hash: string | null;
  created_at: string;
  updated_at: string;
}

export type SkillSetPlanAction = "create" | "unchanged" | "conflict";

export interface SkillSetPlanOperation {
  harness: SkillSetHarnessId;
  skill_name: string;
  content_hash: string;
  source_path: string;
  target_path: string;
  action: SkillSetPlanAction;
  reason: string;
}

export interface SkillSetPlan {
  set_id: string;
  set_name: string;
  set_revision_hash: string;
  project_root: string;
  operations: SkillSetPlanOperation[];
  creates: number;
  unchanged: number;
  conflicts: number;
  missing_dependencies: number;
}

export type SkillSetMaterializationStrategy = "symlink" | "copy";

export interface SkillSetReceiptOperation {
  harness: SkillSetHarnessId;
  skill_name: string;
  content_hash: string;
  source_path: string;
  target_path: string;
  strategy: SkillSetMaterializationStrategy | null;
  state?: "pending" | "materialized";
  target_device?: string;
  target_inode?: string;
  target_ctime_ns?: string;
}

export interface SkillSetReceipt {
  schema_version: 1;
  receipt_id: string;
  set_id: string;
  set_name: string;
  set_revision_hash: string;
  project_root: string;
  status: "applying" | "applied" | "unchanged" | "rolled_back";
  operations: SkillSetReceiptOperation[];
  applied_at: string;
  rolled_back_at: string | null;
}

export interface SkillSetServiceOptions {
  configRoot?: string;
  now?: Date;
}

export interface StoredSkillSetManifest extends Omit<SkillSetManifest, "skills"> {
  skills: Array<Omit<SkillSetSkillReference, "library_package_path">>;
}
