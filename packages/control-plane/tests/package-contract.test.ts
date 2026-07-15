import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { PackageLineage } from "../src";

describe("canonical package lineage", () => {
  it("round-trips Skill to Source to Revision to Release to Bundle to Install", () => {
    const input = {
      skill: { skillId: "research", name: "Research" },
      sources: [
        {
          sourceId: "source",
          skillId: "research",
          editablePath: "/draft",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      revisions: [
        {
          revisionHash: "a".repeat(64),
          skillId: "research",
          sourceId: "source",
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      releases: [
        {
          releaseId: "release",
          skillId: "research",
          revisionHash: "a".repeat(64),
          channel: "stable",
          approvedAt: "2026-07-15T01:00:00.000Z",
        },
      ],
      bundles: [
        {
          bundleHash: "b".repeat(64),
          releaseId: "release",
          objectHash: "c".repeat(64),
          byteLength: 128,
        },
      ],
      installs: [
        {
          installId: "install",
          bundleHash: "b".repeat(64),
          harness: "codex",
          scope: "project",
          materializedPath: "/project/.agents/skills/research",
          active: true,
        },
      ],
    };
    const decoded = Schema.decodeUnknownSync(PackageLineage)(input);
    assert.deepStrictEqual(Schema.encodeSync(PackageLineage)(decoded), input);
  });
});
