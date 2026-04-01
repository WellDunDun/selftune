import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CreatorContributionConfig } from "../../cli/selftune/contribution-config.js";
import {
  buildContributionPreview,
  buildCreatorDirectedContributionSignals,
  buildContributionUserCohort,
  classifyContributionQueryBucket,
} from "../../cli/selftune/contribution-signals.js";
import { openDb } from "../../cli/selftune/localdb/db.js";

let db = openDb(":memory:");

const config: CreatorContributionConfig = {
  version: 1,
  creator_id: "cr_search",
  skill_name: "sc-search",
  config_path: "/tmp/sc-search/selftune.contribute.json",
  skill_path: "/tmp/sc-search/SKILL.md",
  contribution: {
    enabled: true,
    signals: ["trigger", "grade", "miss_category"],
  },
};

function seedSession(
  sessionId: string,
  promptId: string,
  promptText: string,
  occurredAt: string,
  triggered: 0 | 1,
  invocationMode: string | null,
): void {
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
     ) VALUES (?, ?, 'sc-search', ?, ?, ?, ?, 'canonical')`,
    [`${sessionId}:s:0`, sessionId, occurredAt, invocationMode, triggered, promptId],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("contribution-signals", () => {
  test("classifies query buckets with simple local heuristics", () => {
    expect(classifyContributionQueryBucket("Compare React vs Vue for dashboards")).toBe(
      "comparison",
    );
    expect(classifyContributionQueryBucket("This is broken, help debug it")).toBe(
      "troubleshooting",
    );
    expect(classifyContributionQueryBucket("")).toBe("other");
  });

  test("builds relay-ready payloads from trusted observations", () => {
    seedSession(
      "s1",
      "p1",
      "Compare React vs Vue for dashboards",
      "2026-04-01T00:00:00.000Z",
      1,
      "implicit",
    );
    seedSession("s2", "p2", "Debug why search is not working", "2026-04-02T00:00:00.000Z", 0, null);
    db.run(
      `INSERT INTO grading_results (
         grading_id, session_id, skill_name, graded_at, pass_rate, mean_score
       ) VALUES ('g1', 's1', 'sc-search', '2026-04-03T00:00:00.000Z', 1.0, 0.92)`,
    );

    const payloads = buildCreatorDirectedContributionSignals(db, [config], {
      now: new Date("2026-04-10T00:00:00.000Z"),
      cohortSeed: "device-123",
      clientVersion: "0.4.0",
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.creator_id).toBe("cr_search");
    expect(payloads[0]?.source_key).toHaveLength(16);
    expect(payloads[0]?.payload.relay_destination).toBe("cr_search");
    expect(payloads[0]?.payload.skill_hash).toMatch(/^sk_sha256_/);
    expect(payloads[0]?.payload.user_cohort).toBe(
      buildContributionUserCohort(new Date("2026-04-10T00:00:00.000Z"), "device-123"),
    );
    expect(payloads[0]?.payload.signals.invocation_type).toBe("implicit");
    expect(payloads[0]?.payload.signals.execution_grade).toBe("A");
    expect(payloads[0]?.payload.signals.query_bucket).toBe("comparison");
    expect(payloads[1]?.payload.signals.invocation_type).toBe("missed");
    expect(payloads[1]?.payload.signals.miss_detected).toBe(true);
    expect(payloads[1]?.payload.signals.query_bucket).toBe("troubleshooting");
    expect(payloads[1]?.payload.timestamp_bucket).toBe("2026-W14");
  });

  test("builds a preview summary and sample payload", () => {
    seedSession(
      "s1",
      "p1",
      "Compare React vs Vue for dashboards",
      "2026-04-01T00:00:00.000Z",
      1,
      "implicit",
    );
    const preview = buildContributionPreview(db, config, {
      now: new Date("2026-04-10T00:00:00.000Z"),
      cohortSeed: "device-123",
    });

    expect(preview.observedCount).toBe(1);
    expect(preview.triggerRate).toBe(100);
    expect(preview.missRate).toBe(0);
    expect(preview.samplePayload.relay_destination).toBe("cr_search");
    expect(preview.samplePayload.signals.query_bucket).toBe("comparison");
  });
});
