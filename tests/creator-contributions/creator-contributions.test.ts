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

const configMod = await import("../../cli/selftune/contribution-config.js");
const { isValidCreatorUUID, writeCreatorContributionConfig, discoverCreatorContributionConfigs } =
  configMod;

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

  test("enable with UUID creator-id writes and round-trips correctly", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    seedSkill("sc-roundtrip");
    console.log = mock(() => {});
    process.argv = [
      "bun",
      "selftune",
      "enable",
      "--skill",
      "sc-roundtrip",
      "--creator-id",
      uuid,
      "--signals",
      "trigger,grade,miss_category",
      "--message",
      "Help improve this skill.",
      "--privacy-url",
      "https://example.com/privacy",
    ];

    await cliMain();

    const raw = JSON.parse(
      readFileSync(join(skillDir, "sc-roundtrip", "selftune.contribute.json"), "utf-8"),
    ) as {
      version: number;
      creator_id: string;
      skill_name: string;
      contribution: { enabled: boolean; signals: string[]; message: string; privacy_url: string };
    };
    expect(raw.version).toBe(1);
    expect(raw.creator_id).toBe(uuid);
    expect(raw.skill_name).toBe("sc-roundtrip");
    expect(raw.contribution.enabled).toBe(true);
    expect(raw.contribution.signals).toEqual(["trigger", "grade", "miss_category"]);
    expect(raw.contribution.message).toBe("Help improve this skill.");
    expect(raw.contribution.privacy_url).toBe("https://example.com/privacy");

    // Verify discovery round-trips the config back
    const discovered = discoverCreatorContributionConfigs([skillDir]);
    const match = discovered.find((c) => c.skill_name === "sc-roundtrip");
    expect(match).toBeDefined();
    expect(match!.creator_id).toBe(uuid);
    expect(match!.contribution.signals).toEqual(["trigger", "grade", "miss_category"]);
  });

  test("isValidCreatorUUID accepts valid UUIDs and rejects non-UUIDs", () => {
    expect(isValidCreatorUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidCreatorUUID("ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
    expect(isValidCreatorUUID("not-a-uuid")).toBe(false);
    expect(isValidCreatorUUID("cr_search")).toBe(false);
    expect(isValidCreatorUUID("SELFTUNE_CREATOR_UUID")).toBe(false);
    expect(isValidCreatorUUID("")).toBe(false);
  });

  test("writeCreatorContributionConfig round-trips with UUID creator_id", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const skillPath = seedSkill("sc-write-roundtrip");

    const result = writeCreatorContributionConfig({
      creator_id: uuid,
      skill_name: "sc-write-roundtrip",
      skill_path: skillPath,
      signals: ["trigger", "grade"],
      message: "Test message",
      privacy_url: "https://example.com/privacy",
    });

    expect(result.creator_id).toBe(uuid);
    expect(result.skill_name).toBe("sc-write-roundtrip");
    expect(result.contribution.signals).toEqual(["trigger", "grade"]);

    // Read it back from disk
    const onDisk = JSON.parse(
      readFileSync(join(skillDir, "sc-write-roundtrip", "selftune.contribute.json"), "utf-8"),
    ) as { creator_id: string; contribution: { signals: string[] } };
    expect(onDisk.creator_id).toBe(uuid);
    expect(onDisk.contribution.signals).toEqual(["trigger", "grade"]);
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
