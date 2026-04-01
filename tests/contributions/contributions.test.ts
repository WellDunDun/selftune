import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "selftune-contributions-test-"));
const skillDir = mkdtempSync(join(tmpdir(), "selftune-contribution-skills-"));
process.env.SELFTUNE_CONFIG_DIR = configDir;
process.env.SELFTUNE_SKILL_DIRS = skillDir;

const contributionsMod = await import("../../cli/selftune/contributions.js");
const configDiscoveryMod = await import("../../cli/selftune/contribution-config.js");

const { cliMain, loadContributionPreferences, resetContributionPreferencesState } =
  contributionsMod;
const { discoverCreatorContributionConfigs } = configDiscoveryMod;

const originalArgv = [...process.argv];
const originalLog = console.log;

function seedContributionSkill(
  skillName: string,
  creatorId = "cr_test123",
  signals: string[] = ["trigger", "grade"],
): void {
  const root = join(skillDir, skillName);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), `# ${skillName}\n`, "utf-8");
  writeFileSync(
    join(root, "selftune.contribute.json"),
    JSON.stringify(
      {
        version: 1,
        creator_id: creatorId,
        skill_name: skillName,
        contribution: {
          enabled: true,
          signals,
          message: `Help improve ${skillName}`,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

beforeEach(() => {
  resetContributionPreferencesState();
  process.argv = [...originalArgv];
  const prefsPath = join(configDir, "contribution-preferences.json");
  try {
    rmSync(prefsPath, { force: true });
  } catch {
    // ignore
  }
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
});

afterAll(() => {
  console.log = originalLog;
  process.argv = originalArgv;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(skillDir, { recursive: true, force: true });
});

describe("contributions preferences", () => {
  test("loads defaults when no file exists", () => {
    const prefs = loadContributionPreferences();
    expect(prefs.global_default).toBe("ask");
    expect(prefs.skills).toEqual({});
  });

  test("approve persists opted-in state", async () => {
    process.argv = ["bun", "selftune", "approve", "sc-search"];
    console.log = mock(() => {});
    await cliMain();

    const prefs = loadContributionPreferences();
    expect(prefs.skills["sc-search"]?.status).toBe("opted_in");
    expect(typeof prefs.skills["sc-search"]?.opted_in_at).toBe("string");
  });

  test("revoke persists opted-out state", async () => {
    process.argv = ["bun", "selftune", "revoke", "sc-search"];
    console.log = mock(() => {});
    await cliMain();

    const prefs = loadContributionPreferences();
    expect(prefs.skills["sc-search"]?.status).toBe("opted_out");
    expect(typeof prefs.skills["sc-search"]?.opted_out_at).toBe("string");
  });

  test("default updates global behavior", async () => {
    process.argv = ["bun", "selftune", "default", "never"];
    console.log = mock(() => {});
    await cliMain();

    const prefs = JSON.parse(
      readFileSync(join(configDir, "contribution-preferences.json"), "utf-8"),
    ) as { global_default: string };
    expect(prefs.global_default).toBe("never");
  });

  test("discovers installed creator contribution configs", () => {
    seedContributionSkill("sc-search", "cr_search");
    seedContributionSkill("sc-compare", "cr_compare", ["trigger"]);

    const configs = discoverCreatorContributionConfigs();
    expect(configs.map((config) => config.skill_name)).toEqual(["sc-compare", "sc-search"]);
    expect(configs[0]?.creator_id).toBe("cr_compare");
    expect(configs[1]?.contribution.signals).toEqual(["trigger", "grade"]);
  });

  test("status prints separation from contribute and alpha upload", async () => {
    seedContributionSkill("sc-search", "cr_search");
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune"];
    await cliMain();

    expect(lines.join("\n")).toContain("Installed skill requests:");
    expect(lines.join("\n")).toContain("sc-search: default (ask)");
    expect(lines.join("\n")).toContain("creator: cr_search");
    expect(lines.join("\n")).toContain("selftune contribute");
    expect(lines.join("\n")).toContain("selftune push / alpha");
  });
});
