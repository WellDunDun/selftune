import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRIBUTION_PREFERENCES_PATH } from "../../cli/selftune/constants.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";

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
let db = openDb(":memory:");

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

function seedTrustedTrigger(skillName: string, promptText = "Help me compare these tools"): void {
  const promptId = `${skillName}-p0`;
  db.run(
    `INSERT INTO sessions (session_id, started_at, platform, capture_mode)
     VALUES (?, ?, 'claude_code', 'canonical')`,
    [`${skillName}-s1`, "2026-04-01T00:00:00.000Z"],
  );
  db.run(
    `INSERT INTO prompts (prompt_id, session_id, prompt_text, prompt_kind, occurred_at)
     VALUES (?, ?, ?, 'user', ?)`,
    [promptId, `${skillName}-s1`, promptText, "2026-04-01T00:00:00.000Z"],
  );
  db.run(
    `INSERT INTO skill_invocations (
       skill_invocation_id, session_id, skill_name, occurred_at, triggered,
       matched_prompt_id, capture_mode
     ) VALUES (?, ?, ?, ?, 1, ?, 'canonical')`,
    [`${skillName}:s:0`, `${skillName}-s1`, skillName, "2026-04-01T00:00:01.000Z", promptId],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
  _setTestDb(db);
  resetContributionPreferencesState();
  process.argv = [...originalArgv];
  try {
    rmSync(CONTRIBUTION_PREFERENCES_PATH, { force: true });
  } catch {
    // ignore
  }
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
});

afterEach(() => {
  _setTestDb(null);
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
    seedContributionSkill("sc-search", "cr_search", ["trigger", "grade", "miss_category"]);
    process.argv = ["bun", "selftune", "approve", "sc-search"];
    console.log = mock(() => {});
    await cliMain();

    const prefs = loadContributionPreferences();
    expect(prefs.skills["sc-search"]?.status).toBe("opted_in");
    expect(typeof prefs.skills["sc-search"]?.opted_in_at).toBe("string");
    expect(prefs.skills["sc-search"]?.creator_id).toBe("cr_search");
    expect(prefs.skills["sc-search"]?.signals).toEqual(["trigger", "grade", "miss_category"]);
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

    const prefs = loadContributionPreferences();
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
    seedTrustedTrigger("sc-search");
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
    expect(lines.join("\n")).toContain("Ready for first-time prompt:");
  });

  test("preview prints relay payload shape and privacy guarantees", async () => {
    seedContributionSkill("sc-search", "cr_search", ["trigger", "grade", "miss_category"]);
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune", "preview", "sc-search"];

    await cliMain();

    const output = lines.join("\n");
    expect(output).toContain('Contribution preview for "sc-search"');
    expect(output).toContain("requested signals: trigger, grade, miss_category");
    expect(output).toContain("never shared: raw prompts, code/files, your identity");
    expect(output).toContain('"signal_type": "skill_session"');
    expect(output).toContain('"relay_destination": "cr_search"');
  });
});
