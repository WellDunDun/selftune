import { describe, expect, it } from "bun:test";

import { enforceWorkspaceSkillSetPolicy } from "../../packages/runtime/skill-set-remote-apply.js";

describe("Workspace Skill Set policy enforcement", () => {
  it("allows personal and allowed workspace sets", () => {
    expect(() => enforceWorkspaceSkillSetPolicy(null, false)).not.toThrow();
    expect(() =>
      enforceWorkspaceSkillSetPolicy(
        {
          skill_set_id: "engineering",
          skill_set_name: "Engineering",
          owner_scope: "workspace",
          action: "allow",
          reason: null,
          updated_by: null,
          updated_at: null,
        },
        false,
      ),
    ).not.toThrow();
  });

  it("blocks a workspace set before touching the project", () => {
    expect(() =>
      enforceWorkspaceSkillSetPolicy(
        {
          skill_set_id: "legacy",
          skill_set_name: "Legacy",
          owner_scope: "workspace",
          action: "block",
          reason: "Use Secure Engineering instead.",
          updated_by: "owner-1",
          updated_at: "2026-07-19T10:00:00.000Z",
        },
        false,
      ),
    ).toThrow("Use Secure Engineering instead.");
  });

  it("keeps viewers read-only even when a workspace set is allowed", () => {
    expect(() =>
      enforceWorkspaceSkillSetPolicy(
        {
          skill_set_id: "engineering",
          skill_set_name: "Engineering",
          owner_scope: "workspace",
          action: "allow",
          reason: null,
          updated_by: null,
          updated_at: null,
        },
        false,
        "viewer",
      ),
    ).toThrow("Viewer access cannot apply");
  });

  it("requires a deliberate approval but accepts the confirmed retry", () => {
    const policy = {
      skill_set_id: "release",
      skill_set_name: "Release",
      owner_scope: "workspace" as const,
      action: "require_approval" as const,
      reason: "Review the installation plan.",
      updated_by: "admin-1",
      updated_at: "2026-07-19T10:00:00.000Z",
    };
    expect(() => enforceWorkspaceSkillSetPolicy(policy, false)).toThrow(
      "Workspace approval is required",
    );
    expect(() => enforceWorkspaceSkillSetPolicy(policy, true)).not.toThrow();
  });
});
