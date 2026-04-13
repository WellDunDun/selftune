import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "selftune-contributions-test-"));
const skillDir = mkdtempSync(join(tmpdir(), "selftune-contribution-skills-"));
const originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
const originalSkillDirs = process.env.SELFTUNE_SKILL_DIRS;
process.env.SELFTUNE_CONFIG_DIR = configDir;
process.env.SELFTUNE_SKILL_DIRS = skillDir;
const contributionPreferencesPath = join(configDir, "contribution-preferences.json");

const dbMod = await import("../../cli/selftune/localdb/db.js");
const contributionsMod = await import("../../cli/selftune/contributions.js");
const configDiscoveryMod = await import("../../cli/selftune/contribution-config.js");

const { _setTestDb, openDb } = dbMod;
const { cliMain, loadContributionPreferences, resetContributionPreferencesState } =
  contributionsMod;
const { discoverCreatorContributionConfigs } = configDiscoveryMod;

const originalArgv = [...process.argv];
const originalLog = console.log;
const originalFetch = globalThis.fetch;
let db = openDb(":memory:");
const SEARCH_CREATOR_ID = "550e8400-e29b-41d4-a716-446655440000";
const COMPARE_CREATOR_ID = "550e8400-e29b-41d4-a716-446655440001";

function seedContributionSkill(
  skillName: string,
  creatorId = SEARCH_CREATOR_ID,
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
  process.env.SELFTUNE_CONFIG_DIR = configDir;
  process.env.SELFTUNE_SKILL_DIRS = skillDir;
  db = openDb(":memory:");
  _setTestDb(db);
  resetContributionPreferencesState();
  process.argv = [...originalArgv];
  globalThis.fetch = originalFetch;
  try {
    rmSync(contributionPreferencesPath, { force: true });
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
  globalThis.fetch = originalFetch;
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

describe("contributions preferences", () => {
  test("loads defaults when no file exists", () => {
    const prefs = loadContributionPreferences();
    expect(prefs.global_default).toBe("ask");
    expect(prefs.skills).toEqual({});
  });

  test("approve persists opted-in state", async () => {
    seedContributionSkill("sc-search", SEARCH_CREATOR_ID, ["trigger", "grade", "miss_category"]);
    process.argv = ["bun", "selftune", "approve", "sc-search"];
    console.log = mock(() => {});
    await cliMain();

    const prefs = loadContributionPreferences();
    expect(prefs.skills["sc-search"]?.status).toBe("opted_in");
    expect(typeof prefs.skills["sc-search"]?.opted_in_at).toBe("string");
    expect(prefs.skills["sc-search"]?.creator_id).toBe(SEARCH_CREATOR_ID);
    expect(prefs.skills["sc-search"]?.signals).toEqual(["trigger", "grade", "miss_category"]);
  });

  test("approve rejects unknown skills instead of writing dead overrides", async () => {
    process.argv = ["bun", "selftune", "approve", "sc-missing"];
    console.log = mock(() => {});

    await expect(cliMain()).rejects.toThrow(
      'No creator contribution request found for "sc-missing".',
    );

    const prefs = loadContributionPreferences();
    expect(prefs.skills["sc-missing"]).toBeUndefined();
  });

  test("revoke persists opted-out state", async () => {
    seedContributionSkill("sc-search", SEARCH_CREATOR_ID);
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
    seedContributionSkill("sc-search", SEARCH_CREATOR_ID);
    seedContributionSkill("sc-compare", COMPARE_CREATOR_ID, ["trigger"]);

    const configs = discoverCreatorContributionConfigs();
    expect(configs.map((config) => config.skill_name)).toEqual(["sc-compare", "sc-search"]);
    expect(configs[0]?.creator_id).toBe(COMPARE_CREATOR_ID);
    expect(configs[1]?.contribution.signals).toEqual(["trigger", "grade"]);
  });

  test("status prints separation from contribute and alpha upload", async () => {
    seedContributionSkill("sc-search", SEARCH_CREATOR_ID);
    seedTrustedTrigger("sc-search");
    resetContributionPreferencesState();
    rmSync(contributionPreferencesPath, { force: true });
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune"];
    await cliMain();

    expect(lines.join("\n")).toContain("Installed skill requests:");
    expect(lines.join("\n")).toContain("sc-search: default (ask)");
    expect(lines.join("\n")).toContain(`creator: ${SEARCH_CREATOR_ID}`);
    expect(lines.join("\n")).toContain("Relay queue:");
    expect(lines.join("\n")).toContain("selftune contribute");
    expect(lines.join("\n")).toContain("selftune push / alpha");
    expect(lines.join("\n")).toContain("Ready for first-time prompt:");
  });

  test("preview prints relay payload shape and privacy guarantees", async () => {
    seedContributionSkill("sc-search", SEARCH_CREATOR_ID, ["trigger", "grade", "miss_category"]);
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
    expect(output).toContain(`"relay_destination": "${SEARCH_CREATOR_ID}"`);
  });

  test("approve rejects creator requests with invalid creator ids", async () => {
    seedContributionSkill("sc-search", "cr_search", ["trigger"]);
    process.argv = ["bun", "selftune", "approve", "sc-search"];
    console.log = mock(() => {});

    await expect(cliMain()).rejects.toThrow(
      'Creator contribution request for "sc-search" has an invalid creator_id.',
    );
  });

  test("upload dry-run reports pending staged rows", async () => {
    db.run(
      `INSERT INTO creator_contribution_staging
         (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at)
       VALUES ('sc-search-dedupe', 'sc-search', 'cr_search', ?, 'pending', ?, ?)`,
      [
        JSON.stringify({
          version: 1,
          signal_type: "skill_session",
          relay_destination: "cr_search",
          skill_hash: "sk_sha256_abc123",
          user_cohort: "uc_sha256_123456",
          signals: { triggered: true },
          timestamp_bucket: "2026-W14",
          client_version: "0.4.0",
        }),
        "2026-04-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ],
    );

    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune", "upload", "--dry-run"];

    await cliMain();

    expect(lines.join("\n")).toContain("Creator-directed relay upload dry run");
    expect(lines.join("\n")).toContain("pending rows considered: 1");
  });

  test("upload flushes staged rows with explicit api key", async () => {
    db.run(
      `INSERT INTO creator_contribution_staging
         (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at)
       VALUES ('sc-search-dedupe', 'sc-search', 'cr_search', ?, 'pending', ?, ?)`,
      [
        JSON.stringify({
          version: 1,
          signal_type: "skill_session",
          relay_destination: "cr_search",
          skill_hash: "sk_sha256_abc123",
          user_cohort: "uc_sha256_123456",
          signals: { triggered: true },
          timestamp_bucket: "2026-W14",
          client_version: "0.4.0",
        }),
        "2026-04-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ],
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    ) as unknown as typeof fetch;
    console.log = mock(() => {});
    process.argv = ["bun", "selftune", "upload", "--api-key", "st_test_123"];

    await cliMain();

    const row = db
      .query(`SELECT status FROM creator_contribution_staging WHERE skill_name = 'sc-search'`)
      .get() as { status: string } | null;
    expect(row?.status).toBe("sent");
  });

  test("upload can retry failed rows", async () => {
    db.run(
      `INSERT INTO creator_contribution_staging
         (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at, last_error)
       VALUES ('sc-search-dedupe', 'sc-search', 'cr_search', ?, 'failed', ?, ?, 'HTTP 503')`,
      [
        JSON.stringify({
          version: 1,
          signal_type: "skill_session",
          relay_destination: "cr_search",
          skill_hash: "sk_sha256_abc123",
          user_cohort: "uc_sha256_123456",
          signals: { triggered: true },
          timestamp_bucket: "2026-W14",
          client_version: "0.4.0",
        }),
        "2026-04-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ],
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    ) as unknown as typeof fetch;
    const lines: string[] = [];
    console.log = mock((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    process.argv = ["bun", "selftune", "upload", "--retry-failed", "--api-key", "st_test_123"];

    await cliMain();

    expect(lines.join("\n")).toContain("failed rows requeued: 1");
    const row = db
      .query(`SELECT status FROM creator_contribution_staging WHERE skill_name = 'sc-search'`)
      .get() as { status: string } | null;
    expect(row?.status).toBe("sent");
  });
});
