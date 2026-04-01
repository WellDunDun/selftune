import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CreatorContributionConfig } from "../../cli/selftune/contribution-config.js";
import {
  resolveEligibleContributionConfigs,
  stageCreatorContributionSignals,
} from "../../cli/selftune/contribution-staging.js";
import type { ContributionPreferences } from "../../cli/selftune/contributions.js";
import { openDb } from "../../cli/selftune/localdb/db.js";

let db = openDb(":memory:");

const configA: CreatorContributionConfig = {
  version: 1,
  creator_id: "cr_search",
  skill_name: "sc-search",
  config_path: "/tmp/sc-search/selftune.contribute.json",
  skill_path: "/tmp/sc-search/SKILL.md",
  contribution: { enabled: true, signals: ["trigger", "grade", "miss_category"] },
};

const configB: CreatorContributionConfig = {
  version: 1,
  creator_id: "cr_compare",
  skill_name: "sc-compare",
  config_path: "/tmp/sc-compare/selftune.contribute.json",
  skill_path: "/tmp/sc-compare/SKILL.md",
  contribution: { enabled: true, signals: ["trigger"] },
};

function seedTrustedTrigger(
  skillName: string,
  sessionId: string,
  promptText: string,
  occurredAt: string,
): void {
  const promptId = `${sessionId}-p0`;
  db.run(
    `INSERT INTO sessions (session_id, started_at, platform, capture_mode)
     VALUES (?, ?, 'claude_code', 'canonical')`,
    [sessionId, occurredAt],
  );
  db.run(
    `INSERT INTO prompts (prompt_id, session_id, prompt_text, prompt_kind, occurred_at)
     VALUES (?, ?, ?, 'user', ?)`,
    [promptId, sessionId, promptText, occurredAt],
  );
  db.run(
    `INSERT INTO skill_invocations (
       skill_invocation_id, session_id, skill_name, occurred_at, invocation_mode,
       triggered, matched_prompt_id, capture_mode
     ) VALUES (?, ?, ?, ?, 'implicit', 1, ?, 'canonical')`,
    [`${sessionId}:s:0`, sessionId, skillName, occurredAt, promptId],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("contribution-staging", () => {
  test("resolves eligible configs from preferences", () => {
    const prefs: ContributionPreferences = {
      version: 1,
      global_default: "ask",
      skills: {
        "sc-search": { status: "opted_in" },
        "sc-compare": { status: "opted_out" },
      },
    };

    const eligible = resolveEligibleContributionConfigs(prefs, [configA, configB]);
    expect(eligible.map((config) => config.skill_name)).toEqual(["sc-search"]);
  });

  test("stages creator-directed signals idempotently", () => {
    seedTrustedTrigger(
      "sc-search",
      "s1",
      "Compare React vs Vue for dashboards",
      "2026-04-01T00:00:00.000Z",
    );

    const prefs: ContributionPreferences = {
      version: 1,
      global_default: "ask",
      skills: {
        "sc-search": { status: "opted_in" },
      },
    };

    const first = stageCreatorContributionSignals(db, {
      preferences: prefs,
      configs: [configA],
    });
    const second = stageCreatorContributionSignals(db, {
      preferences: prefs,
      configs: [configA],
    });

    expect(first).toEqual({
      eligible_skills: 1,
      built_signals: 1,
      staged_signals: 1,
    });
    expect(second).toEqual({
      eligible_skills: 1,
      built_signals: 1,
      staged_signals: 0,
    });

    const rows = db
      .query(
        `SELECT skill_name, creator_id, status, payload_json
         FROM creator_contribution_staging`,
      )
      .all() as Array<{
      skill_name: string;
      creator_id: string;
      status: string;
      payload_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill_name).toBe("sc-search");
    expect(rows[0]?.creator_id).toBe("cr_search");
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.payload_json).toContain('"signal_type":"skill_session"');
  });

  test("supports dry-run without writing staged rows", () => {
    seedTrustedTrigger(
      "sc-search",
      "s1",
      "Compare React vs Vue for dashboards",
      "2026-04-01T00:00:00.000Z",
    );
    const prefs: ContributionPreferences = {
      version: 1,
      global_default: "always",
      skills: {},
    };

    const result = stageCreatorContributionSignals(db, {
      dryRun: true,
      preferences: prefs,
      configs: [configA],
    });

    expect(result).toEqual({
      eligible_skills: 1,
      built_signals: 1,
      staged_signals: 0,
    });
    const count = db.query(`SELECT COUNT(*) AS count FROM creator_contribution_staging`).get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});
