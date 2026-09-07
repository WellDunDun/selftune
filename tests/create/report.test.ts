import { summarizeReplayRuntimeMetrics } from "../../packages/runtime/create/replay.js";
import { describe, expect, it } from "bun:test";

import { runCreateReport } from "../../packages/runtime/create/report.js";

describe("selftune create report", () => {
  it("runs the shared package evaluator and returns the package report payload", async () => {
    const receivedSkillPaths: string[] = [];

    const result = await runCreateReport(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        agent: "claude",
        evalSetPath: "/tmp/evals/research-assistant.json",
      },
      {
        runCreateReplay: async (options) => {
          receivedSkillPaths.push(options.skillPath);
          return {
            skill: "research-assistant",
            skill_path: "/tmp/research-assistant/SKILL.md",
            mode: "package",
            agent: "claude",
            proposal_id: "create-replay-1",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            fixture_id: "fixture-1",
            results: [],
            runtime_metrics: summarizeReplayRuntimeMetrics([]),
          };
        },
        runCreateBaseline: async () => ({
          skill_name: "research-assistant",
          mode: "package",
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 1,
          lift: 0.5,
          adds_value: true,
          per_entry: [],
          measured_at: "2026-04-14T12:00:00.000Z",
        }),
      },
    );

    expect(receivedSkillPaths.at(-1)).toBe("/tmp/research-assistant/SKILL.md");
    expect(result.summary.evaluation_passed).toBe(true);
    expect(result.summary.replay.agent).toBe("claude");
    expect(result.summary.baseline.lift).toBe(0.5);
  });
});
