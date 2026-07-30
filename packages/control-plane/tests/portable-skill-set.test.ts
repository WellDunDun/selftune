import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeCanonicalSkillSetSourceManifest,
  decodePortableSkillSetEnvelope,
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
  MAXIMUM_PORTABLE_SKILL_SET_DECODED_CONTENT_BYTES,
  MAXIMUM_PORTABLE_SKILL_SET_EMBEDDED_PACKAGE_BYTES,
  MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES,
  PORTABLE_SKILL_SET_ENVELOPE_FORMAT,
  SKILL_SET_SOURCE_MANIFEST_FORMAT,
} from "../src";

const textEncoder = new TextEncoder();

const component = (ordinal: number, logicalSkillId: string, hashDigit: string) => ({
  ordinal,
  logicalSkillId,
  sourceRevisionSha256: hashDigit.repeat(64),
  sourcePackageObjectSha256: String(Number(hashDigit) + 1).repeat(64),
});

const expectReason = <A>(effect: Effect.Effect<A, { readonly reason: string }>, reason: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    assert.strictEqual(failure.reason, reason);
  });

const changedHash = (hash: string) =>
  hash.startsWith("0") ? `1${hash.slice(1)}` : `0${hash.slice(1)}`;

describe("portable Skill Set", () => {
  it.effect("canonically encodes a source manifest independent of component input order", () =>
    Effect.gen(function* () {
      const input = {
        skillSetId: "engineering",
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex", "claude_code"] as const,
        components: [component(0, "tdd", "1"), component(1, "review", "3")],
      };

      const first = yield* encodeCanonicalSkillSetSourceManifest(input);
      const second = yield* encodeCanonicalSkillSetSourceManifest({
        ...input,
        harnesses: ["claude_code", "codex"],
        // oxlint-disable-next-line unicorn/no-array-reverse -- the spread isolates the fixture.
        components: [...input.components].reverse(),
      });
      assert.deepStrictEqual(first.bytes, second.bytes);

      const decoded = yield* decodeCanonicalSkillSetSourceManifest(first.bytes);
      assert.strictEqual(decoded.manifest.format, SKILL_SET_SOURCE_MANIFEST_FORMAT);
      assert.strictEqual(decoded.skillSetRevisionSha256, first.skillSetRevisionSha256);
      assert.strictEqual(decoded.sourceManifestObjectSha256, first.sourceManifestObjectSha256);
      assert.deepStrictEqual(
        decoded.manifest.components.map((current) => current.logicalSkillId),
        ["tdd", "review"],
      );
    }),
  );

  it.effect("round-trips sealed canonical V2 packages and preserves component terms", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [
          { path: "SKILL.md", content: textEncoder.encode("---\nlicense: MIT\n---\n# TDD\n") },
          { path: "LICENSE", content: textEncoder.encode("MIT terms") },
          { path: "NOTICE", content: textEncoder.encode("Copyright Example") },
        ],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });

      const encoded = yield* encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components: [
          {
            ordinal: 0,
            logicalSkillId: "tdd",
            sourceRevisionSha256: "1".repeat(64),
            sourcePackageObjectSha256: "2".repeat(64),
            sealedPackageBytes,
            terms: {
              licenseExpression: "MIT",
              licenseFilePath: "LICENSE",
              noticePaths: ["NOTICE"],
            },
          },
        ],
      });
      const decoded = yield* decodePortableSkillSetEnvelope(encoded.bytes);

      assert.strictEqual(decoded.envelope.format, PORTABLE_SKILL_SET_ENVELOPE_FORMAT);
      assert.strictEqual(decoded.envelope.skillSetRevisionSha256, source.skillSetRevisionSha256);
      assert.strictEqual(decoded.sourceManifestObjectSha256, source.sourceManifestObjectSha256);
      assert.strictEqual(
        decoded.portableSkillSetEnvelopeSha256,
        encoded.portableSkillSetEnvelopeSha256,
      );
      assert.strictEqual(decoded.envelope.components[0]?.terms.licenseFile?.path, "LICENSE");
      assert.strictEqual(decoded.envelope.components[0]?.terms.notices[0]?.path, "NOTICE");
      assert.deepStrictEqual(decoded.components[0]?.package.files, [
        { path: "LICENSE", content: textEncoder.encode("MIT terms") },
        { path: "NOTICE", content: textEncoder.encode("Copyright Example") },
        { path: "SKILL.md", content: textEncoder.encode("---\nlicense: MIT\n---\n# TDD\n") },
      ]);
    }),
  );

  it.effect("rejects a sealed package hash reused for two logical components", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Shared bytes\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1"), component(1, "review", "3")],
      });
      const sealed = (ordinal: number, logicalSkillId: string, hashDigit: string) => ({
        ordinal,
        logicalSkillId,
        sourceRevisionSha256: hashDigit.repeat(64),
        sourcePackageObjectSha256: String(Number(hashDigit) + 1).repeat(64),
        sealedPackageBytes,
        terms: { licenseExpression: "MIT", noticePaths: [] },
      });

      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [sealed(0, "tdd", "1"), sealed(1, "review", "3")],
        }),
        "component_identity_collision",
      );
    }),
  );

  it.effect("canonically orders sealed components independent of input order", () =>
    Effect.gen(function* () {
      const firstPackage = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# TDD\n") }],
      });
      const secondPackage = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Review\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1"), component(1, "review", "3")],
      });
      const components = [
        {
          ...component(0, "tdd", "1"),
          sealedPackageBytes: firstPackage,
          terms: { licenseExpression: "MIT", noticePaths: [] },
        },
        {
          ...component(1, "review", "3"),
          sealedPackageBytes: secondPackage,
          terms: { licenseExpression: "Apache-2.0", noticePaths: [] },
        },
      ];

      const canonical = yield* encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components,
      });
      const reversed = yield* encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        // oxlint-disable-next-line unicorn/no-array-reverse -- the spread isolates the fixture.
        components: [...components].reverse(),
      });
      assert.deepStrictEqual(reversed.bytes, canonical.bytes);
    }),
  );

  it.effect("rejects noncontiguous ordinals and source identity collisions", () =>
    Effect.gen(function* () {
      const base = {
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"] as const,
      };
      yield* expectReason(
        encodeCanonicalSkillSetSourceManifest({
          ...base,
          components: [component(1, "tdd", "1")],
        }),
        "invalid_manifest",
      );
      yield* expectReason(
        encodeCanonicalSkillSetSourceManifest({
          ...base,
          components: [component(0, "tdd", "1"), component(1, "tdd", "3")],
        }),
        "component_identity_collision",
      );
      yield* expectReason(
        encodeCanonicalSkillSetSourceManifest({
          ...base,
          components: [
            component(0, "tdd", "1"),
            { ...component(1, "review", "3"), sourcePackageObjectSha256: "2".repeat(64) },
          ],
        }),
        "component_identity_collision",
      );
    }),
  );

  it.effect("rejects component bindings that differ from the source manifest", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# TDD\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });
      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [
            {
              ...component(0, "different", "1"),
              sealedPackageBytes,
              terms: { licenseExpression: "MIT", noticePaths: [] },
            },
          ],
        }),
        "source_binding_mismatch",
      );
    }),
  );

  it.effect("produces no partial envelope when any source component lacks sealed bytes", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# TDD\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1"), component(1, "blocked", "3")],
      });

      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [
            {
              ...component(0, "tdd", "1"),
              sealedPackageBytes,
              terms: { licenseExpression: "MIT", noticePaths: [] },
            },
          ],
        }),
        "source_binding_mismatch",
      );
    }),
  );

  it.effect("rejects declared terms files missing from the sealed package", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# TDD\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });
      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [
            {
              ...component(0, "tdd", "1"),
              sealedPackageBytes,
              terms: {
                licenseExpression: "LicenseRef-Proprietary",
                licenseFilePath: "LICENSE",
                noticePaths: [],
              },
            },
          ],
        }),
        "invalid_terms",
      );
    }),
  );

  it.effect("rejects legacy and noncanonical embedded component packages", () =>
    Effect.gen(function* () {
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });
      const componentInput = (sealedPackageBytes: Uint8Array) => ({
        ...component(0, "tdd", "1"),
        sealedPackageBytes,
        terms: { licenseExpression: "MIT", noticePaths: [] },
      });
      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [
            componentInput(
              textEncoder.encode(
                JSON.stringify({
                  version: 1,
                  files: [{ path: "SKILL.md", contentBase64: "IyBMZWdhY3kK" }],
                }),
              ),
            ),
          ],
        }),
        "invalid_component_package",
      );
      yield* expectReason(
        encodePortableSkillSetEnvelope({
          sourceManifestBytes: source.bytes,
          components: [
            componentInput(
              textEncoder.encode(
                '{ "version": 2, "files": [{"path":"SKILL.md","contentBase64":"IyBUTUQK"}] }',
              ),
            ),
          ],
        }),
        "invalid_component_package",
      );
    }),
  );

  it.effect("rejects tampered sealed hashes and noncanonical envelope bytes", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# TDD\n") }],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });
      const encoded = yield* encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components: [
          {
            ...component(0, "tdd", "1"),
            sealedPackageBytes,
            terms: { licenseExpression: "MIT", noticePaths: [] },
          },
        ],
      });
      const text = new TextDecoder().decode(encoded.bytes);
      const originalHash = encoded.envelope.components[0]!.sealedPackageObjectSha256;
      const tamperedHash = changedHash(originalHash);
      yield* expectReason(
        decodePortableSkillSetEnvelope(
          textEncoder.encode(
            text.replace(
              `"sealedPackageObjectSha256":"${originalHash}"`,
              `"sealedPackageObjectSha256":"${tamperedHash}"`,
            ),
          ),
        ),
        "hash_mismatch",
      );
      yield* expectReason(
        decodePortableSkillSetEnvelope(textEncoder.encode(`${text}\n`)),
        "hash_mismatch",
      );
    }),
  );

  it.effect("rejects tampered root, packaged BOM, license, and notice hashes", () =>
    Effect.gen(function* () {
      const sealedPackageBytes = yield* encodePortablePackageBundle({
        files: [
          { path: "SKILL.md", content: textEncoder.encode("# TDD\n") },
          { path: "LICENSE", content: textEncoder.encode("MIT terms") },
          { path: "NOTICE", content: textEncoder.encode("Copyright Example") },
        ],
      });
      const source = yield* encodeCanonicalSkillSetSourceManifest({
        skillSetId: "engineering",
        name: "Engineering",
        description: "",
        harnesses: ["codex"],
        components: [component(0, "tdd", "1")],
      });
      const encoded = yield* encodePortableSkillSetEnvelope({
        sourceManifestBytes: source.bytes,
        components: [
          {
            ...component(0, "tdd", "1"),
            sealedPackageBytes,
            terms: {
              licenseExpression: "MIT",
              licenseFilePath: "LICENSE",
              noticePaths: ["NOTICE"],
            },
          },
        ],
      });
      const text = new TextDecoder().decode(encoded.bytes);
      const envelopeComponent = encoded.envelope.components[0]!;
      const license = envelopeComponent.terms.licenseFile!;
      const notice = envelopeComponent.terms.notices[0]!;
      const replacements = [
        {
          original: `"sourceBomSha256":"${encoded.envelope.sourceBomSha256}"`,
          changed: `"sourceBomSha256":"${changedHash(encoded.envelope.sourceBomSha256)}"`,
          reason: "source_binding_mismatch",
        },
        {
          original: `"packagedBomSha256":"${encoded.envelope.packagedBomSha256}"`,
          changed: `"packagedBomSha256":"${changedHash(encoded.envelope.packagedBomSha256)}"`,
          reason: "hash_mismatch",
        },
        {
          original: `"licenseFile":{"path":"${license.path}","sha256":"${license.sha256}"}`,
          changed: `"licenseFile":{"path":"${license.path}","sha256":"${changedHash(license.sha256)}"}`,
          reason: "invalid_terms",
        },
        {
          original: `"notices":[{"path":"${notice.path}","sha256":"${notice.sha256}"}]`,
          changed: `"notices":[{"path":"${notice.path}","sha256":"${changedHash(notice.sha256)}"}]`,
          reason: "invalid_terms",
        },
      ];
      for (const replacement of replacements) {
        assert.notStrictEqual(text.replace(replacement.original, replacement.changed), text);
        yield* expectReason(
          decodePortableSkillSetEnvelope(
            textEncoder.encode(text.replace(replacement.original, replacement.changed)),
          ),
          replacement.reason,
        );
      }
    }),
  );

  it.effect("rejects envelopes beyond the explicit 25 MiB ceiling before parsing", () =>
    expectReason(
      decodePortableSkillSetEnvelope(new Uint8Array(MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES + 1)),
      "encoded_envelope_too_large",
    ),
  );

  it.effect(
    "bounds embedded bytes before parsing and decoded aggregate expansion",
    () =>
      Effect.gen(function* () {
        const source = yield* encodeCanonicalSkillSetSourceManifest({
          skillSetId: "engineering",
          name: "Engineering",
          description: "",
          harnesses: ["codex"],
          components: [component(0, "tdd", "1")],
        });
        const input = (sealedPackageBytes: Uint8Array) => ({
          sourceManifestBytes: source.bytes,
          components: [
            {
              ...component(0, "tdd", "1"),
              sealedPackageBytes,
              terms: { licenseExpression: "MIT", noticePaths: [] },
            },
          ],
        });
        yield* expectReason(
          encodePortableSkillSetEnvelope(
            input(new Uint8Array(MAXIMUM_PORTABLE_SKILL_SET_EMBEDDED_PACKAGE_BYTES + 1)),
          ),
          "embedded_packages_too_large",
        );

        const firstFileBytes = 9 * 1024 * 1024;
        const expandingPackage = yield* encodePortablePackageBundle({
          files: [
            { path: "SKILL.md", content: new Uint8Array(firstFileBytes) },
            {
              path: "payload.bin",
              content: new Uint8Array(
                MAXIMUM_PORTABLE_SKILL_SET_DECODED_CONTENT_BYTES - firstFileBytes + 1,
              ),
            },
          ],
        });
        yield* expectReason(
          encodePortableSkillSetEnvelope(input(expandingPackage)),
          "decoded_content_too_large",
        );
      }),
    30_000,
  );
});
