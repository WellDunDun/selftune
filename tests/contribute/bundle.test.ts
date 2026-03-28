import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assembleBundle } from "../../cli/selftune/contribute/bundle.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import {
  type SkillInvocationWriteInput,
  writeEvolutionAuditToDb,
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "../../cli/selftune/localdb/direct-write.js";

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
});

// Seed helpers
let skillInvCounter = 0;

function mustWrite(ok: boolean, label: string): void {
  if (!ok) throw new Error(`Failed to seed ${label}`);
}

function seedSkill(record: {
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  query: string;
  triggered: boolean;
  source?: string;
}): void {
  mustWrite(
    writeSkillCheckToDb({
      skill_invocation_id: `si_bundle_${Date.now()}_${skillInvCounter++}`,
      session_id: record.session_id,
      occurred_at: record.timestamp,
      skill_name: record.skill_name,
      invocation_mode: "implicit",
      triggered: record.triggered,
      confidence: record.triggered ? 1.0 : 0.0,
      query: record.query,
      skill_path: record.skill_path,
      source: record.source,
    } as SkillInvocationWriteInput),
    "skill",
  );
}

function seedQuery(record: { timestamp: string; session_id: string; query: string }): void {
  mustWrite(writeQueryToDb(record), "query");
}

function seedTelemetry(record: {
  timestamp: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
  source?: string;
}): void {
  mustWrite(
    writeSessionTelemetryToDb({
      ...record,
      tool_calls_json: JSON.stringify(record.tool_calls),
      bash_commands_json: JSON.stringify(record.bash_commands),
      skills_triggered_json: JSON.stringify(record.skills_triggered),
    }),
    "telemetry",
  );
}

function seedEvolution(record: {
  timestamp: string;
  proposal_id: string;
  action: string;
  details: string;
  eval_snapshot?: { total: number; passed: number; failed: number; pass_rate: number };
}): void {
  mustWrite(writeEvolutionAuditToDb(record), "evolution");
}

const skillRecords = [
  {
    timestamp: "2025-06-01T00:00:00Z",
    session_id: "s1",
    skill_name: "selftune",
    skill_path: "/skills/selftune",
    query: "run selftune eval",
    triggered: true,
    source: "claude_code_replay",
  },
  {
    timestamp: "2025-06-01T01:00:00Z",
    session_id: "s2",
    skill_name: "selftune",
    skill_path: "/skills/selftune",
    query: "check selftune status",
    triggered: true,
    source: "claude_code_replay",
  },
  {
    timestamp: "2025-06-01T02:00:00Z",
    session_id: "s3",
    skill_name: "other-skill",
    skill_path: "/skills/other",
    query: "do something else",
    triggered: true,
    source: "claude_code_replay",
  },
];

const queryRecords = [
  { timestamp: "2025-06-01T00:00:00Z", session_id: "s1", query: "run selftune eval" },
  { timestamp: "2025-06-01T01:00:00Z", session_id: "s2", query: "check selftune status" },
  { timestamp: "2025-06-01T02:00:00Z", session_id: "s3", query: "do something else" },
  { timestamp: "2025-06-01T03:00:00Z", session_id: "s4", query: "unrelated query" },
];

const telemetryRecords = [
  {
    timestamp: "2025-06-01T00:30:00Z",
    session_id: "s1",
    cwd: "/tmp/project",
    transcript_path: "/tmp/transcript1.json",
    tool_calls: { Read: 3, Write: 2, Bash: 5 },
    total_tool_calls: 10,
    bash_commands: ["ls", "cd"],
    skills_triggered: ["selftune"],
    assistant_turns: 8,
    errors_encountered: 1,
    transcript_chars: 5000,
    last_user_query: "run selftune eval",
    source: "hook",
  },
  {
    timestamp: "2025-06-01T01:30:00Z",
    session_id: "s2",
    cwd: "/tmp/project",
    transcript_path: "/tmp/transcript2.json",
    tool_calls: { Read: 5, Grep: 3 },
    total_tool_calls: 8,
    bash_commands: ["bun test"],
    skills_triggered: ["selftune"],
    assistant_turns: 12,
    errors_encountered: 0,
    transcript_chars: 8000,
    last_user_query: "check selftune status",
    source: "hook",
  },
];

const evolutionRecords = [
  {
    timestamp: "2025-06-01T04:00:00Z",
    proposal_id: "p1",
    action: "created",
    details: "New proposal for selftune",
  },
  {
    timestamp: "2025-06-01T05:00:00Z",
    proposal_id: "p1",
    action: "deployed",
    details: "Deployed proposal p1",
    eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
  },
  {
    timestamp: "2025-06-01T06:00:00Z",
    proposal_id: "p2",
    action: "created",
    details: "Another proposal",
  },
  {
    timestamp: "2025-06-01T07:00:00Z",
    proposal_id: "p2",
    action: "rolled_back",
    details: "Rolled back p2",
  },
];

function seedBase(): void {
  for (const r of skillRecords) seedSkill(r);
  for (const r of queryRecords) seedQuery(r);
  for (const r of telemetryRecords) seedTelemetry(r);
}

function seedAll(): void {
  seedBase();
  for (const r of evolutionRecords) seedEvolution(r);
}

function seedWithoutEvolution(): void {
  seedBase();
}

describe("assembleBundle", () => {
  test("returns valid bundle structure", () => {
    seedAll();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    // Has unmatched queries so schema bumps to 1.2
    expect(bundle.schema_version).toBe("1.2");
    expect(bundle.sanitization_level).toBe("conservative");
    expect(bundle.created_at).toBeTruthy();
    expect(bundle.selftune_version).toBeTruthy();
    expect(bundle.agent_type).toBeTruthy();
  });

  test("contributor_id is UUID format", () => {
    seedAll();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(bundle.contributor_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("extracts positive queries for matching skill", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.positive_queries.length).toBe(2);
    expect(bundle.positive_queries.map((q) => q.query)).toContain("run selftune eval");
    expect(bundle.positive_queries.map((q) => q.query)).toContain("check selftune status");
  });

  test("filters by --since date", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      since: new Date("2025-06-01T00:30:00Z"),
      sanitizationLevel: "conservative",
    });

    // Only the second skill record is after the since date
    expect(bundle.positive_queries.length).toBe(1);
    expect(bundle.positive_queries[0].query).toBe("check selftune status");
  });

  test("computes session metrics", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.session_metrics.total_sessions).toBe(2);
    expect(bundle.session_metrics.avg_assistant_turns).toBe(10); // (8 + 12) / 2
    expect(bundle.session_metrics.avg_tool_calls).toBe(9); // (10 + 8) / 2
    expect(bundle.session_metrics.avg_errors).toBe(0.5); // (1 + 0) / 2
    expect(bundle.session_metrics.top_tools.length).toBeGreaterThan(0);
  });

  test("builds evolution summary from audit log", () => {
    seedAll();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.evolution_summary).not.toBeNull();
    expect(bundle.evolution_summary?.total_proposals).toBe(2);
    expect(bundle.evolution_summary?.deployed_proposals).toBe(1);
    expect(bundle.evolution_summary?.rolled_back_proposals).toBe(1);
  });

  test("populates unmatched_queries for queries with no triggered skill", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    // "unrelated query" is in queryRecords but not triggered by any skill
    expect(bundle.unmatched_queries).toBeDefined();
    expect(bundle.unmatched_queries?.length).toBeGreaterThan(0);
    expect(bundle.unmatched_queries?.map((q) => q.query)).toContain("unrelated query");
    // Triggered queries should NOT be in unmatched
    expect(bundle.unmatched_queries?.map((q) => q.query)).not.toContain("run selftune eval");
  });

  test("populates pending_proposals for proposals without terminal actions", () => {
    const pendingEvolutionRecords = [
      {
        timestamp: "2025-06-01T04:00:00Z",
        proposal_id: "p1",
        action: "created",
        details: "New proposal",
      },
      {
        timestamp: "2025-06-01T05:00:00Z",
        proposal_id: "p1",
        action: "validated",
        details: "Validated proposal p1",
      },
      // p1 has no terminal action — should be pending
      {
        timestamp: "2025-06-01T06:00:00Z",
        proposal_id: "p2",
        action: "created",
        details: "Another proposal",
      },
      {
        timestamp: "2025-06-01T07:00:00Z",
        proposal_id: "p2",
        action: "deployed",
        details: "Deployed p2",
        eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
      },
      // p2 is deployed (terminal) — should NOT be pending
    ];

    seedBase();
    for (const r of pendingEvolutionRecords) seedEvolution(r);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.pending_proposals).toBeDefined();
    expect(bundle.pending_proposals?.length).toBe(1);
    expect(bundle.pending_proposals?.[0].proposal_id).toBe("p1");
    expect(bundle.pending_proposals?.[0].action).toBe("validated");
  });

  test("schema_version is 1.2 when new fields are populated", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    // Has unmatched queries ("unrelated query"), so should be 1.2
    expect(bundle.schema_version).toBe("1.2");
  });

  test("handles empty SQLite database gracefully", () => {
    // No data seeded — empty SQLite database
    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.positive_queries).toEqual([]);
    expect(bundle.eval_entries).toEqual([]);
    expect(bundle.session_metrics.total_sessions).toBe(0);
    expect(bundle.evolution_summary).toBeNull();
  });

  test("generates eval entries via buildEvalSet", () => {
    seedWithoutEvolution();

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    expect(bundle.eval_entries.length).toBeGreaterThan(0);
    // Should have both positives and negatives
    const positives = bundle.eval_entries.filter((e) => e.should_trigger);
    const negatives = bundle.eval_entries.filter((e) => !e.should_trigger);
    expect(positives.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThan(0);
  });
});
