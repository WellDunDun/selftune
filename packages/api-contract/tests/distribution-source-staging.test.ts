import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CanonicalDistributionSourcePackage,
  DistributionSecurityBoundaryParseOptions,
  DistributionSourceFailureSchema,
  DistributionSourceAuthorizationBinding,
  DistributionSourceObjectResolution,
  DistributionSourcePackageInspectionEvidence,
  DistributionSourceRevision,
  DistributionSourceRevisionIdSchema,
  MaximumDistributionSourceAggregateBytes,
  MaximumDistributionSourceObjectBytes,
  MaximumDistributionSourceSkillSetComponents,
  StageDistributionSourceRevision,
} from "../index";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000002",
  request: "30000000-0000-4000-8000-000000000003",
  idempotency: "40000000-0000-4000-8000-000000000004",
  rootObject: "50000000-0000-4000-8000-000000000005",
  componentOne: "60000000-0000-4000-8000-000000000006",
  componentTwo: "70000000-0000-4000-8000-000000000007",
  revision: "80000000-0000-4000-8000-000000000008",
  claim: "90000000-0000-4000-8000-000000000009",
  authorization: "a0000000-0000-4000-8000-00000000000a",
  authorizationBinding: "b0000000-0000-4000-8000-00000000000b",
};

function object(
  objectId: string,
  character: string,
  byteLength = 4,
  format: "selftune-package-v2" | "selftune-skill-set-source-v1" = "selftune-package-v2",
) {
  return {
    objectId,
    format,
    sourceRevisionHash: character.repeat(64),
    sourceObjectSha256: character.repeat(64),
    byteLength,
  };
}

function standaloneSource() {
  return {
    subject: {
      _tag: "skill_revision",
      skillRevisionId: "review-helper",
      sourceRevisionHash: "a".repeat(64),
    },
    object: object(ids.rootObject, "a"),
    bom: { _tag: "standalone" },
  };
}

function skillSetSource() {
  return {
    subject: {
      _tag: "skill_set",
      skillSetId: "research-suite",
      sourceRevisionHash: "a".repeat(64),
    },
    object: object(ids.rootObject, "a", 4, "selftune-skill-set-source-v1"),
    bom: {
      _tag: "skill_set",
      skillSetId: "research-suite",
      components: [
        {
          ordinal: 0,
          subject: {
            _tag: "skill_revision",
            skillRevisionId: "research",
            sourceRevisionHash: "b".repeat(64),
          },
          object: object(ids.componentOne, "b"),
        },
        {
          ordinal: 1,
          subject: {
            _tag: "skill_revision",
            skillRevisionId: "summarize",
            sourceRevisionHash: "c".repeat(64),
          },
          object: object(ids.componentTwo, "c"),
        },
      ],
    },
  };
}

function context() {
  return {
    organizationId: ids.organization,
    actorId: ids.actor,
    requestId: ids.request,
    idempotencyKey: ids.idempotency,
  };
}

function stagedRevision(source = standaloneSource()) {
  return {
    sourceRevisionId: ids.revision,
    organizationId: ids.organization,
    source,
    phase: "staged",
    inspection: { _tag: "pending" },
    attestation: { _tag: "pending" },
    authorization: { _tag: "pending" },
    stagedBy: ids.actor,
    stagedAt: "2026-07-21T08:00:00.000Z",
  };
}

function standaloneInspectionEvidence() {
  return {
    root: {
      _tag: "package",
      ordinal: null,
      subject: standaloneSource().subject,
      sourceObjectSha256: "a".repeat(64),
      fileManifest: [{ path: "SKILL.md", sha256: "b".repeat(64), byteLength: 42 }],
      fileManifestSha256: "c".repeat(64),
      license: {
        normalizedExpression: "MIT",
        kind: "spdx",
        policyDisposition: "automated_approved",
        normalizationProof: {
          _tag: "spdx_registry_v1",
          parser: "spdx-expression-parse",
          parserVersion: "4.0.0",
          normalizedExpressionSha256: "2".repeat(64),
          proofSha256: "3".repeat(64),
        },
        licenseFile: null,
        notices: [],
        licenseEvidenceSha256: "d".repeat(64),
        noticeEvidenceSha256: "e".repeat(64),
      },
      provenance: {
        kind: "selftune_authored",
        sourceRepository: null,
        sourceRef: null,
        sourceTreeHash: null,
        evidenceSha256: "f".repeat(64),
      },
      inspectionEvidenceSha256: "1".repeat(64),
    },
    components: [],
  };
}

function expectDecodeFailure(schema: Schema.Decoder<unknown>, input: unknown): void {
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
}

describe("distribution source staging contract", () => {
  it.each([
    "../SKILL.md",
    "/SKILL.md",
    "C:/SKILL.md",
    "folder\\SKILL.md",
    "file.txt:stream",
    "folder./SKILL.md",
    "folder /SKILL.md",
    "CON",
    "COM1.txt",
    "COM¹.txt",
    "control\u0001.txt",
    "café/SKILL.md",
  ])("rejects non-portable package path %j", (path) => {
    const artifact = standaloneInspectionEvidence().root;
    expectDecodeFailure(DistributionSourcePackageInspectionEvidence, {
      ...artifact,
      fileManifest: [{ ...artifact.fileManifest[0], path }],
    });
  });

  it("rejects file/ancestor package path collisions", () => {
    const artifact = standaloneInspectionEvidence().root;
    expectDecodeFailure(DistributionSourcePackageInspectionEvidence, {
      ...artifact,
      fileManifest: [
        artifact.fileManifest[0],
        { path: "SKILL.md/child", sha256: "4".repeat(64), byteLength: 1 },
      ],
    });
  });

  it("keeps the server source revision id distinct from every content hash", () => {
    const stage = Schema.decodeUnknownSync(StageDistributionSourceRevision)({
      context: context(),
      source: standaloneSource(),
    });
    expect(stage.source.object.sourceRevisionHash).toBe("a".repeat(64));
    expectDecodeFailure(DistributionSourceRevisionIdSchema, "a".repeat(64));
    expect(
      Schema.decodeUnknownSync(DistributionSourceRevision)(stagedRevision()).sourceRevisionId,
    ).toBe(ids.revision);
  });

  it("binds logical subject hashes while allowing revision and object hashes to differ", () => {
    const distinctHashes = {
      ...standaloneSource(),
      subject: {
        ...standaloneSource().subject,
        sourceRevisionHash: "f".repeat(64),
      },
      object: {
        ...standaloneSource().object,
        sourceRevisionHash: "f".repeat(64),
      },
    };
    expect(
      Schema.decodeUnknownSync(CanonicalDistributionSourcePackage)(distinctHashes).object
        .sourceObjectSha256,
    ).toBe("a".repeat(64));
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...distinctHashes,
      subject: {
        ...distinctHashes.subject,
        sourceRevisionHash: "e".repeat(64),
      },
    });
  });

  it("accepts standalone packages and nonempty, contiguous, unique Skill Set BOMs", () => {
    expect(
      Schema.decodeUnknownSync(CanonicalDistributionSourcePackage)(standaloneSource()).bom._tag,
    ).toBe("standalone");
    const set = Schema.decodeUnknownSync(CanonicalDistributionSourcePackage)(skillSetSource());
    expect(set.bom._tag).toBe("skill_set");
    if (set.bom._tag === "skill_set") expect(set.bom.components).toHaveLength(2);

    const invalidBoms = [
      { ...skillSetSource(), bom: { ...skillSetSource().bom, components: [] } },
      {
        ...skillSetSource(),
        bom: {
          ...skillSetSource().bom,
          components: [
            {
              ordinal: 1,
              subject: skillSetSource().bom.components[0]?.subject,
              object: object(ids.componentOne, "b"),
            },
          ],
        },
      },
      {
        ...skillSetSource(),
        bom: {
          ...skillSetSource().bom,
          components: [
            {
              ordinal: 0,
              subject: skillSetSource().bom.components[0]?.subject,
              object: object(ids.componentOne, "b"),
            },
            {
              ordinal: 1,
              subject: skillSetSource().bom.components[0]?.subject,
              object: object(ids.componentTwo, "b"),
            },
          ],
        },
      },
      {
        ...skillSetSource(),
        bom: {
          ...skillSetSource().bom,
          components: skillSetSource().bom.components.map((component, index) =>
            index === 1
              ? {
                  ...component,
                  object: {
                    ...component.object,
                    sourceObjectSha256: "b".repeat(64),
                  },
                }
              : component,
          ),
        },
      },
    ];
    for (const invalid of invalidBoms) {
      expectDecodeFailure(CanonicalDistributionSourcePackage, invalid);
    }
  });

  it("uses a distinct source-manifest format for Skill Set roots only", () => {
    const set = Schema.decodeUnknownSync(CanonicalDistributionSourcePackage)(skillSetSource());
    expect(set.object.format).toBe("selftune-skill-set-source-v1");
    if (set.bom._tag === "skill_set") {
      expect(
        set.bom.components.every((component) => component.object.format === "selftune-package-v2"),
      ).toBe(true);
    }

    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...skillSetSource(),
      object: object(ids.rootObject, "a"),
    });
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...standaloneSource(),
      object: object(ids.rootObject, "a", 4, "selftune-skill-set-source-v1"),
    });
    const setWithManifestComponent = skillSetSource();
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...setWithManifestComponent,
      bom: {
        ...setWithManifestComponent.bom,
        components: setWithManifestComponent.bom.components.map((component, index) =>
          index === 0
            ? {
                ...component,
                object: {
                  ...component.object,
                  format: "selftune-skill-set-source-v1",
                },
              }
            : component,
        ),
      },
    });
  });

  it("bounds each object, Skill Set component count, and aggregate package bytes", () => {
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...standaloneSource(),
      object: {
        ...standaloneSource().object,
        byteLength: MaximumDistributionSourceObjectBytes + 1,
      },
    });

    const set = skillSetSource();
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...set,
      object: { ...set.object, byteLength: 10 * 1024 * 1024 },
      bom: {
        ...set.bom,
        components: set.bom.components.map((component) => ({
          ...component,
          object: { ...component.object, byteLength: 8 * 1024 * 1024 },
        })),
      },
    });
    expect(MaximumDistributionSourceAggregateBytes).toBe(25 * 1024 * 1024);

    const components = Array.from(
      { length: MaximumDistributionSourceSkillSetComponents + 1 },
      (_, ordinal) => ({
        ordinal,
        subject: {
          _tag: "skill_revision",
          skillRevisionId: `skill-${ordinal}`,
          sourceRevisionHash: "d".repeat(64),
        },
        object: object(`c0000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`, "d", 1),
      }),
    );
    expectDecodeFailure(CanonicalDistributionSourcePackage, {
      ...set,
      bom: { ...set.bom, components },
    });
  });

  it("enforces the stage, inspect, attest, authorize evidence sequence", () => {
    const staged = stagedRevision();
    const inspected = {
      ...staged,
      phase: "inspected",
      inspection: {
        _tag: "ready",
        inspectedAt: "2026-07-21T08:01:00.000Z",
        policyVersion: "source-inspection-v1",
        evidence: standaloneInspectionEvidence(),
        warnings: [],
      },
    };
    const attested = {
      ...inspected,
      phase: "attested",
      attestation: {
        _tag: "attested",
        binding: { _tag: "standalone", rightsClaimId: ids.claim },
        attestedAt: "2026-07-21T08:02:00.000Z",
      },
    };
    const authorized = {
      ...attested,
      phase: "authorized",
      authorization: {
        _tag: "authorized",
        authorizationBindingId: ids.authorizationBinding,
        authorizationId: ids.authorization,
        authorizedAt: "2026-07-21T08:03:00.000Z",
      },
    };

    for (const revision of [staged, inspected, attested, authorized]) {
      expect(Schema.decodeUnknownSync(DistributionSourceRevision)(revision).phase).toBe(
        revision.phase,
      );
    }
    expectDecodeFailure(DistributionSourceRevision, {
      ...staged,
      phase: "authorized",
      authorization: authorized.authorization,
    });
    expectDecodeFailure(DistributionSourceRevision, {
      ...attested,
      inspection: {
        _tag: "blocked",
        inspectedAt: "2026-07-21T08:01:00.000Z",
        policyVersion: "source-inspection-v1",
        issues: ["invalid SKILL.md"],
      },
    });
  });

  it("bounds object resolutions to HTTPS GET URLs lasting at most fifteen minutes", () => {
    const resolution = {
      sourceRevisionId: ids.revision,
      target: { _tag: "root" },
      objectId: ids.rootObject,
      sourceObjectSha256: "a".repeat(64),
      method: "GET",
      url: "https://objects.selftune.dev/signed/root",
      issuedAt: "2026-07-21T08:00:00.000Z",
      expiresAt: "2026-07-21T08:15:00.000Z",
    };
    expect(Schema.decodeUnknownSync(DistributionSourceObjectResolution)(resolution).method).toBe(
      "GET",
    );
    expectDecodeFailure(DistributionSourceObjectResolution, {
      ...resolution,
      expiresAt: "2026-07-21T08:15:00.001Z",
    });
    expectDecodeFailure(DistributionSourceObjectResolution, {
      ...resolution,
      url: "http://objects.selftune.dev/root",
    });
  });

  it("represents the server-issued join from an existing authorization to the staging UUID", () => {
    const binding = Schema.decodeUnknownSync(DistributionSourceAuthorizationBinding)({
      id: ids.authorizationBinding,
      organizationId: ids.organization,
      sourceStagingRevisionId: ids.revision,
      distributionAuthorizationId: ids.authorization,
      subject: standaloneSource().subject,
      sourceObjectSha256: standaloneSource().object.sourceObjectSha256,
      attestation: { _tag: "standalone", rightsClaimId: ids.claim },
      components: [],
      issuedAt: "2026-07-21T08:02:00.000Z",
    });
    expect(binding.sourceStagingRevisionId).toBe(ids.revision);
    expect(binding.distributionAuthorizationId).toBe(ids.authorization);
    expectDecodeFailure(DistributionSourceAuthorizationBinding, {
      ...binding,
      sourceStagingRevisionId: "not-a-uuid",
    });
  });

  it("exposes strict tagged failures and rejects excess security-boundary fields", () => {
    const failure = Schema.decodeUnknownSync(DistributionSourceFailureSchema)({
      _tag: "DistributionSourceObjectHashMismatch",
      objectId: ids.rootObject,
      expectedSha256: "a".repeat(64),
      actualSha256: "b".repeat(64),
      message: "Object hash changed.",
    });
    expect(failure._tag).toBe("DistributionSourceObjectHashMismatch");
    expect(() =>
      Schema.decodeUnknownSync(StageDistributionSourceRevision)(
        {
          context: context(),
          source: standaloneSource(),
          registryVersion: "1.2.3",
        },
        DistributionSecurityBoundaryParseOptions,
      ),
    ).toThrow();
  });
});
