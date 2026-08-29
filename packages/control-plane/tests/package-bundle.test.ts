import { assert, describe, it } from "@effect/vitest";
import { Effect, Encoding, Schema } from "effect";

import {
  BACKUP_PACKAGE_BUNDLE_PROFILE,
  CANONICAL_PACKAGE_BUNDLE_VERSION,
  decodeCanonicalPortablePackageBundleV2,
  decodePortablePackageBundle,
  DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
  encodePortablePackageBundle,
  encodePortablePackageBundleUnknown,
  MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH,
  PACKAGE_BUNDLE_LIMITS,
  PortablePackageReleaseAuthority,
} from "../src";

const textEncoder = new TextEncoder();

const authority = PortablePackageReleaseAuthority.make({
  schema_version: 1,
  candidate_id: "candidate-1",
  evidence_snapshot_id: "evidence-1",
  candidate_revision_hash: "candidate-revision-1",
  skill_name: "example",
  draft_path: "/library/drafts/example",
  revision_hash: "revision-1",
  evaluated_at: "2026-07-20T12:00:00.000Z",
  replay_exit_code: 0,
  baseline_exit_code: 0,
  held_out_eval_ids: ["eval-1"],
  recommended: true,
  blockers: [],
  evaluation: { score: 1 },
});

const packageData = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly contentBase64: string;
  }>,
  version: 1 | 2 = 1,
  releaseAuthority?: PortablePackageReleaseAuthority,
) => (releaseAuthority ? { version, files, releaseAuthority } : { version, files });

const packageBytes = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly contentBase64: string;
  }>,
  version: 1 | 2 = 1,
): Uint8Array => textEncoder.encode(JSON.stringify(packageData(files, version)));

const file = (path: string, content: Uint8Array | string = "content") => ({
  path,
  contentBase64: Encoding.encodeBase64(
    Schema.is(Schema.String)(content) ? textEncoder.encode(content) : content,
  ),
});

const expectReason = <A>(effect: Effect.Effect<A, { readonly reason: string }>, reason: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    assert.strictEqual(failure.reason, reason);
  });

type NestedEvaluation = number | { readonly value: NestedEvaluation };

function nestedEvaluation(depth: number): NestedEvaluation {
  let value: NestedEvaluation = 1;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

describe("portable package bundle", () => {
  it.effect("round-trips binary contents using deterministic version 2 encoding", () =>
    Effect.gen(function* () {
      const files = [
        {
          path: "scripts/run.bin",
          content: new Uint8Array([0, 255, 1, 128]),
        },
        { path: "SKILL.md", content: textEncoder.encode("# Example\n") },
      ];

      const first = yield* encodePortablePackageBundle({ files });
      // oxlint-disable-next-line unicorn/no-array-reverse -- the spread isolates the test fixture.
      const second = yield* encodePortablePackageBundle({ files: [...files].reverse() });
      assert.deepStrictEqual(first, second);

      const decoded = yield* decodePortablePackageBundle(first);
      assert.strictEqual(decoded.version, CANONICAL_PACKAGE_BUNDLE_VERSION);
      assert.deepStrictEqual(
        decoded.files.map((entry) => entry.path),
        ["SKILL.md", "scripts/run.bin"],
      );
      assert.deepStrictEqual(decoded.files[0]?.content, textEncoder.encode("# Example\n"));
      assert.deepStrictEqual(decoded.files[1]?.content, new Uint8Array([0, 255, 1, 128]));
    }),
  );

  it.effect("preserves typed release authority through encode and decode", () =>
    Effect.gen(function* () {
      const bytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Released\n") }],
        releaseAuthority: authority,
      });
      const decoded = yield* decodePortablePackageBundle(bytes);
      assert.deepStrictEqual(decoded.releaseAuthority, authority);

      const legacy = yield* decodePortablePackageBundle(
        textEncoder.encode(JSON.stringify(packageData([file("SKILL.md")], 1, authority))),
      );
      assert.strictEqual(legacy.version, 1);
      assert.deepStrictEqual(legacy.releaseAuthority, authority);
    }),
  );

  it.effect("canonicalizes nested release evaluation object keys for version 2", () =>
    Effect.gen(function* () {
      const files = [{ path: "SKILL.md", content: textEncoder.encode("# Released\n") }];
      const first = yield* encodePortablePackageBundle({
        files,
        releaseAuthority: PortablePackageReleaseAuthority.make({
          ...authority,
          evaluation: { score: 1, detail: { alpha: true, beta: false } },
        }),
      });
      const second = yield* encodePortablePackageBundle({
        files,
        releaseAuthority: PortablePackageReleaseAuthority.make({
          ...authority,
          evaluation: { detail: { beta: false, alpha: true }, score: 1 },
        }),
      });
      assert.deepStrictEqual(first, second);
    }),
  );

  it.effect("rejects alternate top-level key order at the canonical V2 boundary", () =>
    Effect.gen(function* () {
      const canonical = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Canonical\n") }],
      });
      const decoded = yield* decodePortablePackageBundle(canonical);
      const alternate = textEncoder.encode(
        JSON.stringify({
          files: [{ path: "SKILL.md", contentBase64: "IyBDYW5vbmljYWwK" }],
          version: 2,
        }),
      );
      assert.strictEqual((yield* decodePortablePackageBundle(alternate)).version, 2);
      yield* expectReason(decodeCanonicalPortablePackageBundleV2(alternate), "invalid_package");
      assert.deepStrictEqual(yield* decodeCanonicalPortablePackageBundleV2(canonical), decoded);
    }),
  );

  it.effect("rejects alternate nested release evaluation key order", () =>
    Effect.gen(function* () {
      const canonical = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Released\n") }],
        releaseAuthority: PortablePackageReleaseAuthority.make({
          ...authority,
          evaluation: { detail: { alpha: true, beta: false }, score: 1 },
        }),
      });
      const text = new TextDecoder().decode(canonical);
      const alternateText = text.replace(
        '"evaluation":{"detail":{"alpha":true,"beta":false},"score":1}',
        '"evaluation":{"score":1,"detail":{"beta":false,"alpha":true}}',
      );
      assert.notStrictEqual(alternateText, text);
      const alternate = textEncoder.encode(alternateText);
      assert.strictEqual((yield* decodePortablePackageBundle(alternate)).version, 2);
      yield* expectReason(decodeCanonicalPortablePackageBundleV2(alternate), "invalid_package");
    }),
  );

  it.effect("preserves special JSON object keys while canonicalizing release evaluation", () =>
    Effect.gen(function* () {
      const evaluation = { ["__proto__"]: { safe: true }, score: 1 };
      const bytes = yield* encodePortablePackageBundle({
        files: [{ path: "SKILL.md", content: textEncoder.encode("# Released\n") }],
        releaseAuthority: PortablePackageReleaseAuthority.make({
          ...authority,
          evaluation,
        }),
      });
      const decoded = yield* decodePortablePackageBundle(bytes);
      assert.deepStrictEqual(decoded.releaseAuthority?.evaluation, evaluation);
    }),
  );

  it.effect("rejects non-JSON release evaluation numbers", () =>
    Effect.gen(function* () {
      const finiteAuthority = PortablePackageReleaseAuthority.make({
        ...authority,
        evaluation: 0,
      });
      const encoded = JSON.stringify(packageData([file("SKILL.md")], 1, finiteAuthority));
      yield* expectReason(
        decodePortablePackageBundle(
          textEncoder.encode(encoded.replace('"evaluation":0', '"evaluation":1e999')),
        ),
        "invalid_package",
      );
    }),
  );

  it.effect("rejects cyclic encoder authority input through the typed error channel", () =>
    Effect.gen(function* () {
      interface CyclicEvaluation {
        self?: CyclicEvaluation;
      }
      const cyclic: CyclicEvaluation = {};
      cyclic.self = cyclic;
      yield* expectReason(
        encodePortablePackageBundleUnknown({
          files: [
            {
              path: "SKILL.md",
              content: textEncoder.encode("# Released\n"),
            },
          ],
          releaseAuthority: { ...authority, evaluation: cyclic },
        }),
        "invalid_package",
      );
    }),
  );

  it.effect("bounds release evaluation depth before recursive schema decoding", () =>
    Effect.gen(function* () {
      const files = [{ path: "SKILL.md", content: textEncoder.encode("# Released\n") }];
      const atLimit = {
        ...authority,
        evaluation: nestedEvaluation(MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH),
      };
      yield* encodePortablePackageBundleUnknown({ files, releaseAuthority: atLimit });

      const beyondLimit = {
        ...authority,
        evaluation: nestedEvaluation(MAXIMUM_RELEASE_AUTHORITY_EVALUATION_DEPTH + 1),
      };
      yield* expectReason(
        encodePortablePackageBundleUnknown({ files, releaseAuthority: beyondLimit }),
        "invalid_package",
      );
      yield* expectReason(
        decodePortablePackageBundle(
          textEncoder.encode(
            JSON.stringify({
              version: 2,
              files: [file("SKILL.md", "# Released\n")],
              releaseAuthority: beyondLimit,
            }),
          ),
        ),
        "invalid_package",
      );
    }),
  );

  it.effect("rejects incomplete release authority instead of discarding it", () =>
    expectReason(
      decodePortablePackageBundle(
        textEncoder.encode(
          JSON.stringify({
            ...packageData([file("SKILL.md")]),
            releaseAuthority: { schema_version: 1, recommended: true },
          }),
        ),
      ),
      "invalid_package",
    ),
  );

  it.effect("accepts legacy file order but requires canonical version 2 order", () =>
    Effect.gen(function* () {
      const legacy = yield* decodePortablePackageBundle(
        packageBytes([file("scripts/run.ts"), file("SKILL.md")], 1),
      );
      assert.deepStrictEqual(
        legacy.files.map((entry) => entry.path),
        ["scripts/run.ts", "SKILL.md"],
      );

      yield* expectReason(
        decodePortablePackageBundle(packageBytes([file("scripts/run.ts"), file("SKILL.md")], 2)),
        "invalid_package",
      );
    }),
  );

  it.effect("rejects traversal and non-normalized relative paths", () =>
    Effect.gen(function* () {
      for (const path of [
        "../SKILL.md",
        "references/../../SKILL.md",
        "./SKILL.md",
        "references//guide.md",
        "references/../SKILL.md",
        "references\\guide.md",
        "references/",
      ]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([file("SKILL.md"), file(path)])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("rejects POSIX, Windows absolute, drive-relative, and UNC paths", () =>
    Effect.gen(function* () {
      for (const path of [
        "/SKILL.md",
        "C:/SKILL.md",
        "C:SKILL.md",
        "C:\\SKILL.md",
        "//host/SKILL.md",
      ]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([file("SKILL.md"), file(path)])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("rejects Windows device, stream, and trailing-dot path aliases", () =>
    Effect.gen(function* () {
      for (const path of [
        "NUL",
        "references/CON.txt",
        "references/file.md:stream",
        "references/file.md.",
        "references/file.md ",
      ]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([file("SKILL.md"), file(path)])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("rejects non-NFC and ill-formed Unicode paths", () =>
    Effect.gen(function* () {
      for (const path of ["references/cafe\u0301.md", "references/\ud800.md"]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([file("SKILL.md"), file(path)])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("rejects non-ASCII paths rather than guessing filesystem Unicode folding", () =>
    Effect.gen(function* () {
      for (const path of ["references/Σ.md", "references/ς.md", "référence.md"]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([file("SKILL.md"), file(path)])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("rejects exact and case-insensitive path collisions", () =>
    Effect.gen(function* () {
      for (const collidingPath of ["SKILL.md", "skill.md"]) {
        yield* expectReason(
          decodePortablePackageBundle(
            packageBytes([file("SKILL.md", "one"), file(collidingPath, "two")]),
          ),
          "duplicate_path",
        );
      }
    }),
  );

  it.effect("rejects file and descendant path collisions on encode and decode", () =>
    Effect.gen(function* () {
      for (const descendantPath of ["a/b", "A/b"]) {
        yield* expectReason(
          encodePortablePackageBundle({
            files: [
              { path: "SKILL.md", content: textEncoder.encode("# Skill\n") },
              { path: "a", content: textEncoder.encode("ancestor") },
              { path: descendantPath, content: textEncoder.encode("descendant") },
            ],
          }),
          "duplicate_path",
        );
        yield* expectReason(
          decodePortablePackageBundle(
            packageBytes([file("SKILL.md"), file("a"), file(descendantPath)]),
          ),
          "duplicate_path",
        );
      }
    }),
  );

  it.effect("rejects malformed and non-canonical base64", () =>
    Effect.gen(function* () {
      for (const contentBase64 of ["not base64", "AB=="]) {
        yield* expectReason(
          decodePortablePackageBundle(packageBytes([{ path: "SKILL.md", contentBase64 }])),
          "invalid_package",
        );
      }
    }),
  );

  it.effect("requires an exact root SKILL.md", () =>
    Effect.gen(function* () {
      yield* expectReason(
        decodePortablePackageBundle(packageBytes([file("nested/SKILL.md")])),
        "missing_skill_manifest",
      );
      yield* expectReason(
        decodePortablePackageBundle(packageBytes([file("skill.md")])),
        "missing_skill_manifest",
      );
    }),
  );

  it.effect("rejects entries that describe anything other than a regular file", () =>
    expectReason(
      decodePortablePackageBundle(
        textEncoder.encode(
          JSON.stringify({
            version: 1,
            files: [{ ...file("SKILL.md"), type: "symlink", target: "../outside" }],
          }),
        ),
      ),
      "invalid_package",
    ),
  );

  it.effect("accepts 500 files and rejects the 501st", () =>
    Effect.gen(function* () {
      const maximum = [
        file("SKILL.md"),
        ...Array.from({ length: PACKAGE_BUNDLE_LIMITS.maximumFileCount - 1 }, (_, index) =>
          file(`references/${index}.md`, ""),
        ),
      ];
      assert.strictEqual(
        (yield* decodePortablePackageBundle(packageBytes(maximum))).files.length,
        500,
      );

      yield* expectReason(
        decodePortablePackageBundle(packageBytes([...maximum, file("references/overflow.md")])),
        "invalid_package",
      );
    }),
  );

  it.effect("preflights pathological file counts before entry validation", () =>
    expectReason(
      decodePortablePackageBundle(
        textEncoder.encode(
          JSON.stringify({
            version: 1,
            files: Array.from({ length: 100_000 }, () => ({})),
          }),
        ),
      ),
      "invalid_package",
    ),
  );

  it.effect(
    "accepts the per-file decoded limit and rejects one byte above it",
    () =>
      Effect.gen(function* () {
        const maximum = new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes);
        const decoded = yield* decodePortablePackageBundle(
          packageBytes([file("SKILL.md", maximum)]),
        );
        assert.strictEqual(decoded.files[0]?.content.byteLength, maximum.byteLength);

        yield* expectReason(
          decodePortablePackageBundle(
            packageBytes([
              file("SKILL.md", new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes + 1)),
            ]),
          ),
          "decoded_file_too_large",
        );
      }),
    30_000,
  );

  it.effect("preflights encoder file bytes before base64 materialization", () =>
    expectReason(
      encodePortablePackageBundle({
        files: [
          {
            path: "SKILL.md",
            content: new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes + 1),
          },
        ],
      }),
      "decoded_file_too_large",
    ),
  );

  it.effect(
    "rejects decoded aggregate overflow before serialized-size overflow",
    () =>
      expectReason(
        encodePortablePackageBundle({
          files: [
            {
              path: "SKILL.md",
              content: new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes),
            },
            {
              path: "assets/one.bin",
              content: new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes),
            },
            {
              path: "assets/two.bin",
              content: new Uint8Array(
                PACKAGE_BUNDLE_LIMITS.maximumDecodedPackageBytes -
                  2 * PACKAGE_BUNDLE_LIMITS.maximumDecodedFileBytes +
                  1,
              ),
            },
          ],
        }),
        "decoded_package_too_large",
      ),
    15_000,
  );

  it.effect(
    "accepts the encoded JSON limit and rejects one byte above it",
    () =>
      Effect.gen(function* () {
        const minimal = packageBytes([file("SKILL.md")]);
        const maximum = new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumEncodedPackageBytes);
        maximum.fill(32);
        maximum.set(minimal);
        assert.strictEqual((yield* decodePortablePackageBundle(maximum)).files.length, 1);

        yield* expectReason(
          decodePortablePackageBundle(
            new Uint8Array(PACKAGE_BUNDLE_LIMITS.maximumEncodedPackageBytes + 1),
          ),
          "encoded_package_too_large",
        );
      }),
    15_000,
  );

  it.effect(
    "keeps larger private backups within the 50 MiB object ceiling without making them distributable",
    () =>
      Effect.gen(function* () {
        const content = new Uint8Array(26 * 1024 * 1024);
        const bytes = yield* encodePortablePackageBundle(
          { files: [{ path: "SKILL.md", content }] },
          BACKUP_PACKAGE_BUNDLE_PROFILE,
        );
        assert.isTrue(
          bytes.byteLength > DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes,
        );
        assert.isTrue(bytes.byteLength <= BACKUP_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes);

        const restored = yield* decodePortablePackageBundle(bytes, BACKUP_PACKAGE_BUNDLE_PROFILE);
        assert.strictEqual(restored.files[0]?.content.byteLength, content.byteLength);
        yield* expectReason(
          decodePortablePackageBundle(bytes, DISTRIBUTION_PACKAGE_BUNDLE_PROFILE),
          "encoded_package_too_large",
        );
      }),
    30_000,
  );

  it.effect(
    "rejects a backup whose canonical wire bytes exceed the server object ceiling",
    () =>
      expectReason(
        encodePortablePackageBundle(
          {
            files: [
              {
                path: "SKILL.md",
                content: new Uint8Array(38 * 1024 * 1024),
              },
            ],
          },
          BACKUP_PACKAGE_BUNDLE_PROFILE,
        ),
        "encoded_package_too_large",
      ),
    30_000,
  );

  it.effect("retains bounded schema diagnostics with the offending path", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decodePortablePackageBundle(
          packageBytes([file("SKILL.md"), { path: "../escape.md", contentBase64: "not base64" }]),
        ),
      );
      assert.strictEqual(failure.reason, "invalid_package");
      assert.strictEqual(failure.path, "files.1.path");
      assert.isTrue((failure.detail?.length ?? 0) > 0);
      assert.isTrue((failure.detail?.length ?? 0) <= 240);
    }),
  );
});
