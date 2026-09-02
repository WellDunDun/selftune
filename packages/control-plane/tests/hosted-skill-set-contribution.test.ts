import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  HostedSkillSetContributionDecisionRequest,
  HostedSkillSetContributionDecisionReceipt,
  HostedSkillSetContributionListReceipt,
  HostedSkillSetContributionSubmitRequest,
  HostedSkillSetContributionSubmitReceipt,
  HostedSkillSetContributionUploadIntentReceipt,
  HostedSkillSetContributionUploadIntentRequest,
  MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTION_CHANGES,
} from "../src";

const baseRevisionSha256 = "1".repeat(64);
const proposedRevisionSha256 = "2".repeat(64);
const proposedEnvelopeSha256 = "3".repeat(64);

const proposal = {
  contribution_id: "contribution-1",
  request_id: "contribute:engineering:proposal-1",
  skill_set_id: "engineering",
  base_release_id: "release-1",
  proposed_skill_set_revision_sha256: proposedRevisionSha256,
  proposed_envelope_sha256: proposedEnvelopeSha256,
  proposed_byte_length: 4_096,
  title: "Clarify incident handoff",
  message: "Please review the updated escalation instructions.",
  submitted_by_member_id: "member-2",
  submitted_by_name: "Maya Haddad",
  submitted_at: Date.parse("2026-08-31T12:00:00.000Z"),
  change_manifest: {
    base_skill_set_revision_sha256: baseRevisionSha256,
    proposed_skill_set_revision_sha256: proposedRevisionSha256,
    added_files: 1,
    modified_files: 1,
    removed_files: 0,
    changes: [
      {
        component_name: "incident-handoff",
        package_path: "SKILL.md",
        change_type: "modified" as const,
        base_sha256: "4".repeat(64),
        proposed_sha256: "5".repeat(64),
        summary: "Clarifies when to escalate and which context to include.",
      },
      {
        component_name: "incident-handoff",
        package_path: "references/retrospective.md",
        change_type: "added" as const,
        base_sha256: null,
        proposed_sha256: "6".repeat(64),
        summary: "Adds a reviewed retrospective checklist.",
      },
    ],
  },
  readiness: {
    status: "ready" as const,
    checked_components: 1,
    blocked_components: 0,
    summary: "Portable package and license checks passed.",
  },
  review_diff:
    "--- a/incident-handoff/SKILL.md\n+++ b/incident-handoff/SKILL.md\n@@ -1 +1 @@\n-Old\n+New\n",
};

describe("hosted Skill Set contribution contracts", () => {
  it.each(["references/invalid\0.md", "references\\invalid.md"])(
    "rejects unsafe package path %j",
    (packagePath) => {
      expect(() =>
        Schema.decodeUnknownSync(HostedSkillSetContributionListReceipt)({
          proposals: [
            {
              ...proposal,
              change_manifest: {
                ...proposal.change_manifest,
                changes: proposal.change_manifest.changes.map((change) => ({
                  ...change,
                  package_path: packagePath,
                })),
              },
            },
          ],
        }),
      ).toThrow();
    },
  );

  it("accepts an explicit, idempotent, bounded contribution submission", () => {
    const request = {
      request_id: "contribute:engineering:proposal-1",
      skill_set_id: "engineering",
      base_release_id: "release-1",
      proposed_skill_set_revision_sha256: proposedRevisionSha256,
      proposed_envelope_sha256: proposedEnvelopeSha256,
      proposed_byte_length: 4_096,
      package_storage_id: "storage-1",
      title: "Clarify incident handoff",
      message: "Please review the updated escalation instructions.",
    };

    const { package_storage_id: _packageStorageId, ...intentRequest } = request;
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionUploadIntentRequest)(intentRequest),
    ).toEqual(intentRequest);
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionUploadIntentReceipt)({
        request_id: request.request_id,
        upload_url: "https://example.test/upload",
        expires_at: Date.parse("2026-08-31T12:10:00.000Z"),
      }),
    ).toMatchObject({ request_id: request.request_id });

    expect(Schema.decodeUnknownSync(HostedSkillSetContributionSubmitRequest)(request)).toEqual(
      request,
    );
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionSubmitReceipt)({
        proposal,
        idempotent: false,
      }),
    ).toEqual({ proposal, idempotent: false });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionSubmitRequest)({
        ...request,
        request_id: "spaces are not an opaque id",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionSubmitRequest)({
        ...request,
        message: "x".repeat(4_001),
      }),
    ).toThrow();
  });

  it("projects only bounded, server-derived change metadata for review", () => {
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionListReceipt)({ proposals: [proposal] }),
    ).toEqual({ proposals: [proposal] });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionListReceipt)({
        proposals: [
          {
            ...proposal,
            change_manifest: {
              ...proposal.change_manifest,
              changes: Array.from(
                { length: MAXIMUM_HOSTED_SKILL_SET_CONTRIBUTION_CHANGES + 1 },
                (_, index) => ({
                  component_name: `component-${index}`,
                  change_type: "added",
                  summary: "Added component.",
                }),
              ),
            },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionListReceipt)({
        proposals: [
          {
            ...proposal,
            change_manifest: {
              ...proposal.change_manifest,
              changes: [
                {
                  component_name: "incident-handoff",
                  package_path: "SKILL.md",
                  change_type: "added",
                  base_sha256: "4".repeat(64),
                  proposed_sha256: "5".repeat(64),
                  summary: "Invalid added-file hashes.",
                },
              ],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("records immutable decisions and yields a new release only for approval", () => {
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionDecisionRequest)({
        request_id: "decision:contribution-1:approve",
        contribution_id: "contribution-1",
        decision: "approved",
        review_note: "Reviewed with the incident response owner.",
      }),
    ).toMatchObject({ contribution_id: "contribution-1", decision: "approved" });

    const approved = {
      decision_id: "decision-1",
      request_id: "decision:contribution-1:approve",
      contribution_id: "contribution-1",
      base_release_id: "release-1",
      decision: "approved" as const,
      review_note: "Reviewed with the incident response owner.",
      decided_by_member_id: "member-1",
      decided_by_name: "Nadine Khalaf",
      decided_at: Date.parse("2026-08-31T13:00:00.000Z"),
      release: {
        release_id: "release-2",
        skill_set_id: "engineering",
        sequence: 2,
        skill_set_revision_sha256: proposedRevisionSha256,
        envelope_sha256: proposedEnvelopeSha256,
        published_at: Date.parse("2026-08-31T13:00:00.000Z"),
      },
      idempotent: false,
    };

    expect(Schema.decodeUnknownSync(HostedSkillSetContributionDecisionReceipt)(approved)).toEqual(
      approved,
    );
    expect(
      Schema.decodeUnknownSync(HostedSkillSetContributionDecisionReceipt)({
        ...approved,
        decision: "rejected",
        release: null,
      }),
    ).toMatchObject({ decision: "rejected", release: null });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionDecisionReceipt)({
        ...approved,
        release: null,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionDecisionReceipt)({
        ...approved,
        release: { ...approved.release, release_id: approved.base_release_id },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetContributionDecisionReceipt)({
        ...approved,
        decision: "rejected",
      }),
    ).toThrow();
  });
});
