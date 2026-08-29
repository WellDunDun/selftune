import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CreatorContributionConfig } from "../../packages/runtime/contribution-config.js";
import {
  buildContributionPreview,
  buildCreatorDirectedContributionSignals,
  buildContributionUserCohort,
  classifyContributionQueryBucket,
} from "../../packages/runtime/contribution-signals.js";
import { openDb } from "../../packages/runtime/localdb/db.js";

let db: ReturnType<typeof openDb>;

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
  skillName = "sc-search",
): void {
  db.run(
    `INSERT OR IGNORE INTO sessions (session_id, started_at, platform, capture_mode)
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
    [
      `${sessionId}:${skillName}:${promptId}`,
      sessionId,
      skillName,
      occurredAt,
      invocationMode,
      triggered,
      promptId,
    ],
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
    const implicitPayload = payloads.find(
      (record) => record.payload.signals.invocation_type === "implicit",
    );
    const missedPayload = payloads.find(
      (record) => record.payload.signals.invocation_type === "missed",
    );

    expect(implicitPayload?.creator_id).toBe("cr_search");
    expect(implicitPayload?.source_key).toHaveLength(16);
    expect(implicitPayload?.payload.skill_name).toBe("sc-search");
    expect(implicitPayload?.payload.relay_destination).toBe("cr_search");
    expect(implicitPayload?.payload.skill_hash).toMatch(/^sk_sha256_/);
    expect(implicitPayload?.payload.user_cohort).toBe(
      buildContributionUserCohort(new Date("2026-04-10T00:00:00.000Z"), "device-123", "cr_search"),
    );
    expect(implicitPayload?.payload.signals.invocation_type).toBe("implicit");
    expect(implicitPayload?.payload.signals.execution_grade).toBe("A");
    expect(implicitPayload?.payload.signals.query_bucket).toBe("comparison");
    expect(missedPayload?.payload.signals.invocation_type).toBe("missed");
    expect(missedPayload?.payload.signals.miss_detected).toBe(true);
    expect(missedPayload?.payload.signals.query_bucket).toBe("troubleshooting");
    expect(missedPayload?.payload.timestamp_bucket).toBe("2026-W14");
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
    expect(preview.samplePayload.skill_name).toBe("sc-search");
    expect(preview.samplePayload.relay_destination).toBe("cr_search");
    expect(preview.samplePayload.signals.query_bucket).toBe("comparison");
  });

  test("returns an empty preview when no trusted observations are available", () => {
    const preview = buildContributionPreview(db, config, {
      now: new Date("2026-04-10T00:00:00.000Z"),
      cohortSeed: "device-123",
    });

    expect(preview.observedCount).toBe(0);
    expect(preview.triggerRate).toBeNull();
    expect(preview.missRate).toBeNull();
    expect(preview.gradedSessions).toBe(0);
    expect(preview.samplePayload.skill_name).toBe("sc-search");
    expect(preview.samplePayload.relay_destination).toBe("cr_search");
    expect(preview.samplePayload.signals.query_bucket).toBe("other");
  });

  test("keeps grades scoped to the matching skill within a multi-skill session", () => {
    seedSession(
      "shared-session",
      "p1",
      "Compare React vs Vue for dashboards",
      "2026-04-01T00:00:00.000Z",
      1,
      "implicit",
      "sc-search",
    );
    seedSession(
      "shared-session",
      "p2",
      "Fix the routing bug in this workflow",
      "2026-04-01T00:05:00.000Z",
      1,
      "explicit",
      "sc-debug",
    );
    db.run(
      `INSERT INTO grading_results (
         grading_id, session_id, skill_name, graded_at, pass_rate, mean_score
       ) VALUES
         ('g-search', 'shared-session', 'sc-search', '2026-04-03T00:00:00.000Z', 1.0, 0.95),
         ('g-debug', 'shared-session', 'sc-debug', '2026-04-03T00:01:00.000Z', 0.2, 0.25)`,
    );

    const payloads = buildCreatorDirectedContributionSignals(db, [config], {
      now: new Date("2026-04-10T00:00:00.000Z"),
      cohortSeed: "device-123",
      clientVersion: "0.4.0",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload.skill_name).toBe("sc-search");
    expect(payloads[0]?.payload.signals.execution_grade).toBe("A");
  });
});
