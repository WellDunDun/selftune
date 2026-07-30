import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AgentSkillsValidationFailed,
  DistributionAuthorization,
  DistributionAuthorizationExpired,
  DistributionChannelSchema,
  DistributionContentChanged,
  DistributionDecision,
  DistributionFailureSchema,
  DistributionMaterializationConflict,
  DistributionPackageTooLarge,
  DistributionRecipientSchema,
  DistributionScopeNotAttested,
  DistributionSourceObjectChanged,
  DistributionSubjectNotFound,
  InvalidLicenseExpression,
  LicenseEvidence,
  LicenseFileHashMismatch,
  ManualLicenseReviewRequired,
  MissingLicense,
  MissingLicenseFile,
  RightsClaim,
  RightsUnverified,
  Sha256Schema,
  SkillSetComponentBlocked,
  TelemetryEnabled,
  TelemetryNotAuthorized,
  TelemetryOwnerMismatch,
  TelemetryUnconfigured,
  decodeDistributionAuthorization,
} from "../index";

const ids = {
  organization: "550e8400-e29b-41d4-a716-446655440000",
  actor: "550e8400-e29b-41d4-a716-446655440001",
  claim: "550e8400-e29b-41d4-a716-446655440002",
  distribution: "550e8400-e29b-41d4-a716-446655440003",
  authorization: "550e8400-e29b-41d4-a716-446655440004",
  authorizationRequest: "550e8400-e29b-41d4-a716-446655440007",
  recipient: "550e8400-e29b-41d4-a716-446655440005",
  alternateOrganization: "550e8400-e29b-41d4-a716-446655440006",
};

const timestamps = {
  attested: "2026-07-20T00:00:00.000Z",
  assessed: "2026-07-20T00:01:00.000Z",
  authorized: "2026-07-20T00:02:00.000Z",
  expires: "2026-07-20T00:17:00.000Z",
};

function makeFixtures() {
  const sourceRevisionHash = "c".repeat(64);
  const subject = {
    _tag: "skill_revision",
    skillRevisionId: "revision-1",
    sourceRevisionHash,
  };
  const licenseEvidence = {
    sourceRevisionHash,
    expression: "MIT",
    kind: "spdx",
    policyDisposition: "automated_approved",
    filePath: "LICENSE",
    fileSha256: "d".repeat(64),
    noticePaths: ["NOTICE"],
  };
  const rightsClaim = {
    id: ids.claim,
    organizationId: ids.organization,
    subject,
    evidence: { _tag: "standalone_license", licenseEvidence },
    rightsHolder: { _tag: "organization", organizationId: ids.organization },
    provenanceKind: "selftune_authored",
    sourceRepository: null,
    sourceRef: null,
    sourceTreeHash: null,
    scopes: {
      redistribute: true,
      modify: true,
      enableContributorSignals: true,
    },
    attestedChannels: ["registry_public", "recipient_scoped_private_share"],
    attestedBy: ids.actor,
    attestedAt: timestamps.attested,
    attestationTermsVersion: "distribution-profile-v1",
    verificationState: "self_attested",
    verifiedBy: null,
    verifiedAt: null,
    reviewEvidence: null,
    reviewPolicyVersion: null,
    supersedesClaimId: null,
    createdAt: timestamps.attested,
  };
  const decision = {
    subject,
    channel: "registry_public",
    status: "ready",
    licenseEvidence,
    rightsClaim,
    blockers: [],
    warnings: [],
    policyVersion: "distribution-profile-v1",
    assessedAt: timestamps.assessed,
  };
  const authorization = {
    id: ids.authorization,
    distributionId: ids.distribution,
    authorizationRequestId: ids.authorizationRequest,
    organizationId: ids.organization,
    subject,
    sourceRevisionHash,
    sourceObjectSha256: "a".repeat(64),
    bindingSha256: "b".repeat(64),
    channel: "registry_public",
    intent: { _tag: "registry_public" },
    rightsClaimId: ids.claim,
    decision,
    transform: {
      name: "selftune-distribution-package",
      version: "1",
      includesFeedbackArtifacts: false,
    },
    packagedSha256: "e".repeat(64),
    authorizedBy: ids.actor,
    authorizedAt: timestamps.authorized,
    expiresAt: timestamps.expires,
  };
  return {
    authorization,
    decision,
    licenseEvidence,
    rightsClaim,
    sourceRevisionHash,
    subject,
  };
}

function makeEnabledTelemetry(configuredAt: string = timestamps.attested) {
  return {
    _tag: "enabled",
    recipientOrganizationId: ids.organization,
    capability: {
      version: 1,
      allowedSignals: ["trigger", "grade", "miss_category"],
      wireFields: {
        trigger: ["triggered", "invocation_type", "miss_detected"],
        grade: ["execution_grade"],
        miss_category: ["query_bucket"],
      },
    },
    configuredBy: ids.actor,
    configuredAt,
  };
}

function expectDecodeFailure(schema: Schema.Decoder<unknown>, input: unknown): void {
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
}

describe("distribution contract public interface", () => {
  it("exports canonical hashes and exactly the policy-matrix channels", () => {
    const digest = "a".repeat(64);
    const channels = [
      "local_authoring",
      "same_org_private_backup",
      "workspace_discovery_install",
      "recipient_scoped_private_share",
      "registry_org_bundle",
      "registry_unlisted",
      "registry_public",
      "portable_skill_set_export",
    ];

    expect(Schema.decodeUnknownSync(Sha256Schema)(digest)).toBe(digest);
    expectDecodeFailure(Sha256Schema, digest.toUpperCase());
    expect(
      channels.map((channel) => Schema.decodeUnknownSync(DistributionChannelSchema)(channel)),
    ).toEqual(channels);
    expectDecodeFailure(DistributionChannelSchema, "community_bundle");
  });

  it("models email-bound and email-less private recipients distinctly", () => {
    const email = Schema.decodeUnknownSync(DistributionRecipientSchema)({
      _tag: "email_hash",
      emailSha256: "a".repeat(64),
    });
    const bearer = Schema.decodeUnknownSync(DistributionRecipientSchema)({
      _tag: "bearer_claim",
      claimSecretSha256: "b".repeat(64),
    });

    expect(email._tag).toBe("email_hash");
    expect(bearer._tag).toBe("bearer_claim");
    expectDecodeFailure(DistributionRecipientSchema, {
      _tag: "bearer_claim",
      emailSha256: "b".repeat(64),
    });
  });

  it("decodes a fully bound decision and authorization with telemetry off by default", () => {
    const fixture = makeFixtures();
    const license = Schema.decodeUnknownSync(LicenseEvidence)(fixture.licenseEvidence);
    const claim = Schema.decodeUnknownSync(RightsClaim)(fixture.rightsClaim);
    const decision = Schema.decodeUnknownSync(DistributionDecision)(fixture.decision);
    const authorization = Schema.decodeUnknownSync(DistributionAuthorization)(
      fixture.authorization,
    );

    expect(license.sourceRevisionHash).toBe(fixture.sourceRevisionHash);
    expect(claim.subject.sourceRevisionHash).toBe(fixture.sourceRevisionHash);
    expect(decision.telemetryEntitlement).toBeInstanceOf(TelemetryUnconfigured);
    expect(authorization.intent._tag).toBe("registry_public");
    expect(authorization.packagedSha256).toBe("e".repeat(64));
  });

  it("keeps local authoring and same-org backup advisory when license evidence is missing", () => {
    const fixture = makeFixtures();
    for (const channel of ["local_authoring", "same_org_private_backup"]) {
      const decision = Schema.decodeUnknownSync(DistributionDecision)({
        ...fixture.decision,
        channel,
        licenseEvidence: null,
        rightsClaim: null,
      });
      expect(decision.status).toBe("ready");
    }
  });

  it("rejects invalid identifiers, timestamps, paths, license evidence, and provenance", () => {
    const fixture = makeFixtures();
    const cases = [
      { schema: RightsClaim, input: { ...fixture.rightsClaim, id: "claim-1" } },
      {
        schema: DistributionAuthorization,
        input: { ...fixture.authorization, id: "authorization-1" },
      },
      {
        schema: RightsClaim,
        input: {
          ...fixture.rightsClaim,
          attestedAt: "2026-07-20T03:00:00+03:00",
        },
      },
      {
        schema: LicenseEvidence,
        input: { ...fixture.licenseEvidence, filePath: "../LICENSE" },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          noticePaths: ["NOTICE", "NOTICE"],
        },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          expression: "MIT AND",
          policyDisposition: "manual_review_required",
        },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          expression: "Fake-License-1.0",
          policyDisposition: "manual_review_required",
        },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          expression: "Apache-2.0 WITH Fake-exception",
          policyDisposition: "manual_review_required",
        },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          kind: "license_ref",
          expression: "Custom",
        },
      },
      {
        schema: LicenseEvidence,
        input: {
          ...fixture.licenseEvidence,
          kind: "proprietary",
          expression: "Proprietary",
          filePath: null,
          fileSha256: null,
        },
      },
      {
        schema: RightsClaim,
        input: {
          ...fixture.rightsClaim,
          provenanceKind: "github_verified",
          sourceRepository: "https://github.com/selftune-dev/selftune",
          sourceRef: "main",
          sourceTreeHash: null,
        },
      },
      {
        schema: RightsClaim,
        input: {
          ...fixture.rightsClaim,
          evidence: {
            _tag: "standalone_license",
            licenseEvidence: {
              ...fixture.licenseEvidence,
              sourceRevisionHash: "f".repeat(64),
            },
          },
        },
      },
      {
        schema: RightsClaim,
        input: { ...fixture.rightsClaim, verificationState: "rejected" },
      },
      {
        schema: RightsClaim,
        input: {
          ...fixture.rightsClaim,
          verificationState: "manually_verified",
          verifiedBy: ids.actor,
        },
      },
      {
        schema: RightsClaim,
        input: {
          ...fixture.rightsClaim,
          verifiedBy: ids.actor,
          verifiedAt: timestamps.attested,
          reviewEvidence: "ticket:LEGAL-1",
          reviewPolicyVersion: "legal-review-v1",
        },
      },
    ];

    for (const entry of cases) expectDecodeFailure(entry.schema, entry.input);

    expect(
      Schema.decodeUnknownSync(LicenseEvidence)({
        ...fixture.licenseEvidence,
        expression: "Apache-2.0 WITH LLVM-exception",
        policyDisposition: "manual_review_required",
      }).expression,
    ).toBe("Apache-2.0 WITH LLVM-exception");
    expect(
      Schema.decodeUnknownSync(LicenseEvidence)({
        ...fixture.licenseEvidence,
        kind: "license_ref",
        expression: "LicenseRef-Acme-Commercial",
        policyDisposition: "manual_review_required",
      }).kind,
    ).toBe("license_ref");
    expect(
      Schema.decodeUnknownSync(RightsClaim)({
        ...fixture.rightsClaim,
        verificationState: "manually_verified",
        verifiedBy: ids.actor,
        verifiedAt: timestamps.attested,
        reviewEvidence: "ticket:LEGAL-1",
        reviewPolicyVersion: "legal-review-v1",
      }).verificationState,
    ).toBe("manually_verified");
  });

  it("fails closed for compound SPDX expressions and exceptions", () => {
    const fixture = makeFixtures();
    const expressionsRequiringReview = [
      "MIT WITH LLVM-exception",
      "MIT AND Apache-2.0",
      "MIT OR Apache-2.0",
      "MIT+",
    ];

    for (const expression of expressionsRequiringReview) {
      expect(
        Schema.decodeUnknownSync(LicenseEvidence)({
          ...fixture.licenseEvidence,
          expression,
          policyDisposition: "manual_review_required",
        }).expression,
      ).toBe(expression);
      expectDecodeFailure(LicenseEvidence, {
        ...fixture.licenseEvidence,
        expression,
        policyDisposition: "automated_approved",
      });
    }

    for (const expression of ["mit and apache-2.0", "MIT and Apache-2.0", "MIT AnD Apache-2.0"]) {
      expectDecodeFailure(LicenseEvidence, {
        ...fixture.licenseEvidence,
        expression,
        policyDisposition: "manual_review_required",
      });
    }
  });

  it("retains valid non-allowlisted SPDX evidence and gates readiness on manual approval", () => {
    const fixture = makeFixtures();
    const reviewRequiredLicense = {
      ...fixture.licenseEvidence,
      expression: "GPL-3.0-only",
      policyDisposition: "manual_review_required",
    };
    const decodedLicense = Schema.decodeUnknownSync(LicenseEvidence)(reviewRequiredLicense);

    expect(decodedLicense.kind).toBe("spdx");
    expect(decodedLicense.expression).toBe("GPL-3.0-only");
    expect(decodedLicense.policyDisposition).toBe("manual_review_required");
    expectDecodeFailure(LicenseEvidence, {
      ...reviewRequiredLicense,
      policyDisposition: "automated_approved",
    });
    expectDecodeFailure(DistributionDecision, {
      ...fixture.decision,
      licenseEvidence: reviewRequiredLicense,
      rightsClaim: {
        ...fixture.rightsClaim,
        evidence: {
          _tag: "standalone_license",
          licenseEvidence: reviewRequiredLicense,
        },
      },
    });

    const manuallyApprovedLicense = {
      ...reviewRequiredLicense,
      policyDisposition: "manually_approved",
    };
    const manuallyVerifiedClaim = {
      ...fixture.rightsClaim,
      evidence: {
        _tag: "standalone_license",
        licenseEvidence: manuallyApprovedLicense,
      },
      verificationState: "manually_verified",
      verifiedBy: ids.actor,
      verifiedAt: timestamps.attested,
      reviewEvidence: "ticket:LEGAL-2",
      reviewPolicyVersion: "legal-review-v1",
    };
    expectDecodeFailure(DistributionDecision, {
      ...fixture.decision,
      licenseEvidence: manuallyApprovedLicense,
      rightsClaim: {
        ...fixture.rightsClaim,
        evidence: {
          _tag: "standalone_license",
          licenseEvidence: manuallyApprovedLicense,
        },
      },
    });
    expect(
      Schema.decodeUnknownSync(DistributionDecision)({
        ...fixture.decision,
        licenseEvidence: manuallyApprovedLicense,
        rightsClaim: manuallyVerifiedClaim,
      }).status,
    ).toBe("ready");
  });

  it("binds relay-v1 capability categories to deterministic privacy-safe wire fields", () => {
    const base = makeEnabledTelemetry();
    const enabled = Schema.decodeUnknownSync(TelemetryEnabled)(base);

    expect(enabled.capability.version).toBe(1);
    expect(enabled.capability.allowedSignals).toEqual(["trigger", "grade", "miss_category"]);
    expect(enabled.capability.wireFields).toMatchObject({
      trigger: ["triggered", "invocation_type", "miss_detected"],
      grade: ["execution_grade"],
      miss_category: ["query_bucket"],
    });
    for (const input of [
      { ...base, capability: { ...base.capability, version: 2 } },
      { ...base, recipientOrganizationId: "org-1" },
      {
        ...base,
        capability: {
          ...base.capability,
          allowedSignals: ["trigger", "trigger"],
        },
      },
      {
        ...base,
        capability: { ...base.capability, allowedSignals: ["prompt_text"] },
      },
      {
        ...base,
        capability: { ...base.capability, allowedSignals: ["transcript_path"] },
      },
      {
        ...base,
        capability: {
          ...base.capability,
          wireFields: { ...base.capability.wireFields, grade: ["raw_grade"] },
        },
      },
    ]) {
      expectDecodeFailure(TelemetryEnabled, input);
    }
  });

  it("rejects inconsistent and non-ready distribution decisions", () => {
    const fixture = makeFixtures();
    const otherHash = "f".repeat(64);
    const otherSubject = { ...fixture.subject, sourceRevisionHash: otherHash };
    const otherLicense = {
      ...fixture.licenseEvidence,
      sourceRevisionHash: otherHash,
    };
    const otherClaim = {
      ...fixture.rightsClaim,
      subject: otherSubject,
      evidence: { _tag: "standalone_license", licenseEvidence: otherLicense },
    };
    const blocker = {
      code: "MissingLicense",
      message: "A license is required.",
    };
    const cases = [
      { ...fixture.decision, subject: otherSubject },
      { ...fixture.decision, licenseEvidence: otherLicense },
      { ...fixture.decision, rightsClaim: otherClaim },
      { ...fixture.decision, status: "not_ready_for_distribution" },
      {
        ...fixture.decision,
        rightsClaim: { ...fixture.rightsClaim, verificationState: "rejected" },
      },
      {
        ...fixture.decision,
        rightsClaim: {
          ...fixture.rightsClaim,
          scopes: { ...fixture.rightsClaim.scopes, redistribute: false },
        },
      },
      {
        ...fixture.decision,
        rightsClaim: {
          ...fixture.rightsClaim,
          attestedChannels: ["registry_unlisted"],
        },
      },
      {
        ...fixture.decision,
        rightsClaim: { ...fixture.rightsClaim, createdAt: timestamps.expires },
      },
      {
        ...fixture.decision,
        telemetryEntitlement: makeEnabledTelemetry(timestamps.expires),
      },
      {
        ...fixture.decision,
        telemetryEntitlement: makeEnabledTelemetry(),
        rightsClaim: {
          ...fixture.rightsClaim,
          scopes: {
            ...fixture.rightsClaim.scopes,
            enableContributorSignals: false,
          },
        },
      },
      {
        ...fixture.decision,
        telemetryEntitlement: makeEnabledTelemetry(),
        rightsClaim: {
          ...fixture.rightsClaim,
          scopes: { ...fixture.rightsClaim.scopes, modify: false },
        },
      },
      {
        ...fixture.decision,
        status: "not_ready_for_distribution",
        blockers: [blocker, blocker],
      },
    ];

    for (const input of cases) expectDecodeFailure(DistributionDecision, input);
  });

  it("binds authorization to its ready decision, exact hash, channel, claim, intent, and expiry", () => {
    const fixture = makeFixtures();
    const blocker = {
      code: "MissingLicense",
      message: "A license is required.",
    };
    const telemetryAuthorization = Schema.decodeUnknownSync(DistributionAuthorization)({
      ...fixture.authorization,
      transform: {
        ...fixture.authorization.transform,
        includesFeedbackArtifacts: true,
      },
      decision: {
        ...fixture.decision,
        telemetryEntitlement: makeEnabledTelemetry(),
      },
    });
    expect(telemetryAuthorization.transform.includesFeedbackArtifacts).toBe(true);

    const cases = [
      { ...fixture.authorization, sourceRevisionHash: "f".repeat(64) },
      { ...fixture.authorization, channel: "registry_unlisted" },
      { ...fixture.authorization, rightsClaimId: ids.alternateOrganization },
      { ...fixture.authorization, intent: { _tag: "registry_unlisted" } },
      { ...fixture.authorization, expiresAt: timestamps.authorized },
      {
        ...fixture.authorization,
        decision: { ...fixture.decision, assessedAt: timestamps.expires },
      },
      {
        ...fixture.authorization,
        transform: {
          ...fixture.authorization.transform,
          includesFeedbackArtifacts: true,
        },
      },
      {
        ...fixture.authorization,
        decision: {
          ...fixture.decision,
          status: "not_ready_for_distribution",
          blockers: [blocker],
        },
      },
      {
        ...fixture.authorization,
        decision: {
          ...fixture.decision,
          telemetryEntitlement: makeEnabledTelemetry(),
        },
      },
      {
        ...fixture.authorization,
        transform: {
          ...fixture.authorization.transform,
          includesFeedbackArtifacts: true,
        },
        decision: {
          ...fixture.decision,
          telemetryEntitlement: makeEnabledTelemetry(),
          rightsClaim: {
            ...fixture.rightsClaim,
            scopes: { ...fixture.rightsClaim.scopes, modify: false },
          },
        },
      },
    ];

    for (const input of cases) expectDecodeFailure(DistributionAuthorization, input);
  });

  it("requires typed private-share recipients and strict security-boundary decoding", async () => {
    const fixture = makeFixtures();
    const privateDecision = {
      ...fixture.decision,
      channel: "recipient_scoped_private_share",
    };
    const privateAuthorization = {
      ...fixture.authorization,
      channel: "recipient_scoped_private_share",
      intent: {
        _tag: "recipient_scoped_private_share",
        recipient: { _tag: "user", userId: ids.recipient },
      },
      decision: privateDecision,
    };

    expect(
      Schema.decodeUnknownSync(DistributionAuthorization)(privateAuthorization).intent._tag,
    ).toBe("recipient_scoped_private_share");
    expectDecodeFailure(DistributionAuthorization, {
      ...privateAuthorization,
      intent: {
        _tag: "recipient_scoped_private_share",
        recipient: { _tag: "user", userId: "not-a-uuid" },
      },
    });
    await expect(
      Effect.runPromise(
        decodeDistributionAuthorization({
          ...fixture.authorization,
          unsignedExtra: true,
        }),
      ),
    ).rejects.toThrow();
  });

  it("decodes every tagged failure shape and exposes its HTTP status", () => {
    const fixture = makeFixtures();
    const skillSetSubject = {
      _tag: "skill_set",
      skillSetId: "set-1",
      sourceRevisionHash: fixture.sourceRevisionHash,
    };
    const blocker = {
      code: "MissingLicense",
      message: "A license is required.",
    };
    const errors = [
      {
        schema: DistributionSubjectNotFound,
        status: 404,
        input: {
          _tag: "DistributionSubjectNotFound",
          subject: fixture.subject,
          message: "missing",
        },
      },
      {
        schema: DistributionContentChanged,
        status: 409,
        input: {
          _tag: "DistributionContentChanged",
          subject: fixture.subject,
          expectedSourceRevisionHash: fixture.sourceRevisionHash,
          actualSourceRevisionHash: "f".repeat(64),
          message: "changed",
        },
      },
      {
        schema: DistributionSourceObjectChanged,
        status: 409,
        input: {
          _tag: "DistributionSourceObjectChanged",
          subject: fixture.subject,
          expectedSourceObjectSha256: "a".repeat(64),
          actualSourceObjectSha256: "f".repeat(64),
          message: "object changed",
        },
      },
      {
        schema: DistributionPackageTooLarge,
        status: 413,
        input: {
          _tag: "DistributionPackageTooLarge",
          subject: fixture.subject,
          dimension: "file_count",
          actual: 501,
          limit: 500,
          message: "too large",
        },
      },
      {
        schema: DistributionAuthorizationExpired,
        status: 410,
        input: {
          _tag: "DistributionAuthorizationExpired",
          authorizationId: ids.authorization,
          expiredAt: timestamps.expires,
          message: "expired",
        },
      },
      {
        schema: DistributionMaterializationConflict,
        status: 409,
        input: {
          _tag: "DistributionMaterializationConflict",
          authorizationId: ids.authorization,
          message: "conflict",
        },
      },
      {
        schema: AgentSkillsValidationFailed,
        status: 422,
        input: {
          _tag: "AgentSkillsValidationFailed",
          subject: fixture.subject,
          issues: ["invalid SKILL.md"],
          message: "invalid",
        },
      },
      {
        schema: MissingLicense,
        status: 422,
        input: {
          _tag: "MissingLicense",
          subject: fixture.subject,
          message: "missing",
        },
      },
      {
        schema: InvalidLicenseExpression,
        status: 422,
        input: {
          _tag: "InvalidLicenseExpression",
          subject: fixture.subject,
          expression: "MIT AND",
          message: "invalid",
        },
      },
      {
        schema: MissingLicenseFile,
        status: 422,
        input: {
          _tag: "MissingLicenseFile",
          subject: fixture.subject,
          filePath: "LICENSE",
          message: "missing",
        },
      },
      {
        schema: LicenseFileHashMismatch,
        status: 409,
        input: {
          _tag: "LicenseFileHashMismatch",
          subject: fixture.subject,
          filePath: "LICENSE",
          expectedHash: "a".repeat(64),
          actualHash: "b".repeat(64),
          message: "mismatch",
        },
      },
      {
        schema: RightsUnverified,
        status: 403,
        input: {
          _tag: "RightsUnverified",
          subject: fixture.subject,
          rightsClaimId: ids.claim,
          message: "unverified",
        },
      },
      {
        schema: DistributionScopeNotAttested,
        status: 403,
        input: {
          _tag: "DistributionScopeNotAttested",
          rightsClaimId: ids.claim,
          channel: "registry_public",
          message: "not attested",
        },
      },
      {
        schema: ManualLicenseReviewRequired,
        status: 422,
        input: {
          _tag: "ManualLicenseReviewRequired",
          subject: fixture.subject,
          reason: "custom terms",
          message: "review",
        },
      },
      {
        schema: TelemetryOwnerMismatch,
        status: 409,
        input: {
          _tag: "TelemetryOwnerMismatch",
          subject: fixture.subject,
          claimedRecipientOrganizationId: ids.alternateOrganization,
          authorizedRecipientOrganizationId: ids.organization,
          message: "mismatch",
        },
      },
      {
        schema: TelemetryNotAuthorized,
        status: 403,
        input: {
          _tag: "TelemetryNotAuthorized",
          subject: fixture.subject,
          channel: "registry_public",
          message: "not authorized",
        },
      },
      {
        schema: SkillSetComponentBlocked,
        status: 424,
        input: {
          _tag: "SkillSetComponentBlocked",
          skillSetId: skillSetSubject.skillSetId,
          component: fixture.subject,
          blocker,
          message: "component blocked",
        },
      },
    ];

    for (const entry of errors) {
      const decoded = Schema.decodeUnknownSync(DistributionFailureSchema)(entry.input);
      expect(decoded._tag).toBe(entry.input._tag);
      expect(entry.schema.ast.annotations?.httpApiStatus).toBe(entry.status);
    }
  });
});
