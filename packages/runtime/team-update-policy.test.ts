import { describe, expect, test } from "bun:test";

import type { HostedSkillSetAssignment } from "@selftune/control-plane";

import { evaluateTeamAutomaticUpdate } from "./team-assignment.js";

const assignment = {
  update_policy: "automatic",
  release_lifecycle: "promoted",
  readiness: { status: "ready", checked_components: 1, blocked_components: 0 },
} as HostedSkillSetAssignment;

const evidence = {
  hasLocalConflict: false,
  hasCurrentBase: true,
  hasLocalPolicyEvidence: true,
  dependencyLockMatches: true,
  recipientReviewRequired: false,
};

describe("authoritative team update policy", () => {
  test("allows automatic only after explicit opt-in and complete local evidence", () => {
    expect(evaluateTeamAutomaticUpdate(assignment, evidence)).toEqual({
      automatic: true,
      blockers: [],
    });
  });

  test("maps ask-before-updating to manual recipient review", () => {
    expect(
      evaluateTeamAutomaticUpdate(
        { ...assignment, update_policy: "ask_before_updating" },
        evidence,
      ),
    ).toEqual({ automatic: false, blockers: ["policy_not_automatic"] });
  });

  test("fails closed for every unsafe automatic-update condition", () => {
    expect(
      evaluateTeamAutomaticUpdate(
        {
          ...assignment,
          readiness: { status: "not_recorded", checked_components: 0, blocked_components: 0 },
          release_lifecycle: "deprecated",
        },
        {
          hasLocalConflict: true,
          hasCurrentBase: false,
          hasLocalPolicyEvidence: false,
          dependencyLockMatches: false,
          recipientReviewRequired: true,
        },
      ),
    ).toEqual({
      automatic: false,
      blockers: [
        "local_conflict",
        "stale_base",
        "readiness_not_ready",
        "local_policy_evidence_missing",
        "release_not_promoted",
        "dependency_lock_mismatch",
        "recipient_review_required",
      ],
    });
  });
});
