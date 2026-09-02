import { z } from "zod";

export const HostedSkillSetServiceApiVersion = "v1" as const;
export const HostedSkillSetServiceScope = z.enum([
  "skill_sets:publish",
  "skill_sets:lifecycle",
  "skill_sets:status",
  "skill_sets:assign",
  "skill_sets:rollback",
]);
export type HostedSkillSetServiceScope = z.infer<typeof HostedSkillSetServiceScope>;
export const HostedSkillSetServiceCredentialCreateRequest = z.object({
  workspace_id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  scopes: z.array(HostedSkillSetServiceScope).min(1).max(5),
});
export const HostedSkillSetServiceCredentialReceipt = z.object({
  credential_id: z.string().min(1),
  token: z.string().startsWith("stsvc_"),
  token_prefix: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});
export const HostedSkillSetServiceCredentialMetadata = z.object({
  credential_id: z.string().min(1),
  name: z.string(),
  token_prefix: z.string(),
  scopes: z.array(HostedSkillSetServiceScope),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
});
export const HostedSkillSetServiceLifecycleRequest = z.object({
  release_id: z.string().min(1).max(500),
  reason: z.string().trim().min(1).max(320).optional(),
});
export const HostedSkillSetServicePromoteRequest = z.object({
  release_id: z.string().min(1).max(500),
  expected_skill_set_revision_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expected_envelope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const HostedSkillSetServiceAssignmentRequest = z.object({
  request_id: z.string().min(1).max(200),
  release_id: z.string().min(1).max(500),
  target_member_id: z.string().min(1).max(500),
  target_device_id: z.string().min(1).max(500),
  update_policy: z.enum(["manual", "notify", "automatic", "ask_before_updating"]),
});
export const HostedSkillSetServiceRollbackRequest = HostedSkillSetServiceAssignmentRequest.extend({
  reason: z.string().trim().min(1).max(320),
});
export const HostedSkillSetServiceStatusRequest = z.object({
  release_id: z.string().min(1).max(500),
});
export const HostedSkillSetServiceStatusReceipt = z.object({
  release_id: z.string(),
  skill_set_id: z.string(),
  sequence: z.number().int().positive(),
  lifecycle: z.enum(["published", "promoted", "deprecated"]),
  readiness: z.enum(["ready", "blocked", "not_recorded"]),
  published_at: z.number(),
});
