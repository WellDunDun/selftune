import { decodeDashboardActionLine } from "../../packages/runtime/dashboard-contract/action-events.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDashboardLlmObserver,
  emitDashboardStepProgress,
} from "../../packages/runtime/dashboard-action-instrumentation.js";
import {
  emitDashboardActionMetrics,
  emitDashboardActionProgress,
} from "../../packages/runtime/dashboard-action-events.js";
import { startDashboardActionStream } from "../../packages/runtime/dashboard-action-stream.js";
import { readJsonl } from "../../packages/runtime/utils/jsonl.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  delete process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
  delete process.env.SELFTUNE_DASHBOARD_STREAM_DISABLE;
});

describe("dashboard-action-stream", () => {
  it("records stdout and finish events for terminal-run creator loop commands", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "eval",
      "generate",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write("building eval set\n");
    process.stderr.write("warming judge\n");
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events.map((event) => event.stage)).toEqual(["started", "stdout", "stderr", "finished"]);
    expect(events[0]?.action).toBe("generate-evals");
    expect(events[0]?.skill_name).toBe("Taxes");
    expect(events[1]?.chunk).toContain("building eval set");
    expect(events[3]?.success).toBe(true);
  });

  it("skips logging when dashboard streaming is explicitly disabled", () => {
    process.env.SELFTUNE_DASHBOARD_STREAM_DISABLE = "1";
    const session = startDashboardActionStream(["watch", "--skill", "Taxes"]);
    expect(session).toBeNull();
  });

  it("marks validated replay dry-runs as success even with exit code 1", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before_pass_rate: 0.75,
        after_pass_rate: 1,
        net_change: 0.25,
        validation_mode: "judge",
      })}\n`,
    );
    process.stderr.write("[NOT DEPLOYED] Dry run - proposal validated but not deployed\n");
    session?.finish(1);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events.at(-1)?.stage).toBe("finished");
    expect(events.at(-1)?.success).toBe(true);
    expect(events.at(-1)?.exit_code).toBe(1);
    expect(events.at(-1)?.error).toBeNull();
    expect(events.at(-1)?.summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: 0.75,
      after_pass_rate: 1,
      net_change: 0.25,
      validation_mode: "judge",
    });
  });

  it("maps create baseline into the dashboard baseline action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "create",
      "baseline",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--mode",
      "package",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill_name: "Taxes",
        mode: "package",
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.9,
        lift: 0.5,
        adds_value: true,
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("measure-baseline");
    expect(events.at(-1)?.summary).toEqual({
      reason: "Baseline measured",
      improved: true,
      deployed: null,
      before_pass_rate: 0.4,
      after_pass_rate: 0.9,
      net_change: 0.5,
      validation_mode: "host_replay",
    });
  });

  it("maps create check into the draft package validation action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "create",
      "check",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        ok: false,
        state: "needs_spec_validation",
        spec_validation: {
          ok: false,
          validator: "skills-ref",
        },
        readiness: {
          summary:
            "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
        },
      })}\n`,
    );
    session?.finish(1);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("create-check");
    expect(events.at(-1)?.success).toBe(false);
    expect(events.at(-1)?.summary).toEqual({
      reason:
        "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
      improved: false,
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: "skills-ref",
    });
  });

  it("maps verify into the draft package report action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream(["verify", "--skill-path", "/tmp/Taxes/SKILL.md"]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        skill_path: "/tmp/Taxes/SKILL.md",
        readiness_state: "ready_to_publish",
        verified: true,
        next_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
        readiness: {
          ok: true,
          state: "ready_to_publish",
          summary: "Draft package is ready to publish.",
          next_command: null,
        },
        report: {
          summary: {
            skill_name: "Taxes",
            status: "passed",
            evaluation_passed: true,
            next_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
            replay: {
              validation_mode: "host_replay",
            },
            baseline: {
              baseline_pass_rate: 0.45,
              with_skill_pass_rate: 0.85,
              lift: 0.4,
            },
          },
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("report-package");
    expect(events.at(-1)?.summary).toEqual({
      reason: "Package report ready",
      improved: true,
      deployed: null,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      recommended_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
    });
  });

  it("maps search-run into the bounded package search action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "search-run",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        search_id: "sr-search-1",
        skill_name: "Taxes",
        parent_candidate_id: "cand-parent",
        winner_candidate_id: "cand-winner",
        winner_rationale: "Measured improvement vs parent: baseline lift +0.25.",
        candidates_evaluated: 3,
        started_at: "2026-04-15T00:00:00Z",
        completed_at: "2026-04-15T00:01:00Z",
        provenance: {
          frontier_size: 2,
          parent_selection_method: "highest_ranked_frontier",
          candidate_fingerprints: ["fp1", "fp2", "fp3"],
          evaluation_summaries: [],
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("search-run");
    expect(events.at(-1)?.summary).toMatchObject({
      reason: "Measured improvement vs parent: baseline lift +0.25.",
      improved: true,
      search_run: {
        search_id: "sr-search-1",
        winner_candidate_id: "cand-winner",
        frontier_size: 2,
        parent_selection_method: "highest_ranked_frontier",
      },
    });
  });

  it("emits step progress while create check validates a draft package", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    const skillDir = join(tempDir, "draft-writer");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: draft-writer
description: >
  Use when the user needs a draft writing package validated before publish.
---

# Draft Writer
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");

    const session = startDashboardActionStream([
      "create",
      "check",
      "--skill-path",
      join(skillDir, "SKILL.md"),
    ]);

    const { computeCreateCheckResult } = await import("../../packages/runtime/create/readiness.js");
    await computeCreateCheckResult(skillDir, {
      getTestingReadiness: () => null,
      validateAgentSkill: async () => ({
        ok: false,
        issues: [],
        raw_stdout: "",
        raw_stderr: "",
        exit_code: 1,
        validator: "skills-ref",
        command: `uvx skills-ref validate ${skillDir}`,
      }),
    });
    session?.finish(1);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    const progressEvents = events.filter((event) => event.stage === "progress");
    expect(progressEvents.map((event) => event.progress?.phase)).toEqual([
      "load_draft_package",
      "load_draft_package",
      "spec_validation",
      "spec_validation",
      "compute_create_readiness",
      "compute_create_readiness",
    ]);
    expect(progressEvents.at(-1)?.progress).toMatchObject({
      current: 3,
      total: 3,
      status: "finished",
      passed: false,
    });
  });

  it("maps create publish into the draft deploy action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "create",
      "publish",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: false,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 1,
            baseline_regressions: 0,
            replay_failure_samples: [
              { query: "draft my taxes", evidence: "selected competing skill" },
            ],
            baseline_win_samples: [
              { query: "file my taxes", evidence: "with-skill replay passed" },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 24000,
              avg_duration_ms: 4000,
              total_input_tokens: 1200,
              total_output_tokens: 300,
              total_cache_creation_input_tokens: 100,
              total_cache_read_input_tokens: 500,
              total_cost_usd: 0.42,
              total_turns: 12,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 31000,
              avg_duration_ms: 5166.7,
              total_input_tokens: 1500,
              total_output_tokens: 280,
              total_cache_creation_input_tokens: 120,
              total_cache_read_input_tokens: 450,
              total_cost_usd: 0.51,
              total_turns: 15,
            },
          },
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("deploy-candidate");
    expect(events.at(-1)?.summary).toEqual({
      reason: "Package evaluation passed",
      improved: true,
      deployed: true,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      watch_gate_passed: null,
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 1,
        baseline_regressions: 0,
        replay_failure_samples: [{ query: "draft my taxes", evidence: "selected competing skill" }],
        baseline_win_samples: [{ query: "file my taxes", evidence: "with-skill replay passed" }],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 24000,
          avg_duration_ms: 4000,
          total_input_tokens: 1200,
          total_output_tokens: 300,
          total_cache_creation_input_tokens: 100,
          total_cache_read_input_tokens: 500,
          total_cost_usd: 0.42,
          total_turns: 12,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 31000,
          avg_duration_ms: 5166.7,
          total_input_tokens: 1500,
          total_output_tokens: 280,
          total_cache_creation_input_tokens: 120,
          total_cache_read_input_tokens: 450,
          total_cost_usd: 0.51,
          total_turns: 15,
        },
      },
    });
  });

  it("maps publish --no-watch into the draft deploy action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "publish",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--no-watch",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: false,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("deploy-candidate");
    expect(events.at(-1)?.summary).toEqual({
      reason: "Package evaluation passed",
      improved: true,
      deployed: true,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      watch_gate_passed: null,
    });
  });

  it("maps create report into the draft package report action summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "create",
      "report",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        summary: {
          skill_name: "Taxes",
          status: "passed",
          evaluation_passed: true,
          next_command: "selftune create publish --skill-path /tmp/Taxes/SKILL.md",
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 1,
            baseline_regressions: 0,
            replay_failure_samples: [
              { query: "late tax filing", evidence: "did not select target skill" },
            ],
            baseline_win_samples: [
              { query: "estimate state taxes", evidence: "with-skill replay passed" },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 18000,
              avg_duration_ms: 3000,
              total_input_tokens: 900,
              total_output_tokens: 220,
              total_cache_creation_input_tokens: 90,
              total_cache_read_input_tokens: 410,
              total_cost_usd: 0.28,
              total_turns: 10,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 25000,
              avg_duration_ms: 4166.7,
              total_input_tokens: 1100,
              total_output_tokens: 210,
              total_cache_creation_input_tokens: 95,
              total_cache_read_input_tokens: 360,
              total_cost_usd: 0.33,
              total_turns: 13,
            },
          },
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("report-package");
    expect(events.at(-1)?.summary).toEqual({
      reason: "Package report ready",
      improved: true,
      deployed: null,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      recommended_command: "selftune create publish --skill-path /tmp/Taxes/SKILL.md",
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 1,
        baseline_regressions: 0,
        replay_failure_samples: [
          { query: "late tax filing", evidence: "did not select target skill" },
        ],
        baseline_win_samples: [
          { query: "estimate state taxes", evidence: "with-skill replay passed" },
        ],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 18000,
          avg_duration_ms: 3000,
          total_input_tokens: 900,
          total_output_tokens: 220,
          total_cache_creation_input_tokens: 90,
          total_cache_read_input_tokens: 410,
          total_cost_usd: 0.28,
          total_turns: 10,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 25000,
          avg_duration_ms: 4166.7,
          total_input_tokens: 1100,
          total_output_tokens: 210,
          total_cache_creation_input_tokens: 95,
          total_cache_read_input_tokens: 360,
          total_cost_usd: 0.33,
          total_turns: 13,
        },
      },
    });
  });

  it("maps direct watch runs into measured live-watch summaries", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "watch",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 8,
          pass_rate: 0.7,
          false_negative_rate: 0.3,
          by_invocation_type: {
            explicit: { passed: 2, total: 3 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 1 },
          },
          regression_detected: true,
          baseline_pass_rate: 0.9,
        },
        alert:
          'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
        rolledBack: false,
        recommendation:
          "Consider running: selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        gradeAlert: null,
        gradeRegression: null,
      })}\n`,
    );
    session?.finish(1);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("watch");
    expect(events.at(-1)?.summary).toEqual({
      reason:
        'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
      improved: false,
      deployed: true,
      before_pass_rate: 0.9,
      before_label: "Baseline",
      after_pass_rate: 0.7,
      after_label: "Observed",
      net_change: -0.2,
      net_change_label: "Delta",
      validation_mode: "trigger_watch",
      validation_label: "Signal",
      recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
      package_watch: {
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 8,
          pass_rate: 0.7,
          false_negative_rate: 0.3,
          by_invocation_type: {
            explicit: { passed: 2, total: 3 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 1 },
          },
          regression_detected: true,
          baseline_pass_rate: 0.9,
        },
        alert:
          'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
        rolled_back: false,
        recommendation:
          "Consider running: selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        grade_alert: null,
        grade_regression: null,
      },
    });
  });

  it("maps create publish --watch into measured live-watch summaries", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "create",
      "publish",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--watch",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: true,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 1,
            baseline_regressions: 0,
            replay_failure_samples: [
              { query: "late tax filing", evidence: "did not select target skill" },
            ],
            baseline_win_samples: [
              { query: "estimate state taxes", evidence: "with-skill replay passed" },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 18000,
              avg_duration_ms: 3000,
              total_input_tokens: 900,
              total_output_tokens: 220,
              total_cache_creation_input_tokens: 90,
              total_cache_read_input_tokens: 410,
              total_cost_usd: 0.28,
              total_turns: 10,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 25000,
              avg_duration_ms: 4166.7,
              total_input_tokens: 1100,
              total_output_tokens: 210,
              total_cache_creation_input_tokens: 95,
              total_cache_read_input_tokens: 360,
              total_cost_usd: 0.33,
              total_turns: 13,
            },
          },
        },
        watch_result: {
          snapshot: {
            timestamp: "2026-04-14T12:30:00.000Z",
            skill_name: "Taxes",
            window_sessions: 20,
            skill_checks: 6,
            pass_rate: 0.88,
            false_negative_rate: 0.12,
            by_invocation_type: {
              explicit: { passed: 2, total: 2 },
              implicit: { passed: 2, total: 3 },
              contextual: { passed: 1, total: 1 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: false,
            baseline_pass_rate: 0.8,
          },
          alert: null,
          rolledBack: false,
          recommendation:
            'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
          recommended_command: null,
          gradeAlert: null,
          gradeRegression: null,
        },
      })}\n`,
    );
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("watch");
    expect(events.at(-1)?.summary).toEqual({
      reason:
        'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
      improved: true,
      deployed: true,
      before_pass_rate: 0.8,
      before_label: "Baseline",
      after_pass_rate: 0.88,
      after_label: "Observed",
      net_change: 0.08,
      net_change_label: "Delta",
      validation_mode: "live_watch",
      validation_label: "Signal",
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 1,
        baseline_regressions: 0,
        replay_failure_samples: [
          { query: "late tax filing", evidence: "did not select target skill" },
        ],
        baseline_win_samples: [
          { query: "estimate state taxes", evidence: "with-skill replay passed" },
        ],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 18000,
          avg_duration_ms: 3000,
          total_input_tokens: 900,
          total_output_tokens: 220,
          total_cache_creation_input_tokens: 90,
          total_cache_read_input_tokens: 410,
          total_cost_usd: 0.28,
          total_turns: 10,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 25000,
          avg_duration_ms: 4166.7,
          total_input_tokens: 1100,
          total_output_tokens: 210,
          total_cache_creation_input_tokens: 95,
          total_cache_read_input_tokens: 360,
          total_cost_usd: 0.33,
          total_turns: 13,
        },
      },
      package_watch: {
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 6,
          pass_rate: 0.88,
          false_negative_rate: 0.12,
          by_invocation_type: {
            explicit: { passed: 2, total: 2 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 0 },
          },
          regression_detected: false,
          baseline_pass_rate: 0.8,
        },
        alert: null,
        rolled_back: false,
        recommendation:
          'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
        recommended_command: null,
        grade_alert: null,
        grade_regression: null,
      },
    });
  });

  it("maps improve --dry-run into replay dry-run summaries", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "improve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before_pass_rate: 0.75,
        after_pass_rate: 1,
        net_change: 0.25,
        validation_mode: "judge",
      })}\n`,
    );
    process.stderr.write("[NOT DEPLOYED] Dry run - proposal validated but not deployed\n");
    session?.finish(1);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("replay-dry-run");
    expect(events.at(-1)?.success).toBe(true);
    expect(events.at(-1)?.summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: 0.75,
      after_pass_rate: 1,
      net_change: 0.25,
      validation_mode: "judge",
    });
  });

  it("maps run into orchestrate action events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream(["run", "--dry-run"]);

    expect(session).not.toBeNull();
    process.stdout.write('{"summary":{"evaluated":1}}\n');
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events[0]?.action).toBe("orchestrate");
    expect(events.at(-1)?.success).toBe(true);
  });

  it("appends metrics events under the active dashboard action context", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    emitDashboardActionMetrics({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "runtime-session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 24,
      total_cost_usd: 0.09,
      duration_ms: 1500,
      num_turns: 1,
    });
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events.map((event) => event.stage)).toEqual(["started", "metrics", "finished"]);
    expect(events[1]?.metrics).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "runtime-session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 24,
      total_cost_usd: 0.09,
      duration_ms: 1500,
      num_turns: 1,
    });
  });

  it("appends progress events under the active dashboard action context", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    emitDashboardActionProgress({
      current: 1,
      total: 4,
      status: "started",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: null,
      evidence: null,
    });
    emitDashboardActionProgress({
      current: 1,
      total: 4,
      status: "finished",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: true,
      evidence: "selected target skill",
    });
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events.map((event) => event.stage)).toEqual([
      "started",
      "progress",
      "progress",
      "finished",
    ]);
    expect(events[1]?.progress).toEqual({
      current: 1,
      total: 4,
      status: "started",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: null,
      evidence: null,
    });
    expect(events[2]?.progress).toEqual({
      current: 1,
      total: 4,
      status: "finished",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: true,
      evidence: "selected target skill",
    });
  });

  it("emits provider-normalized LLM progress and metrics for non-replay actions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "eval",
      "unit-test",
      "--skill",
      "Taxes",
      "--generate",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    emitDashboardStepProgress({
      current: 1,
      total: 3,
      status: "started",
      phase: "load_generation_inputs",
      label: "Load skill and failure context",
    });
    emitDashboardStepProgress({
      current: 1,
      total: 3,
      status: "finished",
      phase: "load_generation_inputs",
      label: "Load skill and failure context",
      passed: true,
      evidence: "4 eval failures",
    });

    const observer = createDashboardLlmObserver({
      current: 2,
      total: 3,
      phase: "generate_tests",
      label: "Generate unit tests",
    });
    observer.onStart?.({
      agent: "claude",
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      durationMs: null,
      success: null,
      error: null,
    });
    observer.onFinish?.({
      agent: "claude",
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      durationMs: 2200,
      success: true,
      error: null,
    });
    session?.finish(0);

    const events = readJsonl(actionLogPath, decodeDashboardActionLine);
    expect(events.map((event) => event.stage)).toEqual([
      "started",
      "progress",
      "progress",
      "metrics",
      "progress",
      "metrics",
      "progress",
      "finished",
    ]);
    expect(events[4]?.progress).toEqual({
      current: 2,
      total: 3,
      status: "started",
      unit: "llm_call",
      phase: "generate_tests",
      label: "Generate unit tests",
      query: null,
      passed: null,
      evidence: "claude_code · claude-haiku-4-5-20251001",
    });
    expect(events[6]?.progress).toEqual({
      current: 2,
      total: 3,
      status: "finished",
      unit: "llm_call",
      phase: "generate_tests",
      label: "Generate unit tests",
      query: null,
      passed: true,
      evidence: "claude_code · claude-haiku-4-5-20251001 · 2.2s",
    });
    expect(events[5]?.metrics).toEqual({
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      session_id: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: 2200,
      num_turns: null,
    });
  });
});
