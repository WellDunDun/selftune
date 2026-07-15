import { describe, expect, it, test } from "bun:test";

import { checkPublishWatchGate, runCreatePublish } from "../../packages/runtime/create/publish.js";
import type { WatchResult } from "../../packages/runtime/monitoring/watch.js";
import type { MonitoringSnapshot } from "../../packages/runtime/types.js";

const passingPackageEvaluation = {
  summary: {
    skill_name: "research-assistant",
    skill_path: "/tmp/research-assistant/SKILL.md",
    mode: "package" as const,
    status: "passed" as const,
    evaluation_passed: true,
    next_command: null,
    replay: {
      mode: "package" as const,
      validation_mode: "host_replay" as const,
      agent: "claude",
      proposal_id: "create-replay-1",
      fixture_id: "fixture-1",
      total: 2,
      passed: 2,
      failed: 0,
      pass_rate: 1,
    },
    baseline: {
      mode: "package" as const,
      baseline_pass_rate: 0.5,
      with_skill_pass_rate: 1,
      lift: 0.5,
      adds_value: true,
      measured_at: "2026-04-14T12:00:00.000Z",
    },
  },
  replay: {
    skill: "research-assistant",
    skill_path: "/tmp/research-assistant/SKILL.md",
    mode: "package" as const,
    agent: "claude",
    proposal_id: "create-replay-1",
    total: 2,
    passed: 2,
    failed: 0,
    pass_rate: 1,
    fixture_id: "fixture-1",
    results: [],
  },
  baseline: {
    skill_name: "research-assistant",
    mode: "package" as const,
    baseline_pass_rate: 0.5,
    with_skill_pass_rate: 1,
    lift: 0.5,
    adds_value: true,
    per_entry: [],
    measured_at: "2026-04-14T12:00:00.000Z",
  },
};

const readyToPublishCheck = {
  skill: "research-assistant",
  skill_dir: "/tmp/research-assistant",
  skill_path: "/tmp/research-assistant/SKILL.md",
  ok: true,
  state: "ready_to_publish" as const,
  next_command: "selftune create publish --skill-path /tmp/research-assistant/SKILL.md",
  spec_validation: {
    ok: true,
    issues: [],
    raw_stdout: "",
    raw_stderr: "",
    exit_code: 0,
    validator: "skills-ref",
    command: "uvx skills-ref validate /tmp/research-assistant",
  },
  readiness: {
    ok: true,
    state: "ready_to_publish" as const,
    summary: "ready",
    next_command: "selftune create publish --skill-path /tmp/research-assistant/SKILL.md",
    checks: {
      skill_md: true,
      frontmatter_present: true,
      skill_name_matches_dir: true,
      description_present: true,
      description_within_budget: true,
      skill_md_within_line_budget: true,
      manifest_present: true,
      workflow_entry: true,
      references_present: true,
      scripts_present: false,
      assets_present: false,
      evals_present: true,
      unit_tests_present: true,
      routing_replay_ready: true,
      routing_replay_recorded: true,
      package_replay_ready: true,
      baseline_present: true,
    },
    skill_name: "research-assistant",
    skill_dir: "/tmp/research-assistant",
    skill_path: "/tmp/research-assistant/SKILL.md",
    entry_workflow: "workflows/default.md",
    manifest_present: true,
    description_quality: {
      composite: 1,
      criteria: {
        length: 1,
        trigger_context: 1,
        vagueness: 1,
        specificity: 1,
        not_just_name: 1,
      },
    },
  },
};

describe("selftune create publish", () => {
  it("returns the shared package evaluation before handing off to watch", async () => {
    let receivedEvalSetPath: string | undefined;
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        evalSetPath: "/tmp/research-assistant/evals/release.json",
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async (options) => {
          receivedEvalSetPath = options.evalSetPath;
          return passingPackageEvaluation;
        },
      },
    );

    expect(result.published).toBe(true);
    expect(result.replay_exit_code).toBe(0);
    expect(result.baseline_exit_code).toBe(0);
    expect(result.package_evaluation).toEqual(passingPackageEvaluation.summary);
    expect(result.watch_started).toBe(false);
    expect(result.watch_result).toBeNull();
    expect(result.watch_gate_passed).toBeNull();
    expect(result.watch_trust_score).toBeNull();
    expect(result.next_command).toContain("selftune watch");
    expect(receivedEvalSetPath).toBe("/tmp/research-assistant/evals/release.json");
  });

  it("stops at package replay failure and recommends rerunning replay", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => ({
          ...passingPackageEvaluation,
          summary: {
            ...passingPackageEvaluation.summary,
            status: "replay_failed",
            evaluation_passed: false,
            next_command:
              "selftune create replay --skill-path /tmp/research-assistant/SKILL.md --mode package",
            replay: {
              ...passingPackageEvaluation.summary.replay,
              failed: 1,
              passed: 1,
              pass_rate: 0.5,
            },
          },
          replay: {
            ...passingPackageEvaluation.replay,
            failed: 1,
            passed: 1,
            pass_rate: 0.5,
          },
        }),
      },
    );

    expect(result.published).toBe(false);
    expect(result.replay_exit_code).toBe(1);
    expect(result.baseline_exit_code).toBeNull();
    expect(result.package_evaluation?.status).toBe("replay_failed");
    expect(result.watch_gate_passed).toBeNull();
    expect(result.next_command).toBe(
      "selftune create replay --skill-path /tmp/research-assistant/SKILL.md --mode package",
    );
  });

  it("stops at package baseline failure and recommends rerunning baseline", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => ({
          ...passingPackageEvaluation,
          summary: {
            ...passingPackageEvaluation.summary,
            status: "baseline_failed",
            evaluation_passed: false,
            next_command:
              "selftune create baseline --skill-path /tmp/research-assistant/SKILL.md --mode package",
            baseline: {
              ...passingPackageEvaluation.summary.baseline,
              lift: 0.01,
              adds_value: false,
            },
          },
          baseline: {
            ...passingPackageEvaluation.baseline,
            lift: 0.01,
            adds_value: false,
          },
        }),
      },
    );

    expect(result.published).toBe(false);
    expect(result.replay_exit_code).toBe(0);
    expect(result.baseline_exit_code).toBe(1);
    expect(result.package_evaluation?.status).toBe("baseline_failed");
    expect(result.watch_gate_passed).toBeNull();
    expect(result.next_command).toBe(
      "selftune create baseline --skill-path /tmp/research-assistant/SKILL.md --mode package",
    );
  });

  it("starts watch only after package replay and baseline succeed", async () => {
    const commands: string[][] = [];
    let storedPackageEvaluation: unknown = null;
    let refreshedPackageEvaluation: unknown = null;
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        refreshPackageCandidateEvaluationObservation: (evaluation) => {
          refreshedPackageEvaluation = evaluation;
          return evaluation;
        },
        writeCanonicalPackageEvaluation: (_skillName, summary) => {
          storedPackageEvaluation = summary;
          return "/tmp/.selftune/package-evaluations/research-assistant.json";
        },
        spawnSync: ((command) => {
          commands.push(command);
          return {
            stdout: new TextEncoder().encode(
              JSON.stringify({
                snapshot: {
                  timestamp: "2026-04-14T12:30:00.000Z",
                  skill_name: "research-assistant",
                  window_sessions: 20,
                  skill_checks: 5,
                  pass_rate: 0.9,
                  false_negative_rate: 0.1,
                  by_invocation_type: {
                    explicit: { passed: 2, total: 2 },
                    implicit: { passed: 2, total: 2 },
                    contextual: { passed: 1, total: 1 },
                    negative: { passed: 0, total: 0 },
                  },
                  regression_detected: false,
                  baseline_pass_rate: 0.8,
                },
                alert: null,
                rolledBack: false,
                recommendation:
                  'Skill "research-assistant" is stable. Pass rate 0.90 is within acceptable range of baseline 0.80.',
                recommended_command: null,
                gradeAlert: null,
                gradeRegression: null,
              }),
            ),
            stderr: new Uint8Array(),
            exitCode: 0,
          };
        }) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(true);
    expect(result.watch_started).toBe(true);
    expect(result.package_evaluation?.evaluation_passed).toBe(true);
    expect(result.watch_result?.snapshot.pass_rate).toBe(0.9);
    expect(result.watch_result?.recommended_command).toBeNull();
    expect(result.watch_gate_passed).toBe(true);
    expect(result.watch_trust_score).toBe(1);
    expect(result.watch_gate_warnings).toEqual([]);
    expect(result.watch_gate_bypassed).toBe(false);
    expect(result.package_evaluation?.watch).toEqual({
      snapshot: {
        timestamp: "2026-04-14T12:30:00.000Z",
        skill_name: "research-assistant",
        window_sessions: 20,
        skill_checks: 5,
        pass_rate: 0.9,
        false_negative_rate: 0.1,
        by_invocation_type: {
          explicit: { passed: 2, total: 2 },
          implicit: { passed: 2, total: 2 },
          contextual: { passed: 1, total: 1 },
          negative: { passed: 0, total: 0 },
        },
        regression_detected: false,
        baseline_pass_rate: 0.8,
      },
      alert: null,
      rolled_back: false,
      recommendation:
        'Skill "research-assistant" is stable. Pass rate 0.90 is within acceptable range of baseline 0.80.',
      recommended_command: null,
      grade_alert: null,
      grade_regression: null,
    });
    expect(result.next_command).toBeNull();
    expect(commands).toHaveLength(1);
    expect(storedPackageEvaluation).toEqual(result.package_evaluation);
    expect(refreshedPackageEvaluation).toEqual({
      ...passingPackageEvaluation,
      summary: result.package_evaluation,
    });
    expect(commands[0]?.slice(3)).toEqual([
      "watch",
      "--skill",
      "research-assistant",
      "--skill-path",
      "/tmp/research-assistant/SKILL.md",
      "--sync-first",
    ]);
  });

  it("carries the structured watch recommendation through publish-with-watch failures", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode(
            JSON.stringify({
              snapshot: {
                timestamp: "2026-04-14T12:30:00.000Z",
                skill_name: "research-assistant",
                window_sessions: 20,
                skill_checks: 6,
                pass_rate: 0.4,
                false_negative_rate: 0.6,
                by_invocation_type: {
                  explicit: { passed: 1, total: 2 },
                  implicit: { passed: 1, total: 2 },
                  contextual: { passed: 0, total: 1 },
                  negative: { passed: 0, total: 1 },
                },
                regression_detected: true,
                baseline_pass_rate: 0.8,
              },
              alert:
                'regression detected for "research-assistant": pass_rate=0.40 below baseline=0.80 minus threshold=0.10',
              rolledBack: false,
              recommendation:
                "Consider running: selftune rollback --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
              recommended_command:
                "selftune rollback --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
              gradeAlert: null,
              gradeRegression: null,
            }),
          ),
          stderr: new Uint8Array(),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(false);
    expect(result.watch_gate_blocked).toBe(true);
    expect(result.watch_started).toBe(false);
    expect(result.watch_result?.alert).toContain("regression detected");
    expect(result.watch_gate_passed).toBe(false);
    expect(result.watch_trust_score).toBe(0.5);
    expect(result.watch_gate_warnings.length).toBeGreaterThan(0);
    expect(result.package_evaluation?.watch?.recommended_command).toBe(
      "selftune rollback --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
    );
    expect(result.package_evaluation?.watch?.snapshot.regression_detected).toBe(true);
    expect(result.next_command).toBe(
      "selftune watch --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
    );
  });

  it("blocks publish when watch exits without structured output", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode("watch crashed before JSON output"),
          stderr: new TextEncoder().encode("boom"),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(false);
    expect(result.watch_started).toBe(false);
    expect(result.watch_result).toBeNull();
    expect(result.watch_gate_blocked).toBe(true);
    expect(result.watch_gate_passed).toBe(false);
    expect(result.watch_gate_bypassed).toBe(false);
    expect(result.watch_gate_warnings[0]).toContain("did not return structured JSON output");
    expect(result.next_command).toBe(
      "selftune watch --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
    );
  });

  it("allows publish when watch exits without structured output but ignoreWatchAlerts is true", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
        ignoreWatchAlerts: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode("watch crashed before JSON output"),
          stderr: new TextEncoder().encode("boom"),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(true);
    expect(result.watch_started).toBe(false);
    expect(result.watch_result).toBeNull();
    expect(result.watch_gate_blocked).toBe(false);
    expect(result.watch_gate_passed).toBe(true);
    expect(result.watch_gate_bypassed).toBe(true);
    expect(result.watch_gate_warnings[0]).toContain("did not return structured JSON output");
    expect(result.next_command).toBe(
      "selftune watch --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
    );
  });

  it("allows bypassing watch gate warnings explicitly", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
        ignoreWatchAlerts: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode(
            JSON.stringify({
              snapshot: {
                timestamp: "2026-04-14T12:30:00.000Z",
                skill_name: "research-assistant",
                window_sessions: 20,
                skill_checks: 6,
                pass_rate: 0.4,
                false_negative_rate: 0.6,
                by_invocation_type: {
                  explicit: { passed: 1, total: 2 },
                  implicit: { passed: 1, total: 2 },
                  contextual: { passed: 0, total: 1 },
                  negative: { passed: 0, total: 1 },
                },
                regression_detected: true,
                baseline_pass_rate: 0.8,
              },
              alert:
                'regression detected for "research-assistant": pass_rate=0.40 below baseline=0.80 minus threshold=0.10',
              rolledBack: false,
              recommendation:
                "Consider running: selftune rollback --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
              recommended_command:
                "selftune rollback --skill research-assistant --skill-path /tmp/research-assistant/SKILL.md",
              gradeAlert: null,
              gradeRegression: null,
            }),
          ),
          stderr: new Uint8Array(),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.watch_gate_passed).toBe(true);
    expect(result.watch_gate_bypassed).toBe(true);
    expect(result.watch_gate_blocked).toBe(false);
    expect(result.published).toBe(true);
    expect(result.watch_gate_warnings.length).toBeGreaterThan(0);
  });

  it("blocks publish when watch gate has active alerts and ignoreWatchAlerts is false", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
        ignoreWatchAlerts: false,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode(
            JSON.stringify({
              snapshot: {
                timestamp: "2026-04-14T12:30:00.000Z",
                skill_name: "research-assistant",
                window_sessions: 20,
                skill_checks: 6,
                pass_rate: 0.4,
                false_negative_rate: 0.6,
                by_invocation_type: {
                  explicit: { passed: 1, total: 2 },
                  implicit: { passed: 1, total: 2 },
                  contextual: { passed: 0, total: 1 },
                  negative: { passed: 0, total: 1 },
                },
                regression_detected: true,
                baseline_pass_rate: 0.8,
              },
              alert: 'regression detected for "research-assistant"',
              rolledBack: false,
              recommendation: "Consider running rollback",
              recommended_command: null,
              gradeAlert: null,
              gradeRegression: null,
            }),
          ),
          stderr: new Uint8Array(),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(false);
    expect(result.watch_gate_blocked).toBe(true);
    expect(result.watch_gate_passed).toBe(false);
    expect(result.next_command).toContain("selftune watch");
  });

  it("allows publish when watch gate has active alerts but ignoreWatchAlerts is true", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        watch: true,
        ignoreWatchAlerts: true,
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
        spawnSync: (() => ({
          stdout: new TextEncoder().encode(
            JSON.stringify({
              snapshot: {
                timestamp: "2026-04-14T12:30:00.000Z",
                skill_name: "research-assistant",
                window_sessions: 20,
                skill_checks: 6,
                pass_rate: 0.4,
                false_negative_rate: 0.6,
                by_invocation_type: {
                  explicit: { passed: 1, total: 2 },
                  implicit: { passed: 1, total: 2 },
                  contextual: { passed: 0, total: 1 },
                  negative: { passed: 0, total: 1 },
                },
                regression_detected: true,
                baseline_pass_rate: 0.8,
              },
              alert: 'regression detected for "research-assistant"',
              rolledBack: false,
              recommendation: "Consider running rollback",
              recommended_command: null,
              gradeAlert: null,
              gradeRegression: null,
            }),
          ),
          stderr: new Uint8Array(),
          exitCode: 1,
        })) as typeof Bun.spawnSync,
      },
    );

    expect(result.published).toBe(true);
    expect(result.watch_gate_blocked).toBe(false);
    expect(result.watch_gate_passed).toBe(true);
    expect(result.watch_gate_bypassed).toBe(true);
  });

  it("publishes when no watch data exists (no watch run)", async () => {
    const result = await runCreatePublish(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreateCheckResult: async () => readyToPublishCheck,
        runCreatePackageEvaluation: async () => passingPackageEvaluation,
      },
    );

    expect(result.published).toBe(true);
    expect(result.watch_gate_blocked).toBe(false);
    expect(result.watch_gate_passed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fixture factories for watch gate tests
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    timestamp: "2026-04-15T12:00:00Z",
    skill_name: "test-skill",
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
    ...overrides,
  };
}

function makeWatchResult(overrides: Partial<WatchResult> = {}): WatchResult {
  return {
    snapshot: makeSnapshot(),
    alert: null,
    rolledBack: false,
    recommendation: 'Skill "test-skill" is stable.',
    gradeAlert: null,
    gradeRegression: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Watch gate tests
// ---------------------------------------------------------------------------

describe("checkPublishWatchGate", () => {
  test("passes cleanly when recent watch shows no alerts", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [makeWatchResult()],
    });
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.trustScore).toBe(1.0);
    expect(result.bypassed).toBe(false);
  });

  test("warns when no watch data exists", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [],
    });
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("No watch data");
    expect(result.trustScore).toBeNull();
  });

  test("warns on active watch alerts", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [
        makeWatchResult({
          alert: "regression detected",
          snapshot: makeSnapshot({ regression_detected: true }),
        }),
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("Active watch alerts"))).toBe(true);
  });

  test("warns on low trust score", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [
        makeWatchResult({
          snapshot: makeSnapshot({ skill_checks: 2 }),
        }),
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.warnings.some((w) => w.includes("trust score"))).toBe(true);
  });

  test("warns on recent rollback", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [makeWatchResult({ rolledBack: true })],
    });
    expect(result.passed).toBe(false);
    expect(result.warnings.some((w) => w.includes("rolled back"))).toBe(true);
  });

  test("bypasses warnings with --ignore-watch-alerts", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [
        makeWatchResult({
          alert: "regression detected",
          snapshot: makeSnapshot({ regression_detected: true }),
        }),
      ],
      ignoreWatchAlerts: true,
    });
    expect(result.passed).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("bypassed is false when no warnings exist with ignore flag", () => {
    const result = checkPublishWatchGate({
      skillName: "test-skill",
      recentWatchResults: [makeWatchResult()],
      ignoreWatchAlerts: true,
    });
    expect(result.passed).toBe(true);
    expect(result.bypassed).toBe(false);
  });
});
