import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "selftune-creator-contrib-config-"));
const skillDir = mkdtempSync(join(tmpdir(), "selftune-creator-contrib-skills-"));
const originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
const originalSkillDirs = process.env.SELFTUNE_SKILL_DIRS;
process.env.SELFTUNE_CONFIG_DIR = configDir;
process.env.SELFTUNE_SKILL_DIRS = skillDir;

const mod = await import("../../cli/selftune/creator-contributions.js");
const { cliMain } = mod;

const originalArgv = [...process.argv];
const originalLog = console.log;

function seedSkill(skillName: string): string {
  const root = join(skillDir, skillName);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), `# ${skillName}\n`, "utf-8");
  return join(root, "SKILL.md");
}

beforeEach(() => {
  process.env.SELFTUNE_CONFIG_DIR = configDir;
  process.env.SELFTUNE_SKILL_DIRS = skillDir;
  process.argv = [...originalArgv];
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
});

afterAll(() => {
  console.log = originalLog;
  process.argv = originalArgv;
  if (originalConfigDir === undefined) {
    delete process.env.SELFTUNE_CONFIG_DIR;
  } else {
    process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
  }
  if (originalSkillDirs === undefined) {
    delete process.env.SELFTUNE_SKILL_DIRS;
  } else {
    process.env.SELFTUNE_SKILL_DIRS = originalSkillDirs;
  }
  rmSync(configDir, { recursive: true, force: true });
  rmSync(skillDir, { recursive: true, force: true });
});

describe("creator-contributions", () => {
  test("enable writes selftune.contribute.json for a skill", async () => {
    seedSkill("sc-search");
    console.log = mock(() => {});
    process.argv = [
      "bun",
      "selftune",
      "enable",
      "--skill",
      "sc-search",
      "--creator-id",
      "cr_search",
      "--signals",
      "trigger,grade",
    ];

    await cliMain();

    const config = JSON.parse(
      readFileSync(join(skillDir, "sc-search", "selftune.contribute.json"), "utf-8"),
    ) as {
      creator_id: string;
      contribution: { signals: string[] };
    };
    expect(config.creator_id).toBe("cr_search");
    expect(config.contribution.signals).toEqual(["trigger", "grade"]);
  });

  test("status reports discovered config for a skill", async () => {
    seedSkill("sc-search");
    writeFileSync(
      join(skillDir, "sc-search", "selftune.contribute.json"),
      JSON.stringify(
        {
          version: 1,
          creator_id: "cr_search",
          skill_name: "sc-search",
          contribution: { enabled: true, signals: ["trigger"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune", "status", "--skill", "sc-search"];

    await cliMain();

    expect(lines.join("\n")).toContain("Creator contribution config:");
    expect(lines.join("\n")).toContain("creator_id: cr_search");
    expect(lines.join("\n")).toContain("signals: trigger");
  });

  test("disable removes selftune.contribute.json", async () => {
    seedSkill("sc-search");
    writeFileSync(
      join(skillDir, "sc-search", "selftune.contribute.json"),
      JSON.stringify(
        {
          version: 1,
          creator_id: "cr_search",
          skill_name: "sc-search",
          contribution: { enabled: true, signals: ["trigger"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    console.log = mock(() => {});
    process.argv = ["bun", "selftune", "disable", "--skill", "sc-search"];

    await cliMain();

    expect(existsSync(join(skillDir, "sc-search", "selftune.contribute.json"))).toBe(false);
  });

  test("enable --all --prefix scaffolds configs for matching installed skills", async () => {
    seedSkill("sc-search");
    seedSkill("sc-compare");
    seedSkill("other-skill");
    console.log = mock(() => {});
    process.argv = [
      "bun",
      "selftune",
      "enable",
      "--all",
      "--prefix",
      "sc-",
      "--creator-id",
      "cr_search",
    ];

    await cliMain();

    expect(existsSync(join(skillDir, "sc-search", "selftune.contribute.json"))).toBe(true);
    expect(existsSync(join(skillDir, "sc-compare", "selftune.contribute.json"))).toBe(true);
    expect(existsSync(join(skillDir, "other-skill", "selftune.contribute.json"))).toBe(false);
  });

  test("enable --skill fails when creator id cannot be resolved", async () => {
    seedSkill("sc-search");
    console.log = mock(() => {});
    process.argv = ["bun", "selftune", "enable", "--skill", "sc-search"];

    await expect(cliMain()).rejects.toThrow("Creator ID is required.");
    expect(existsSync(join(skillDir, "sc-search", "selftune.contribute.json"))).toBe(false);
  });

  test("status lists installed skills that still lack creator config", async () => {
    seedSkill("sc-search");
    seedSkill("sc-compare");
    writeFileSync(
      join(skillDir, "sc-search", "selftune.contribute.json"),
      JSON.stringify(
        {
          version: 1,
          creator_id: "cr_search",
          skill_name: "sc-search",
          contribution: { enabled: true, signals: ["trigger"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune", "status"];

    await cliMain();

    expect(lines.join("\n")).toContain("Installed skills without creator contribution config:");
    expect(lines.join("\n")).toContain("sc-compare");
  });
});
