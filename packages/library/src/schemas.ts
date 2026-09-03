import * as Schema from "effect/Schema";

import type { SkillSetReceipt, StoredSkillSetManifest } from "./types.js";

const Harness = Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]);
const StoredSkill = Schema.Struct({
  name: Schema.String,
  content_hash: Schema.String,
});
const StoredManifest = Schema.Struct({
  schema_version: Schema.Literal(1),
  set_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  harnesses: Schema.Array(Harness),
  skills: Schema.Array(StoredSkill),
  revision: Schema.optionalKey(Schema.Number),
  revision_hash: Schema.optionalKey(Schema.String),
  parent_revision_hash: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
});
const ReceiptOperation = Schema.Struct({
  harness: Harness,
  skill_name: Schema.String,
  content_hash: Schema.String,
  source_path: Schema.String,
  target_path: Schema.String,
  strategy: Schema.NullOr(Schema.Literals(["symlink", "copy"])),
  state: Schema.optional(Schema.Literals(["pending", "materialized"])),
  target_device: Schema.optional(Schema.String),
  target_inode: Schema.optional(Schema.String),
  target_ctime_ns: Schema.optional(Schema.String),
});
const Receipt = Schema.Struct({
  temporary_task: Schema.optional(Schema.String),
  temporary_targets: Schema.optional(Schema.Array(Schema.String)),
  schema_version: Schema.Literal(1),
  receipt_id: Schema.String,
  set_id: Schema.String,
  set_name: Schema.String,
  set_revision_hash: Schema.optionalKey(Schema.String),
  project_root: Schema.String,
  status: Schema.Literals(["applying", "applied", "unchanged", "rolled_back"]),
  operations: Schema.Array(ReceiptOperation),
  applied_at: Schema.String,
  rolled_back_at: Schema.NullOr(Schema.String),
});

export function decodeStoredSkillSetManifest(input: unknown): StoredSkillSetManifest {
  const value = Schema.decodeUnknownSync(StoredManifest)(input);
  return {
    ...value,
    harnesses: [...value.harnesses],
    skills: value.skills.map((skill) => ({ ...skill })),
    revision: value.revision ?? 1,
    revision_hash: value.revision_hash ?? "",
    parent_revision_hash: value.parent_revision_hash ?? null,
  };
}

export function decodeSkillSetReceipt(input: unknown): SkillSetReceipt {
  const value = Schema.decodeUnknownSync(Receipt)(input);
  return {
    ...value,
    set_revision_hash: value.set_revision_hash ?? "",
    operations: value.operations.map((operation) => ({ ...operation })),
    ...(value.temporary_targets ? { temporary_targets: [...value.temporary_targets] } : {}),
  };
}
