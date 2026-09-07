import { buildCreateSkillDraft } from "../../packages/runtime/create/templates.js";
import type { SynthesisRelease, SynthesisReleaseGate } from "../../packages/runtime/synthesis.js";
import type { RemoteLibraryShare } from "../../packages/library/src/remote/types.js";

export const draftResult = {
  candidate_id: "candidate",
  evidence_snapshot_id: "snapshot",
  draft: {
    ...buildCreateSkillDraft({
      name: "draft",
      description: "Prepare release notes",
      outputDir: "/tmp",
    }),
    overwritten: false,
    written_paths: ["/tmp/draft/SKILL.md"],
  },
};

export const releaseGate: SynthesisReleaseGate = {
  schema_version: 1,
  candidate_id: "candidate",
  evidence_snapshot_id: "snapshot",
  candidate_revision_hash: "candidate-revision",
  skill_name: "draft",
  draft_path: "/tmp/draft/SKILL.md",
  revision_hash: "revision",
  evaluated_at: "2026-07-18T00:00:00.000Z",
  replay_exit_code: 0,
  baseline_exit_code: 0,
  held_out_eval_ids: [],
  recommended: true,
  blockers: [],
  evaluation: null,
};

export const releaseResult: SynthesisRelease = {
  schema_version: 1,
  candidate_id: "candidate",
  evidence_snapshot_id: "snapshot",
  candidate_revision_hash: "candidate-revision",
  skill_name: "draft",
  revision_hash: "revision",
  package_path: "/tmp/released",
  gate_path: "/tmp/gate.json",
  released_at: "2026-07-18T00:00:00.000Z",
};

export const shareResult: RemoteLibraryShare = {
  id: "share-1",
  owner_org_id: "owner-org",
  source_snapshot_id: "snapshot-1",
  root_artifact_id: "skill/research/revision-1",
  root_artifact_type: "skill_revision",
  artifacts: [],
  owner: { org_id: "owner-org", name: "Owner" },
  recipient: { user_id: "recipient", email: "recipient@example.com", name: null },
  created_by: "owner",
  status: "pending",
  expires_at: null,
  accepted_at: null,
  imported_at: null,
  imported_org_id: null,
  revoked_at: null,
  created_at: "2026-07-18T00:00:00.000Z",
  updated_at: "2026-07-18T00:00:00.000Z",
};
