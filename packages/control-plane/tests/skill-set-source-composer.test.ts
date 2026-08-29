import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { composeSkillSetSourcePreview } from "../src/domain/skill-set-source-composer";

const resolved = (index: number, kind: "skills-sh" | "github" | "folder" | "archive") => ({
  sourceId: `${kind}-${index}`,
  kind,
  source: `${kind}:source-${index}`,
  status: "resolved" as const,
  resolution:
    kind === "skills-sh"
      ? {
          sourceId: `${kind}-${index}`,
          kind,
          source: `${kind}:source-${index}`,
          logicalSkillId: `${kind}-${index}`,
          displayName: `${kind} ${index}`,
          sourceRevisionSha256: String(index + 1).repeat(64),
          sourcePackageObjectSha256: String(index + 5).repeat(64),
          installSpec: `owner/repo --skill skill-${index}`,
        }
      : {
          sourceId: `${kind}-${index}`,
          kind,
          source: `${kind}:source-${index}`,
          logicalSkillId: `${kind}-${index}`,
          displayName: `${kind} ${index}`,
          sourceRevisionSha256: String(index + 1).repeat(64),
          sourcePackageObjectSha256: String(index + 5).repeat(64),
        },
});

describe("Skill Set source composer", () => {
  it.effect("previews every supported source kind with exact immutable pins", () =>
    Effect.gen(function* () {
      const preview = yield* composeSkillSetSourcePreview({
        name: "Engineering",
        description: "Cross-source set",
        harnesses: ["codex"],
        sources: [
          resolved(0, "skills-sh"),
          resolved(1, "github"),
          resolved(2, "folder"),
          resolved(3, "archive"),
        ],
      });
      assert.strictEqual(preview.components.length, 4);
      assert.isFalse(preview.directInstall);
      assert.include(preview.portableImportCommand, "selftune sets import");
    }),
  );

  it.effect("fails the whole preview when any source is unresolved", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        composeSkillSetSourcePreview({
          name: "Engineering",
          description: "",
          harnesses: ["codex"],
          sources: [
            resolved(0, "github"),
            {
              sourceId: "skills-sh-1",
              kind: "skills-sh",
              source: "owner/repo",
              status: "unresolved",
              message: "Exact package revision is unavailable",
            },
          ],
        }),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "unresolved_source");
      }
    }),
  );

  it.effect("rejects a resolver response bound to a different requested source", () =>
    Effect.gen(function* () {
      const source = resolved(0, "github");
      const result = yield* Effect.result(
        composeSkillSetSourcePreview({
          name: "Engineering",
          description: "",
          harnesses: ["codex"],
          sources: [{ ...source, resolution: { ...source.resolution, source: "github:other" } }],
        }),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "source_binding_mismatch");
      }
    }),
  );

  it.effect("rejects duplicate logical components instead of emitting a partial preview", () =>
    Effect.gen(function* () {
      const first = resolved(0, "folder");
      const second = resolved(1, "archive");
      const result = yield* Effect.result(
        composeSkillSetSourcePreview({
          name: "Engineering",
          description: "",
          harnesses: ["codex"],
          sources: [
            first,
            {
              ...second,
              resolution: {
                ...second.resolution,
                logicalSkillId: first.resolution.logicalSkillId,
              },
            },
          ],
        }),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "duplicate_component");
      }
    }),
  );
});
