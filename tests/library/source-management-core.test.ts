import { describe, expect, it } from "bun:test";

import {
  normalizeGitHubRepository,
  sourceFolderPath,
  sourceOrigin,
  sourceSubtreeHash,
} from "@selftune/source-management/metadata";

describe("source management core", () => {
  it("normalizes supported GitHub repository identities", () => {
    expect(normalizeGitHubRepository("git@github.com:selftune-dev/selftune.git")).toBe(
      "selftune-dev/selftune",
    );
    expect(normalizeGitHubRepository("https://github.com/selftune-dev/selftune.git")).toBe(
      "selftune-dev/selftune",
    );
    expect(normalizeGitHubRepository("not a source")).toBeNull();
  });

  it("resolves a skill folder to its immutable subtree hash", () => {
    const tree = {
      sha: "root-tree",
      tree: [{ path: "skills/research", type: "tree", sha: "research-tree" }],
    };
    expect(sourceFolderPath("skills\\research\\SKILL.md")).toBe("skills/research");
    expect(sourceSubtreeHash(tree, "skills/research/SKILL.md")).toBe("research-tree");
    expect(sourceSubtreeHash(tree, "SKILL.md")).toBe("root-tree");
  });

  it("derives user-facing origin metadata from a lock entry", () => {
    expect(
      sourceOrigin({
        source: "selftune-dev/selftune",
        sourceType: "github",
        skillPath: "skill/SKILL.md",
      }),
    ).toEqual({
      kind: "github",
      label: "selftune-dev/selftune",
      url: "https://github.com/selftune-dev/selftune",
    });
  });
});
