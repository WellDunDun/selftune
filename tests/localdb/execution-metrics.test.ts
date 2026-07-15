import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../packages/runtime/localdb/db.js";
import { persistPackageCandidateEvaluation } from "../../packages/runtime/create/package-candidate-state.js";
import { insertSearchRun } from "../../packages/runtime/create/package-search.js";
import {
  getExecutionMetrics,
  getSessionCommits,
  getSkillCommitSummary,
} from "../../packages/runtime/localdb/queries.js";
import { handleSkillReport } from "@selftune/local/routes/skill-report";

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
  const tempDirs: string[] = [];

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
    db.run(
      `INSERT INTO evolution_audit
        (timestamp, proposal_id, skill_name, action, details, validation_mode,
         validation_agent, validation_fixture_id, validation_evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-17T09:40:00Z",
        "prop-report-001",
        "Research",
        "validated",
        "Replay-backed validation",
        "host_replay",
        "claude",
        "fixture-report",
        "evolution_evidence:prop-report-001:validated",
      ],
    );

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
    expect(payload.evolution).toMatchObject([
      {
        proposal_id: "prop-report-001",
        action: "validated",
        validation_mode: "host_replay",
        validation_agent: "claude",
        validation_fixture_id: "fixture-report",
        validation_evidence_ref: "evolution_evidence:prop-report-001:validated",
      },
    ]);
  });

  test("returns create readiness for a draft-only package with no telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-report-draft-"));
    tempDirs.push(root);

    const skillDir = join(root, ".agents", "skills", "draft-writer");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: draft-writer
description: >
  Use when the user needs a draft writing package.
---

# Draft Writer
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(
      join(skillDir, "selftune.create.json"),
      JSON.stringify(
        {
          version: 1,
          entry_workflow: "workflows/default.md",
          supports_package_replay: true,
          expected_resources: {
            workflows: true,
            references: true,
            scripts: false,
            assets: false,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const response = handleSkillReport(db, "draft-writer");
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(payload.create_readiness).toMatchObject({
        skill_name: "draft-writer",
        state: "needs_evals",
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("returns watch trust score from the latest package evaluation watch summary", async () => {
    seedSkillInvocation(db, {
      skill_name: "Research",
      session_id: "sess-watch-score",
      occurred_at: "2026-04-15T10:00:00Z",
    });

    db.run(
      `INSERT INTO package_evaluation_reports (skill_name, stored_at, summary_json)
       VALUES (?, ?, ?)`,
      [
        "Research",
        "2026-04-15T10:05:00Z",
        JSON.stringify({
          skill_name: "Research",
          status: "passed",
          evaluation_passed: true,
          watch: {
            snapshot: {
              timestamp: "2026-04-15T10:05:00Z",
              skill_name: "Research",
              window_sessions: 20,
              skill_checks: 10,
              pass_rate: 0.9,
              false_negative_rate: 0.1,
              by_invocation_type: {
                explicit: { passed: 5, total: 5 },
                implicit: { passed: 3, total: 3 },
                contextual: { passed: 1, total: 1 },
                negative: { passed: 0, total: 1 },
              },
              regression_detected: false,
              baseline_pass_rate: 0.8,
            },
            alert: null,
            rolled_back: false,
            recommendation: 'Skill "Research" is stable.',
            recommended_command: null,
            grade_alert: null,
            grade_regression: null,
          },
        }),
      ],
    );

    const response = handleSkillReport(db, "Research");
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.watch_trust_score).toBe(1);
  });

  test("surfaces frontier state and latest search provenance in the skill report", async () => {
    const skillDir = mkdtempSync(join(tmpdir(), "selftune-frontier-report-"));
    tempDirs.push(skillDir);
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# Draft Writer\n", "utf-8");

    persistPackageCandidateEvaluation(
      {
        summary: {
          skill_name: "draft-writer",
          skill_path: skillPath,
          mode: "package",
          package_fingerprint: "pkg_sha256_rootfrontier0001",
          evaluation_source: "fresh",
          status: "passed",
          evaluation_passed: true,
          next_command: null,
          replay: {
            mode: "package",
            validation_mode: "host_replay",
            agent: "claude",
            proposal_id: "proposal-root",
            fixture_id: "fixture-root",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
          },
          routing: {
            mode: "routing",
            validation_mode: "host_replay",
            agent: "claude",
            proposal_id: "proposal-root-routing",
            fixture_id: "fixture-root-routing",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
          },
          baseline: {
            mode: "package",
            baseline_pass_rate: 0.4,
            with_skill_pass_rate: 0.6,
            lift: 0.2,
            adds_value: true,
            measured_at: "2026-04-15T09:00:00.000Z",
          },
          body: {
            structural_valid: true,
            structural_reason: "ok",
            quality_score: 0.9,
            quality_reason: "clear",
            quality_threshold: 0.6,
            quality_passed: true,
            valid: true,
          },
          unit_tests: {
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            run_at: "2026-04-15T09:10:00.000Z",
            failing_tests: [],
          },
        },
        replay: {
          skill: "draft-writer",
          skill_path: skillPath,
          mode: "package",
          agent: "claude",
          proposal_id: "proposal-root",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: "fixture-root",
          results: [],
        },
        baseline: {
          skill_name: "draft-writer",
          mode: "package",
          baseline_pass_rate: 0.4,
          with_skill_pass_rate: 0.6,
          lift: 0.2,
          adds_value: true,
          per_entry: [],
          measured_at: "2026-04-15T09:00:00.000Z",
        },
      },
      db,
    );

    insertSearchRun(db, {
      search_id: "sr-frontier-1",
      skill_name: "draft-writer",
      parent_candidate_id: null,
      winner_candidate_id: null,
      winner_rationale: null,
      candidates_evaluated: 1,
      started_at: "2026-04-15T09:30:00.000Z",
      completed_at: "2026-04-15T09:31:00.000Z",
      provenance: {
        frontier_size: 1,
        parent_selection_method: "none_first_run",
        candidate_fingerprints: ["pkg_sha256_rootfrontier0001"],
        evaluation_summaries: [],
      },
    });

    const response = handleSkillReport(db, "draft-writer");
    const payload = (await response.json()) as Record<string, unknown>;
    const frontierState = payload.frontier_state as Record<string, unknown>;
    const latestSearchRun = frontierState.latest_search_run as Record<string, unknown>;
    const members = frontierState.members as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(frontierState.skill_name).toBe("draft-writer");
    expect(frontierState.accepted_count).toBe(1);
    expect(frontierState.rejected_count).toBe(0);
    expect(frontierState.pending_count).toBe(0);
    expect(members).toHaveLength(1);
    expect(members[0]?.decision).toBe("accepted");
    expect(members[0]?.evidence_rank).toBe(1);
    expect(latestSearchRun.search_id).toBe("sr-frontier-1");
    expect(latestSearchRun.provenance).toMatchObject({
      parent_selection_method: "none_first_run",
    });
  });
});
