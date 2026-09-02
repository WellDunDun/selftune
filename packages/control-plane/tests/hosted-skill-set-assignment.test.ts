import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  HostedSkillSetAssignmentCreateRequest,
  HostedSkillSetAssignmentCreateReceipt,
  HostedSkillSetAssignmentListReceipt,
  HostedSkillSetAssignmentPackageMetadata,
  HostedSkillSetAssignmentPackageRequest,
  HostedSkillSetInstallationReceiptRequest,
  HostedSkillSetInstallationReceiptResponse,
} from "../src";

const releaseSha256 = "a".repeat(64);
const envelopeSha256 = "b".repeat(64);

describe("hosted Skill Set assignment contracts", () => {
  it("binds one immutable release to one member and linked device", () => {
    expect(
      Schema.decodeUnknownSync(HostedSkillSetAssignmentCreateRequest)({
        request_id: "assign:engineering:member-1:device-1:release-1",
        release_id: "release-1",
        target_member_id: "member-1",
        target_device_id: "device-1",
        update_policy: "ask_before_updating",
      }),
    ).toMatchObject({
      release_id: "release-1",
      target_member_id: "member-1",
      target_device_id: "device-1",
      update_policy: "ask_before_updating",
    });

    expect(
      Schema.decodeUnknownSync(HostedSkillSetAssignmentCreateReceipt)({
        assignment_id: "assignment-1",
        release_id: "release-1",
        skill_set_id: "engineering",
        sequence: 1,
        target_member_id: "member-1",
        target_device_id: "device-1",
        supersedes_assignment_id: null,
        assigned_at: Date.parse("2026-08-31T12:00:00.000Z"),
        idempotent: false,
      }),
    ).toMatchObject({ assignment_id: "assignment-1", supersedes_assignment_id: null });
  });

  it("bounds the device assignment projection and exact package binding", () => {
    const assignment = {
      assignment_id: "assignment-1",
      request_id: "assign:engineering:member-1:device-1:release-1",
      release_id: "release-1",
      skill_set_id: "engineering",
      name: "Engineering agent setup",
      description: "Reviewed instructions for the engineering team.",
      publisher_name: "Nadine Khalaf",
      sequence: 1,
      skill_set_revision_sha256: releaseSha256,
      envelope_sha256: envelopeSha256,
      byte_length: 4_096,
      assigned_at: Date.parse("2026-08-31T12:00:00.000Z"),
      update_policy: "ask_before_updating" as const,
      components: [{ name: "review-pr", license_expression: "MIT" }],
      harnesses: ["codex"],
      readiness: {
        status: "ready" as const,
        checked_components: 1,
        blocked_components: 0,
      },
      observed: {
        status: "unknown" as const,
        lifecycle_sequence: null,
        receipt_id: null,
        observed_release_id: null,
        observed_at: null,
        failure_code: null,
      },
    };

    expect(
      Schema.decodeUnknownSync(HostedSkillSetAssignmentListReceipt)({ assignments: [assignment] }),
    ).toEqual({ assignments: [assignment] });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetAssignmentPackageRequest)({
        assignment_id: "assignment-1",
      }),
    ).toEqual({ assignment_id: "assignment-1" });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetAssignmentPackageMetadata)({
        assignment_id: "assignment-1",
        release_id: "release-1",
        envelope_sha256: envelopeSha256,
        byte_length: 4_096,
      }),
    ).toMatchObject({ release_id: "release-1", envelope_sha256: envelopeSha256 });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetAssignmentListReceipt)({
        assignments: Array.from({ length: 101 }, () => assignment),
      }),
    ).toThrow();
  });

  it("accepts only privacy-safe observed-state receipts", () => {
    const receipt = {
      request_id: "receipt:assignment-1:install-1",
      assignment_id: "assignment-1",
      release_id: "release-1",
      lifecycle_sequence: 1,
      result: "current" as const,
      coarse_scope: "global" as const,
      target_agents: ["codex", "claude_code"] as const,
      changed_skill_count: 2,
      blocked_skill_count: 0,
      occurred_at: Date.parse("2026-08-31T12:05:00.000Z"),
      rollback_pointer: "rollback:8eeecfcb",
      failure_code: null,
    };

    expect(Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)(receipt)).toEqual(
      receipt,
    );
    expect(
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptResponse)({
        receipt_id: "receipt-1",
        assignment_id: "assignment-1",
        release_id: "release-1",
        lifecycle_sequence: 1,
        status: "current",
        recorded_at: Date.parse("2026-08-31T12:05:01.000Z"),
        idempotent: false,
      }),
    ).toMatchObject({ status: "current", idempotent: false });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        rollback_pointer: "/Users/example/.selftune/receipts/receipt-1.json",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        target_agents: Array.from({ length: 9 }, () => "codex"),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        target_agents: ["codex", "codex"],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        rollback_pointer: null,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        result: "failed",
        failure_code: null,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(HostedSkillSetInstallationReceiptRequest)({
        ...receipt,
        result: "failed",
        rollback_pointer: null,
        failure_code: "INSTALL_CONFLICT",
      }),
    ).toMatchObject({ result: "failed", failure_code: "INSTALL_CONFLICT" });
  });
});
