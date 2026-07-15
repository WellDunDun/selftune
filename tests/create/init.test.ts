import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCreateSkillDraft } from "../../packages/runtime/create/init.js";
import { buildCreateSkillDraft } from "../../packages/runtime/create/templates.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

describe("selftune create init", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the expected package files and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-init-"));
    tempDirs.push(root);

    const draft = buildCreateSkillDraft({
      name: "Research Assistant",
      description: "Use when the user needs structured research help.",
      outputDir: root,
    });
    const result = writeCreateSkillDraft(draft);

    expect(result.overwritten).toBe(false);
    expect(existsSync(join(draft.skill_dir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(draft.skill_dir, "workflows/default.md"))).toBe(true);
    expect(existsSync(join(draft.skill_dir, "references/overview.md"))).toBe(true);
    expect(existsSync(join(draft.skill_dir, "scripts"))).toBe(true);
    expect(existsSync(join(draft.skill_dir, "assets"))).toBe(true);
    expect(readFileSync(join(draft.skill_dir, "selftune.create.json"), "utf-8")).toContain(
      '"supports_package_replay": true',
    );
  });

  it("refuses to overwrite an existing skill directory without --force", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-init-"));
    tempDirs.push(root);

    const draft = buildCreateSkillDraft({
      name: "Research Assistant",
      description: "Use when the user needs structured research help.",
      outputDir: root,
    });
    writeCreateSkillDraft(draft);

    expect(() => writeCreateSkillDraft(draft)).toThrow(CLIError);
  });

  it("overwrites scaffold files when --force is set", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-init-"));
    tempDirs.push(root);

    const draft = buildCreateSkillDraft({
      name: "Research Assistant",
      description: "Use when the user needs structured research help.",
      outputDir: root,
    });
    writeCreateSkillDraft(draft);
    writeFileSync(join(draft.skill_dir, "SKILL.md"), "stale\n", "utf-8");

    const result = writeCreateSkillDraft(draft, { force: true });

    expect(result.overwritten).toBe(true);
    expect(readFileSync(join(draft.skill_dir, "SKILL.md"), "utf-8")).toContain(
      "This draft skill package was initialized by selftune.",
    );
  });
});
