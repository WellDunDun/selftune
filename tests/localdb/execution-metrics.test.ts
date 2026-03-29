import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openDb } from "../../cli/selftune/localdb/db.js";
import {
  getExecutionMetrics,
  getSessionCommits,
  getSkillCommitSummary,
} from "../../cli/selftune/localdb/queries.js";
import { handleSkillReport } from "../../cli/selftune/routes/skill-report.js";

function seedSession(
  db: Database,
  sessionId: string,
  normalizedAt: string = "2026-03-17T10:00:00Z",
): void {
  db.run(
    `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
     VALUES (?, ?, ?, ?)`,
    [sessionId, "claude_code", "2.0", normalizedAt],
  );
}

function seedSkillInvocation(
  db: Database,
  overrides: {
    skill_invocation_id?: string;
    session_id?: string;
    occurred_at?: string;
    skill_name?: string;
    query?: string;
    triggered?: number;
  } = {},
): void {
  const sessionId = overrides.session_id ?? "sess-001";
  const occurredAt = overrides.occurred_at ?? "2026-03-17T10:00:00Z";
  seedSession(db, sessionId, occurredAt);
  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.skill_invocation_id ?? `si-${sessionId}-${occurredAt}`,
      sessionId,
      occurredAt,
      overrides.skill_name ?? "Research",
      "manual",
      overrides.triggered ?? 1,
      0.9,
      null,
      null,
      "claude",
      overrides.query ?? "do research",
      `/skills/${overrides.skill_name ?? "Research"}/SKILL.md`,
      null,
      "hook",
    ],
  );
}

function seedExecutionFact(
  db: Database,
  overrides: {
    session_id?: string;
    occurred_at?: string;
    files_changed?: number;
    lines_added?: number;
    lines_removed?: number;
    lines_modified?: number;
    cost_usd?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    artifact_count?: number;
    session_type?: string | null;
    duration_ms?: number;
    input_tokens?: number;
    output_tokens?: number;
  } = {},
): void {
  const sessionId = overrides.session_id ?? "sess-001";
  const occurredAt = overrides.occurred_at ?? "2026-03-17T10:05:00Z";
  seedSession(db, sessionId, occurredAt);
  db.run(
    `INSERT INTO execution_facts
      (session_id, occurred_at, prompt_id, tool_calls_json, total_tool_calls,
       assistant_turns, errors_encountered, input_tokens, output_tokens,
       cached_input_tokens, reasoning_output_tokens, cost_usd,
       files_changed, lines_added, lines_removed, lines_modified,
       artifact_count, session_type, duration_ms, completion_status,
       schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      occurredAt,
      null,
      JSON.stringify({ Read: 1 }),
      1,
      1,
      0,
      overrides.input_tokens ?? 100,
      overrides.output_tokens ?? 40,
      overrides.cached_input_tokens ?? 0,
      overrides.reasoning_output_tokens ?? 0,
      overrides.cost_usd ?? 0,
      overrides.files_changed ?? 0,
      overrides.lines_added ?? 0,
      overrides.lines_removed ?? 0,
      overrides.lines_modified ?? 0,
      overrides.artifact_count ?? 0,
      overrides.session_type ?? null,
      overrides.duration_ms ?? 1000,
      "completed",
      "2.0",
      "claude_code",
      occurredAt,
      "norm-1",
      "hook",
      null,
    ],
  );
}

function seedCommitTracking(
  db: Database,
  overrides: {
    session_id?: string;
    commit_sha?: string;
    commit_title?: string | null;
    branch?: string | null;
    repo_remote?: string | null;
    timestamp?: string;
  } = {},
): void {
  const sessionId = overrides.session_id ?? "sess-001";
  seedSession(db, sessionId, overrides.timestamp ?? "2026-03-17T10:10:00Z");
  db.run(
    `INSERT INTO commit_tracking
      (session_id, commit_sha, commit_title, branch, repo_remote, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      overrides.commit_sha ?? "abc1234",
      overrides.commit_title ?? "Fix bug",
      overrides.branch ?? "main",
      overrides.repo_remote ?? "https://github.com/acme/repo.git",
      overrides.timestamp ?? "2026-03-17T10:10:00Z",
    ],
  );
}

describe("execution and commit query enrichments", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("aggregates enriched execution facts across skill sessions", () => {
    seedExecutionFact(db, {
      session_id: "sess-a",
      files_changed: 3,
      lines_added: 10,
      lines_removed: 4,
      cost_usd: 0.12,
      cached_input_tokens: 100,
      reasoning_output_tokens: 20,
      artifact_count: 1,
      session_type: "interactive",
    });
    seedExecutionFact(db, {
      session_id: "sess-b",
      files_changed: 5,
      lines_added: 7,
      lines_removed: 6,
      cost_usd: 0.08,
      cached_input_tokens: 50,
      reasoning_output_tokens: 10,
      artifact_count: 2,
      session_type: "batch",
    });
    seedExecutionFact(db, {
      session_id: "sess-c",
      files_changed: 99,
      lines_added: 999,
      lines_removed: 999,
      cost_usd: 9.99,
      cached_input_tokens: 999,
      reasoning_output_tokens: 999,
      artifact_count: 9,
      session_type: "ignored",
    });

    const metrics = getExecutionMetrics(db, ["sess-a", "sess-b"]);

    expect(metrics.avg_files_changed).toBe(4);
    expect(metrics.total_lines_added).toBe(17);
    expect(metrics.total_lines_removed).toBe(10);
    expect(metrics.total_cost_usd).toBeCloseTo(0.2, 8);
    expect(metrics.avg_cost_usd).toBeCloseTo(0.1, 8);
    expect(metrics.cached_input_tokens_total).toBe(150);
    expect(metrics.reasoning_output_tokens_total).toBe(30);
    expect(metrics.artifact_count).toBe(3);
    expect(metrics.session_type_distribution).toEqual({
      batch: 1,
      interactive: 1,
    });
  });

  test("returns commits for a session in reverse chronological order", () => {
    seedCommitTracking(db, {
      session_id: "sess-a",
      commit_sha: "1111111",
      commit_title: "Old commit",
      branch: "main",
      timestamp: "2026-03-17T10:00:00Z",
    });
    seedCommitTracking(db, {
      session_id: "sess-a",
      commit_sha: "2222222",
      commit_title: "New commit",
      branch: "feature/routing",
      timestamp: "2026-03-17T11:00:00Z",
    });
    seedCommitTracking(db, {
      session_id: "sess-b",
      commit_sha: "3333333",
      commit_title: "Other session",
      branch: "other",
      timestamp: "2026-03-17T12:00:00Z",
    });

    const commits = getSessionCommits(db, "sess-a");

    expect(commits).toHaveLength(2);
    expect(commits.map((commit) => commit.commit_sha)).toEqual(["2222222", "1111111"]);
    expect(commits[0].branch).toBe("feature/routing");
    expect(commits[1].commit_title).toBe("Old commit");
  });

  test("summarizes commits for skill sessions without double-counting duplicated invocations", () => {
    seedSkillInvocation(db, {
      session_id: "sess-a",
      occurred_at: "2026-03-17T10:00:00Z",
      skill_invocation_id: "si-a-1",
      skill_name: "Research",
    });
    seedSkillInvocation(db, {
      session_id: "sess-a",
      occurred_at: "2026-03-17T10:01:00Z",
      skill_invocation_id: "si-a-2",
      skill_name: "Research",
    });
    seedSkillInvocation(db, {
      session_id: "sess-b",
      occurred_at: "2026-03-17T11:00:00Z",
      skill_invocation_id: "si-b-1",
      skill_name: "Research",
    });
    seedSkillInvocation(db, {
      session_id: "sess-c",
      occurred_at: "2026-03-17T12:00:00Z",
      skill_invocation_id: "si-c-1",
      skill_name: "Debug",
    });

    seedCommitTracking(db, {
      session_id: "sess-a",
      commit_sha: "aaa1111",
      commit_title: "Fix routing",
      branch: "main",
      timestamp: "2026-03-17T10:15:00Z",
    });
    seedCommitTracking(db, {
      session_id: "sess-a",
      commit_sha: "aaa2222",
      commit_title: "Refine prompts",
      branch: "feature/routing",
      timestamp: "2026-03-17T10:20:00Z",
    });
    seedCommitTracking(db, {
      session_id: "sess-b",
      commit_sha: "bbb1111",
      commit_title: "Add tests",
      branch: "main",
      timestamp: "2026-03-17T11:15:00Z",
    });
    seedCommitTracking(db, {
      session_id: "sess-c",
      commit_sha: "ccc1111",
      commit_title: "Unrelated skill",
      branch: "debug",
      timestamp: "2026-03-17T12:15:00Z",
    });

    const summary = getSkillCommitSummary(db, "Research");

    expect(summary.total_commits).toBe(3);
    expect(summary.unique_branches).toBe(2);
    expect(summary.recent_commits).toHaveLength(3);
    expect(summary.recent_commits.map((commit) => commit.sha)).toEqual([
      "bbb1111",
      "aaa2222",
      "aaa1111",
    ]);
  });

  test("includes execution metrics and commit summary in the skill report response", async () => {
    seedSkillInvocation(db, {
      session_id: "sess-report",
      occurred_at: "2026-03-17T09:00:00Z",
      skill_invocation_id: "si-report",
      skill_name: "Research",
      query: "improve research routing",
      triggered: 1,
    });
    seedExecutionFact(db, {
      session_id: "sess-report",
      lines_added: 14,
      lines_removed: 3,
      files_changed: 2,
      cost_usd: 0.04,
      cached_input_tokens: 25,
      reasoning_output_tokens: 6,
      artifact_count: 1,
      session_type: "interactive",
      input_tokens: 200,
      output_tokens: 80,
      duration_ms: 2500,
    });
    seedCommitTracking(db, {
      session_id: "sess-report",
      commit_sha: "report123",
      commit_title: "Research routing tweak",
      branch: "main",
      timestamp: "2026-03-17T09:30:00Z",
    });

    const response = handleSkillReport(db, "Research");
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.execution_metrics).toMatchObject({
      avg_files_changed: 2,
      total_lines_added: 14,
      total_lines_removed: 3,
      total_cost_usd: 0.04,
      cached_input_tokens_total: 25,
      reasoning_output_tokens_total: 6,
      artifact_count: 1,
      session_type_distribution: { interactive: 1 },
    });
    expect(payload.commit_summary).toMatchObject({
      total_commits: 1,
      unique_branches: 1,
      recent_commits: [
        {
          sha: "report123",
          title: "Research routing tweak",
          branch: "main",
          timestamp: "2026-03-17T09:30:00Z",
        },
      ],
    });
  });
});
