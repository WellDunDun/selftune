import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle } from "../../cli/selftune/contribute/bundle.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-bundle-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const skillRecords = [
  {
    timestamp: "2025-06-01T00:00:00Z",
    session_id: "s1",
    skill_name: "selftune",
    skill_path: "/skills/selftune",
    query: "run selftune eval",
    triggered: true,
    source: "hook",
  },
  {
    timestamp: "2025-06-01T01:00:00Z",
    session_id: "s2",
    skill_name: "selftune",
    skill_path: "/skills/selftune",
    query: "check selftune status",
    triggered: true,
    source: "hook",
  },
  {
    timestamp: "2025-06-01T02:00:00Z",
    session_id: "s3",
    skill_name: "other-skill",
    skill_path: "/skills/other",
    query: "do something else",
    triggered: true,
    source: "hook",
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

describe("assembleBundle", () => {
  test("returns valid bundle structure", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");
    const evolutionLogPath = join(tmpDir, "evolution.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);
    writeJsonl(evolutionLogPath, evolutionRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
      evolutionAuditLogPath: evolutionLogPath,
    });

    expect(bundle.schema_version).toBe("1.1");
    expect(bundle.sanitization_level).toBe("conservative");
    expect(bundle.created_at).toBeTruthy();
    expect(bundle.selftune_version).toBeTruthy();
    expect(bundle.agent_type).toBeTruthy();
  });

  test("contributor_id is UUID format", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");
    const evolutionLogPath = join(tmpDir, "evolution.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);
    writeJsonl(evolutionLogPath, evolutionRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
      evolutionAuditLogPath: evolutionLogPath,
    });

    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(bundle.contributor_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("extracts positive queries for matching skill", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    expect(bundle.positive_queries.length).toBe(2);
    expect(bundle.positive_queries.map((q) => q.query)).toContain("run selftune eval");
    expect(bundle.positive_queries.map((q) => q.query)).toContain("check selftune status");
  });

  test("filters by --since date", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      since: new Date("2025-06-01T00:30:00Z"),
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    // Only the second skill record is after the since date
    expect(bundle.positive_queries.length).toBe(1);
    expect(bundle.positive_queries[0].query).toBe("check selftune status");
  });

  test("computes session metrics", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    expect(bundle.session_metrics.total_sessions).toBe(2);
    expect(bundle.session_metrics.avg_assistant_turns).toBe(10); // (8 + 12) / 2
    expect(bundle.session_metrics.avg_tool_calls).toBe(9); // (10 + 8) / 2
    expect(bundle.session_metrics.avg_errors).toBe(0.5); // (1 + 0) / 2
    expect(bundle.session_metrics.top_tools.length).toBeGreaterThan(0);
  });

  test("builds evolution summary from audit log", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");
    const evolutionLogPath = join(tmpDir, "evolution.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);
    writeJsonl(evolutionLogPath, evolutionRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
      evolutionAuditLogPath: evolutionLogPath,
    });

    expect(bundle.evolution_summary).not.toBeNull();
    expect(bundle.evolution_summary?.total_proposals).toBe(2);
    expect(bundle.evolution_summary?.deployed_proposals).toBe(1);
    expect(bundle.evolution_summary?.rolled_back_proposals).toBe(1);
  });

  test("handles missing log files gracefully", () => {
    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath: join(tmpDir, "nonexistent-query.jsonl"),
      skillLogPath: join(tmpDir, "nonexistent-skill.jsonl"),
      telemetryLogPath: join(tmpDir, "nonexistent-telemetry.jsonl"),
      evolutionAuditLogPath: join(tmpDir, "nonexistent-evolution.jsonl"),
    });

    expect(bundle.positive_queries).toEqual([]);
    expect(bundle.eval_entries).toEqual([]);
    expect(bundle.session_metrics.total_sessions).toBe(0);
    expect(bundle.evolution_summary).toBeNull();
  });

  test("generates eval entries via buildEvalSet", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const bundle = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    expect(bundle.eval_entries.length).toBeGreaterThan(0);
    // Should have both positives and negatives
    const positives = bundle.eval_entries.filter((e) => e.should_trigger);
    const negatives = bundle.eval_entries.filter((e) => !e.should_trigger);
    expect(positives.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThan(0);
  });
});
