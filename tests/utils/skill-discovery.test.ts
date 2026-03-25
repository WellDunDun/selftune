import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { classifySkillPath } from "../../cli/selftune/utils/skill-discovery.js";

describe("classifySkillPath", () => {
  test("classifies project, global, admin, system, and unknown skill paths", () => {
    const homeDir = "/tmp/selftune-home";
    const codexHome = "/tmp/selftune-codex";

    expect(
      classifySkillPath(
        "/tmp/workspace/my-repo/.agents/skills/selftune/SKILL.md",
        homeDir,
        codexHome,
      ),
    ).toEqual({
      skill_scope: "project",
      skill_project_root: "/tmp/workspace/my-repo",
      skill_registry_dir: "/tmp/workspace/my-repo/.agents/skills",
    });

    expect(
      classifySkillPath(
        join(homeDir, ".agents", "skills", "paperclip", "SKILL.md"),
        homeDir,
        codexHome,
      ),
    ).toEqual({
      skill_scope: "global",
      skill_registry_dir: join(homeDir, ".agents", "skills"),
    });

    expect(classifySkillPath("/etc/codex/skills/reins/SKILL.md", homeDir, codexHome)).toEqual({
      skill_scope: "admin",
      skill_registry_dir: "/etc/codex/skills",
    });

    expect(
      classifySkillPath(
        join(codexHome, "skills", ".system", "skill-installer", "SKILL.md"),
        homeDir,
        codexHome,
      ),
    ).toEqual({
      skill_scope: "system",
      skill_registry_dir: join(codexHome, "skills", ".system"),
    });

    expect(classifySkillPath("(codex:selftune)", homeDir, codexHome)).toEqual({
      skill_scope: "unknown",
    });
  });
});
