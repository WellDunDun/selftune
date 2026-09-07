import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryObservation } from "@selftune/control-plane";
import { addDiscoveryMetadata } from "../../packages/runtime/library/discovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function discover(frontmatter: string) {
  const root = mkdtempSync(join(tmpdir(), "selftune-discovery-metadata-"));
  roots.push(root);
  const path = join(root, "SKILL.md");
  writeFileSync(path, `---\n${frontmatter}\n---\nInstructions stay out of discovery.\n`);
  const observation = LibraryObservation.make({
    skillName: "marketing",
    sourceKind: "installed",
    contentHash: "a".repeat(64),
    packagePath: root,
    skillPath: path,
    harness: "codex",
    scope: "project",
    projectRoot: root,
    active: true,
    modifiedAt: "2026-09-07T00:00:00.000Z",
    lastUsedAt: null,
    origin: null,
    updateStatus: "untracked",
  });
  return { original: observation, enriched: addDiscoveryMetadata([observation], [])[0] };
}

describe("skill discovery frontmatter", () => {
  test("retains description, usage, and disabled-invocation intent", () => {
    const result = discover(
      "description: Marketing launches\nwhen_to_use: Preparing a launch\ndisable-model-invocation: true",
    );
    expect(result.enriched?.discovery).toEqual({
      name: "marketing",
      description: "Marketing launches",
      whenToUse: "Preparing a launch",
      disableModelInvocation: true,
      originalSkillPath: result.original.skillPath,
    });
  });

  test.each([
    "",
    'when_to_use: [invalid]\ndisable-model-invocation: "true"',
    "when_to_use: null\ndisable-model-invocation: 1",
  ])("keeps valid descriptions when optional metadata is absent or malformed: %s", (optional) => {
    expect(
      discover(`description: Marketing launches\n${optional}`).enriched?.discovery,
    ).toMatchObject({
      description: "Marketing launches",
      whenToUse: "",
      disableModelInvocation: false,
    });
  });

  test.each(["description: [invalid]", "description: null", "name: marketing", "[broken"])(
    "leaves the observation unchanged when required frontmatter is invalid: %s",
    (frontmatter) => {
      const result = discover(frontmatter);
      expect(result.enriched).toBe(result.original);
      expect(result.enriched?.discovery).toBeUndefined();
    },
  );
});
