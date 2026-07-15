import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCreateBaseline } from "../../packages/runtime/create/baseline.js";

describe("selftune create baseline", () => {
  const tempDirs: string[] = [];
  const originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir == null) {
      delete process.env.SELFTUNE_CONFIG_DIR;
    } else {
      process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarizes package replay lift from with-skill vs hidden-package runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-baseline-"));
    tempDirs.push(root);

    const skillDir = join(root, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: research-assistant
description: >
  Use when the user needs structured research help.
---

# Research Assistant
`,
      "utf-8",
    );

    const result = await runCreateBaseline(
      {
        skillPath: join(skillDir, "SKILL.md"),
        mode: "package",
        agent: "claude",
      },
      {
        runCreateReplay: async (options) => ({
          skill: "research-assistant",
          skill_path: "/tmp/research-assistant/SKILL.md",
          mode: "package",
          agent: "claude",
          proposal_id: options.includeTargetSkill === false ? "baseline" : "with-skill",
          total: 2,
          passed: options.includeTargetSkill === false ? 0 : 2,
          failed: options.includeTargetSkill === false ? 2 : 0,
          pass_rate: options.includeTargetSkill === false ? 0 : 1,
          fixture_id: "fixture-1",
          results: [
            {
              query: "research brief",
              should_trigger: true,
              triggered: options.includeTargetSkill !== false,
              passed: options.includeTargetSkill !== false,
              evidence: "mock",
              runtime_metrics: {
                input_tokens: options.includeTargetSkill === false ? 20 : 40,
                output_tokens: options.includeTargetSkill === false ? 5 : 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                total_cost_usd: options.includeTargetSkill === false ? 0.004 : 0.008,
                duration_ms: options.includeTargetSkill === false ? 400 : 800,
                num_turns: 1,
              },
            },
            {
              query: "write docs",
              should_trigger: false,
              triggered: false,
              passed: true,
              evidence: "mock",
              runtime_metrics: {
                input_tokens: options.includeTargetSkill === false ? 10 : 30,
                output_tokens: options.includeTargetSkill === false ? 5 : 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                total_cost_usd: options.includeTargetSkill === false ? 0.003 : 0.007,
                duration_ms: options.includeTargetSkill === false ? 300 : 600,
                num_turns: 1,
              },
            },
          ],
          runtime_metrics: {
            eval_runs: 2,
            usage_observations: 2,
            total_duration_ms: options.includeTargetSkill === false ? 700 : 1400,
            avg_duration_ms: options.includeTargetSkill === false ? 350 : 700,
            total_input_tokens: options.includeTargetSkill === false ? 30 : 70,
            total_output_tokens: 15,
            total_cache_creation_input_tokens: 0,
            total_cache_read_input_tokens: 0,
            total_cost_usd: options.includeTargetSkill === false ? 0.007 : 0.015,
            total_turns: 2,
          },
        }),
      },
    );

    expect(result.mode).toBe("package");
    expect(result.baseline_pass_rate).toBe(0);
    expect(result.with_skill_pass_rate).toBe(1);
    expect(result.lift).toBe(1);
    expect(result.adds_value).toBe(true);
    expect(result.per_entry[0]).toMatchObject({
      with_skill: false,
      evidence: "mock",
      latency_ms: 400,
      tokens: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        estimated_cost_usd: 0.004,
      },
    });
    expect(result.runtime_metrics).toEqual({
      with_skill: {
        eval_runs: 2,
        usage_observations: 2,
        total_duration_ms: 1400,
        avg_duration_ms: 700,
        total_input_tokens: 70,
        total_output_tokens: 15,
        total_cache_creation_input_tokens: 0,
        total_cache_read_input_tokens: 0,
        total_cost_usd: 0.015,
        total_turns: 2,
      },
      without_skill: {
        eval_runs: 2,
        usage_observations: 2,
        total_duration_ms: 700,
        avg_duration_ms: 350,
        total_input_tokens: 30,
        total_output_tokens: 15,
        total_cache_creation_input_tokens: 0,
        total_cache_read_input_tokens: 0,
        total_cost_usd: 0.007,
        total_turns: 2,
      },
    });
  });

  it("reuses a fresh canonical with-skill replay artifact before running the hidden-skill pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-baseline-cache-"));
    tempDirs.push(root);
    process.env.SELFTUNE_CONFIG_DIR = root;

    const skillDir = join(root, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      `---
name: research-assistant
description: >
  Use when the user needs structured research help.
---

# Research Assistant
`,
      "utf-8",
    );
    mkdirSync(join(root, "eval-sets"), { recursive: true });
    writeFileSync(
      join(root, "eval-sets", "research-assistant.json"),
      JSON.stringify(
        [
          { query: "research brief", should_trigger: true },
          { query: "write docs", should_trigger: false },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const replayCalls: Array<boolean> = [];
    const result = await runCreateBaseline(
      {
        skillPath,
        mode: "package",
        agent: "claude",
      },
      {
        computeCreatePackageFingerprint: () => "pkg-fingerprint-1",
        readCanonicalPackageEvaluationArtifact: () => ({
          summary: {
            skill_name: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            package_fingerprint: "pkg-fingerprint-1",
            evaluation_source: "fresh",
            status: "passed",
            evaluation_passed: true,
            next_command: null,
            replay: {
              mode: "package",
              validation_mode: "host_replay",
              agent: "claude",
              proposal_id: "cached-replay",
              fixture_id: "fixture-1",
              total: 2,
              passed: 2,
              failed: 0,
              pass_rate: 1,
            },
            baseline: {
              baseline_pass_rate: 0.5,
              with_skill_pass_rate: 1,
              lift: 0.5,
              adds_value: true,
            },
            evidence: {
              replay_failures: 0,
              baseline_wins: 1,
              baseline_regressions: 0,
              replay_failure_samples: [],
              baseline_win_samples: [],
              baseline_regression_samples: [],
            },
            efficiency: {
              with_skill: {
                eval_runs: 2,
                usage_observations: 2,
                total_duration_ms: 1400,
                avg_duration_ms: 700,
                total_input_tokens: 70,
                total_output_tokens: 15,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.015,
                total_turns: 2,
              },
              without_skill: {
                eval_runs: 2,
                usage_observations: 2,
                total_duration_ms: 700,
                avg_duration_ms: 350,
                total_input_tokens: 30,
                total_output_tokens: 15,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.007,
                total_turns: 2,
              },
            },
          },
          replay: {
            skill: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            agent: "claude",
            proposal_id: "cached-replay",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            fixture_id: "fixture-1",
            results: [
              {
                query: "research brief",
                should_trigger: true,
                triggered: true,
                passed: true,
                evidence: "cached",
                runtime_metrics: {
                  input_tokens: 40,
                  output_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: 0.008,
                  duration_ms: 800,
                  num_turns: 1,
                },
              },
              {
                query: "write docs",
                should_trigger: false,
                triggered: false,
                passed: true,
                evidence: "cached",
                runtime_metrics: {
                  input_tokens: 30,
                  output_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: 0.007,
                  duration_ms: 600,
                  num_turns: 1,
                },
              },
            ],
            runtime_metrics: {
              eval_runs: 2,
              usage_observations: 2,
              total_duration_ms: 1400,
              avg_duration_ms: 700,
              total_input_tokens: 70,
              total_output_tokens: 20,
              total_cache_creation_input_tokens: 0,
              total_cache_read_input_tokens: 0,
              total_cost_usd: 0.015,
              total_turns: 2,
            },
          },
          baseline: {
            skill_name: "research-assistant",
            mode: "package",
            baseline_pass_rate: 0.5,
            with_skill_pass_rate: 1,
            lift: 0.5,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-15T00:00:00.000Z",
          },
        }),
        runCreateReplay: async (options) => {
          replayCalls.push(options.includeTargetSkill === false);
          return {
            skill: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            agent: "claude",
            proposal_id: "baseline",
            total: 2,
            passed: 1,
            failed: 1,
            pass_rate: 0.5,
            fixture_id: "fixture-1",
            results: [
              {
                query: "research brief",
                should_trigger: true,
                triggered: false,
                passed: false,
                evidence: "hidden",
                runtime_metrics: {
                  input_tokens: 20,
                  output_tokens: 5,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: 0.004,
                  duration_ms: 400,
                  num_turns: 1,
                },
              },
              {
                query: "write docs",
                should_trigger: false,
                triggered: false,
                passed: true,
                evidence: "hidden",
                runtime_metrics: {
                  input_tokens: 10,
                  output_tokens: 5,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: 0.003,
                  duration_ms: 300,
                  num_turns: 1,
                },
              },
            ],
            runtime_metrics: {
              eval_runs: 2,
              usage_observations: 2,
              total_duration_ms: 700,
              avg_duration_ms: 350,
              total_input_tokens: 30,
              total_output_tokens: 10,
              total_cache_creation_input_tokens: 0,
              total_cache_read_input_tokens: 0,
              total_cost_usd: 0.007,
              total_turns: 2,
            },
          };
        },
      },
    );

    expect(replayCalls).toEqual([true]);
    expect(result.with_skill_pass_rate).toBe(1);
    expect(result.baseline_pass_rate).toBe(0.5);
  });

  it("does not reuse a cached with-skill replay when the canonical eval set changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-baseline-stale-evals-"));
    tempDirs.push(root);
    process.env.SELFTUNE_CONFIG_DIR = root;

    const skillDir = join(root, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      `---
name: research-assistant
description: >
  Use when the user needs structured research help.
---

# Research Assistant
`,
      "utf-8",
    );
    mkdirSync(join(root, "eval-sets"), { recursive: true });
    writeFileSync(
      join(root, "eval-sets", "research-assistant.json"),
      JSON.stringify([{ query: "new eval query", should_trigger: true }], null, 2),
      "utf-8",
    );

    const replayCalls: Array<boolean> = [];
    const result = await runCreateBaseline(
      {
        skillPath,
        mode: "package",
        agent: "claude",
      },
      {
        computeCreatePackageFingerprint: () => "pkg-fingerprint-1",
        readCanonicalPackageEvaluationArtifact: () => ({
          summary: {
            skill_name: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            package_fingerprint: "pkg-fingerprint-1",
            evaluation_source: "fresh",
            status: "passed",
            evaluation_passed: true,
            next_command: null,
            replay: {
              mode: "package",
              validation_mode: "host_replay",
              agent: "claude",
              proposal_id: "cached-replay",
              fixture_id: "fixture-1",
              total: 1,
              passed: 1,
              failed: 0,
              pass_rate: 1,
            },
            baseline: {
              baseline_pass_rate: 0.5,
              with_skill_pass_rate: 1,
              lift: 0.5,
              adds_value: true,
            },
            evidence: {
              replay_failures: 0,
              baseline_wins: 1,
              baseline_regressions: 0,
              replay_failure_samples: [],
              baseline_win_samples: [],
              baseline_regression_samples: [],
            },
            efficiency: {
              with_skill: {
                eval_runs: 1,
                usage_observations: 1,
                total_duration_ms: 800,
                avg_duration_ms: 800,
                total_input_tokens: 40,
                total_output_tokens: 10,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.008,
                total_turns: 1,
              },
              without_skill: {
                eval_runs: 1,
                usage_observations: 1,
                total_duration_ms: 300,
                avg_duration_ms: 300,
                total_input_tokens: 10,
                total_output_tokens: 5,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.003,
                total_turns: 1,
              },
            },
          },
          replay: {
            skill: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            agent: "claude",
            proposal_id: "cached-replay",
            total: 1,
            passed: 1,
            failed: 0,
            pass_rate: 1,
            fixture_id: "fixture-1",
            results: [
              {
                query: "old eval query",
                should_trigger: true,
                triggered: true,
                passed: true,
                evidence: "cached",
                runtime_metrics: {
                  input_tokens: 40,
                  output_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: 0.008,
                  duration_ms: 800,
                  num_turns: 1,
                },
              },
            ],
            runtime_metrics: {
              eval_runs: 1,
              usage_observations: 1,
              total_duration_ms: 800,
              avg_duration_ms: 800,
              total_input_tokens: 40,
              total_output_tokens: 10,
              total_cache_creation_input_tokens: 0,
              total_cache_read_input_tokens: 0,
              total_cost_usd: 0.008,
              total_turns: 1,
            },
          },
          baseline: {
            skill_name: "research-assistant",
            mode: "package",
            baseline_pass_rate: 0.5,
            with_skill_pass_rate: 1,
            lift: 0.5,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-15T00:00:00.000Z",
          },
        }),
        runCreateReplay: async (options) => {
          replayCalls.push(options.includeTargetSkill === false);
          const withSkill = options.includeTargetSkill !== false;
          return {
            skill: "research-assistant",
            skill_path: skillPath,
            mode: "package",
            agent: "claude",
            proposal_id: withSkill ? "with-skill" : "baseline",
            total: 1,
            passed: withSkill ? 1 : 0,
            failed: withSkill ? 0 : 1,
            pass_rate: withSkill ? 1 : 0,
            fixture_id: "fixture-1",
            results: [
              {
                query: "new eval query",
                should_trigger: true,
                triggered: withSkill,
                passed: withSkill,
                evidence: withSkill ? "fresh with-skill" : "hidden",
                runtime_metrics: {
                  input_tokens: withSkill ? 40 : 10,
                  output_tokens: withSkill ? 10 : 5,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: withSkill ? 0.008 : 0.003,
                  duration_ms: withSkill ? 800 : 300,
                  num_turns: 1,
                },
              },
            ],
            runtime_metrics: {
              eval_runs: 1,
              usage_observations: 1,
              total_duration_ms: withSkill ? 800 : 300,
              avg_duration_ms: withSkill ? 800 : 300,
              total_input_tokens: withSkill ? 40 : 10,
              total_output_tokens: withSkill ? 10 : 5,
              total_cache_creation_input_tokens: 0,
              total_cache_read_input_tokens: 0,
              total_cost_usd: withSkill ? 0.008 : 0.003,
              total_turns: 1,
            },
          };
        },
      },
    );

    expect(replayCalls).toEqual([false, true]);
    expect(
      result.per_entry.some((entry) => entry.query === "new eval query" && entry.with_skill),
    ).toBe(true);
  });

  it("emits baseline step progress for both replay phases", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-baseline-progress-"));
    tempDirs.push(root);

    const skillDir = join(root, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      `---
name: research-assistant
description: >
  Use when the user needs structured research help.
---

# Research Assistant
`,
      "utf-8",
    );

    const progressEvents: Array<Record<string, unknown>> = [];
    await runCreateBaseline(
      {
        skillPath,
        mode: "package",
        agent: "claude",
      },
      {
        emitDashboardStepProgress: (progress) => {
          progressEvents.push({ ...progress });
        },
        runCreateReplay: async (options) => ({
          skill: "research-assistant",
          skill_path: skillPath,
          mode: "package",
          agent: "claude",
          proposal_id: options.includeTargetSkill === false ? "baseline" : "with-skill",
          total: 1,
          passed: options.includeTargetSkill === false ? 0 : 1,
          failed: options.includeTargetSkill === false ? 1 : 0,
          pass_rate: options.includeTargetSkill === false ? 0 : 1,
          fixture_id: "fixture-1",
          results: [
            {
              query: "research brief",
              should_trigger: true,
              triggered: options.includeTargetSkill !== false,
              passed: options.includeTargetSkill !== false,
              evidence: "mock",
              runtime_metrics: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                total_cost_usd: 0.002,
                duration_ms: 200,
                num_turns: 1,
              },
            },
          ],
          runtime_metrics: {
            eval_runs: 1,
            usage_observations: 1,
            total_duration_ms: 200,
            avg_duration_ms: 200,
            total_input_tokens: 10,
            total_output_tokens: 5,
            total_cache_creation_input_tokens: 0,
            total_cache_read_input_tokens: 0,
            total_cost_usd: 0.002,
            total_turns: 1,
          },
        }),
      },
    );

    expect(progressEvents).toEqual([
      expect.objectContaining({
        current: 1,
        total: 2,
        status: "started",
        phase: "with_skill_replay",
        label: "Replay with draft package enabled",
      }),
      expect.objectContaining({
        current: 1,
        total: 2,
        status: "finished",
        phase: "with_skill_replay",
        passed: true,
      }),
      expect.objectContaining({
        current: 2,
        total: 2,
        status: "started",
        phase: "without_skill_replay",
        label: "Replay with the target skill hidden",
      }),
      expect.objectContaining({
        current: 2,
        total: 2,
        status: "finished",
        phase: "without_skill_replay",
        passed: true,
      }),
    ]);
  });
});
