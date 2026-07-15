import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  SKILL_PLACEMENTS,
  SKILLS_AGENT_REGISTRY_UPSTREAM,
  resolveGlobalSkillPlacementDirs,
  resolveProjectSkillPlacementDirs,
} from "../../packages/runtime/vendor/skills-agent-registry.js";
import { getDefaultSkillSearchDirs } from "../../packages/runtime/utils/skill-discovery.js";

describe("vendored skills agent registry", () => {
  test("pins all upstream placement definitions independently of observability harnesses", () => {
    expect(SKILL_PLACEMENTS).toHaveLength(73);
    expect(SKILLS_AGENT_REGISTRY_UPSTREAM).toContain("5527c09adc367612b0bffd9c80e3bc28a6b01b6d");
    expect(SKILL_PLACEMENTS.find((placement) => placement.id === "cursor")).toMatchObject({
      projectSkillsDir: ".agents/skills",
      globalSkillsDir: ".cursor/skills",
    });
    expect(SKILL_PLACEMENTS.find((placement) => placement.id === "windsurf")).toMatchObject({
      projectSkillsDir: ".windsurf/skills",
      globalSkillsDir: ".codeium/windsurf/skills",
    });
  });

  test("resolves upstream global and ancestor project placement paths", () => {
    const homeDir = "/tmp/selftune-home";
    const workspace = "/tmp/projects/example/packages/app";
    const globalDirs = resolveGlobalSkillPlacementDirs({
      homeDir,
      configHome: join(homeDir, ".config"),
      codexHome: join(homeDir, ".custom-codex"),
    });
    const projectDirs = resolveProjectSkillPlacementDirs(workspace);

    expect(globalDirs).toContain(join(homeDir, ".cursor", "skills"));
    expect(globalDirs).toContain(join(homeDir, ".custom-codex", "skills"));
    expect(globalDirs).toContain(join(homeDir, ".config", "opencode", "skills"));
    expect(projectDirs).toContain(join(workspace, ".roo", "skills"));
    expect(projectDirs).toContain("/tmp/projects/example/.agents/skills");
  });

  test("feeds broad placements into default inventory discovery", () => {
    const dirs = getDefaultSkillSearchDirs(
      "/tmp/example",
      "/tmp/selftune-home",
      "/tmp/selftune-codex",
    );
    expect(dirs).toContain("/tmp/example/.roo/skills");
    expect(dirs).toContain("/tmp/selftune-home/.qwen/skills");
    expect(dirs).toContain("/tmp/selftune-codex/skills");
  });
});
