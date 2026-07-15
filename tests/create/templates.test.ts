import { describe, expect, it } from "bun:test";

import {
  buildCreateSkillDraft,
  buildCreateSkillManifest,
  formatCreateSkillDraft,
  slugifyCreateSkillName,
} from "../../packages/runtime/create/templates.js";

describe("create skill templates", () => {
  it("slugifies display names into filesystem-safe skill names", () => {
    expect(slugifyCreateSkillName("Research Assistant")).toBe("research-assistant");
    expect(slugifyCreateSkillName("Docs / API Helper")).toBe("docs-api-helper");
  });

  it("builds the default create manifest", () => {
    expect(buildCreateSkillManifest()).toEqual({
      version: 1,
      entry_workflow: "workflows/default.md",
      supports_package_replay: true,
      expected_resources: {
        workflows: true,
        references: false,
        scripts: false,
        assets: false,
      },
    });
  });

  it("builds a draft package with the expected skeleton", () => {
    const draft = buildCreateSkillDraft({
      name: "Research Assistant",
      description: "Use when the user needs structured research help.",
      outputDir: "/tmp/repo/.agents/skills",
    });

    expect(draft.skill_name).toBe("research-assistant");
    expect(draft.skill_dir).toBe("/tmp/repo/.agents/skills/research-assistant");
    expect(draft.files.map((file) => file.relative_path)).toEqual([
      "SKILL.md",
      "workflows/default.md",
      "references/overview.md",
      "selftune.create.json",
    ]);
    expect(draft.files[0]?.content).toContain("generated_by: selftune create init");
    expect(draft.files[0]?.content).toContain(
      "| Default execution path | Default | workflows/default.md |",
    );
    expect(draft.files[1]?.content).toContain(
      "Replace this placeholder with the concrete execution flow",
    );
    expect(draft.files[2]?.content).toContain(
      "Working description: Use when the user needs structured research help.",
    );
    expect(draft.files[3]?.content).toContain('"entry_workflow": "workflows/default.md"');
  });

  it("formats a concise package summary", () => {
    const draft = buildCreateSkillDraft({
      name: "Research Assistant",
      description: "Use when the user needs structured research help.",
      outputDir: "/tmp/repo/.agents/skills",
    });

    const summary = formatCreateSkillDraft(draft);
    expect(summary).toContain("Draft skill package: Research Assistant");
    expect(summary).toContain("Skill name: research-assistant");
    expect(summary).toContain("Files:");
    expect(summary).toContain("Empty directories:");
  });
});
