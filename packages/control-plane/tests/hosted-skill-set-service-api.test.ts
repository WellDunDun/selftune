import { describe, expect, it } from "vitest";

import {
  HostedSkillSetServiceCredentialCreateRequest,
  HostedSkillSetServiceCredentialMetadata,
  HostedSkillSetServiceStatusReceipt,
  HostedSkillSetServicePromoteRequest,
  HostedSkillSetServiceAssignmentRequest,
  HostedSkillSetServiceRollbackRequest,
} from "../src";

describe("hosted Skill Set service API contracts", () => {
  it("requires explicit bounded scopes and keeps reusable tokens out of metadata", () => {
    expect(
      HostedSkillSetServiceCredentialCreateRequest.parse({
        workspace_id: "workspace-1",
        name: "CI",
        scopes: ["skill_sets:publish"],
      }),
    ).toMatchObject({ scopes: ["skill_sets:publish"] });
    expect(
      HostedSkillSetServiceCredentialMetadata.parse({
        credential_id: "credential-1",
        name: "CI",
        token_prefix: "stsvc_abc",
        scopes: ["skill_sets:publish"],
        created_at: 1,
        last_used_at: null,
        revoked_at: null,
      }),
    ).not.toHaveProperty("token");
    expect(() =>
      HostedSkillSetServiceCredentialCreateRequest.parse({
        workspace_id: "workspace-1",
        name: "CI",
        scopes: [],
      }),
    ).toThrow();
  });

  it("bounds status to authoritative lifecycle and readiness values", () => {
    expect(
      HostedSkillSetServiceStatusReceipt.parse({
        release_id: "release-1",
        skill_set_id: "support",
        sequence: 1,
        lifecycle: "promoted",
        readiness: "ready",
        published_at: 1,
      }),
    ).toMatchObject({ lifecycle: "promoted", readiness: "ready" });
    expect(() =>
      HostedSkillSetServiceStatusReceipt.parse({
        release_id: "release-1",
        skill_set_id: "support",
        sequence: 1,
        lifecycle: "draft",
        readiness: "ready",
        published_at: 1,
      }),
    ).toThrow();
  });
  it("binds service promotion to the reviewed immutable hashes", () => {
    expect(() => HostedSkillSetServicePromoteRequest.parse({ release_id: "release-1" })).toThrow();
    expect(
      HostedSkillSetServicePromoteRequest.parse({
        release_id: "release-1",
        expected_skill_set_revision_sha256: "a".repeat(64),
        expected_envelope_sha256: "b".repeat(64),
      }),
    ).toMatchObject({ release_id: "release-1" });
  });
  it("keeps assignment and rollback requests explicit and idempotent", () => {
    const assignment = {
      request_id: "assign-1",
      release_id: "release-1",
      target_member_id: "member-1",
      target_device_id: "device-1",
      update_policy: "ask_before_updating" as const,
    };
    expect(HostedSkillSetServiceAssignmentRequest.parse(assignment)).toEqual(assignment);
    expect(() => HostedSkillSetServiceRollbackRequest.parse(assignment)).toThrow();
    expect(
      HostedSkillSetServiceRollbackRequest.parse({ ...assignment, reason: "Regression" }),
    ).toMatchObject({ reason: "Regression" });
  });
});
