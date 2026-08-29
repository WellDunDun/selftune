import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOutputEvalFile,
  runOutputQualityEvaluation,
} from "../../packages/runtime/eval/output-quality.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-output-eval-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createSkill(): string {
  const skillDir = join(root, "example");
  mkdirSync(join(skillDir, "evals", "files"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: example\ndescription: Test skill.\n---\n\n# Example\n",
  );
  writeFileSync(join(skillDir, "evals", "files", "input.txt"), "fixture");
  writeFileSync(
    join(skillDir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "example",
      evals: [
        {
          id: 1,
          prompt: "Process the fixture",
          expected_output: "A result containing SUCCESS",
          files: ["evals/files/input.txt"],
          assertions: ["The output reports success"],
          selftune_assertions: [{ type: "contains", value: "SUCCESS" }],
        },
      ],
    }),
  );
  return skillDir;
}

describe("Agent Skills output-quality evaluation", () => {
  test("loads the standard evals/evals.json contract", () => {
    const skillDir = createSkill();
    const contract = loadOutputEvalFile(join(skillDir, "evals", "evals.json"));
    expect(contract.skill_name).toBe("example");
    expect(contract.evals[0]?.expected_output).toContain("SUCCESS");
  });

  test("writes isolated paired artifacts, timings, grading, feedback, and benchmark deltas", async () => {
    const skillDir = createSkill();
    let execution = 0;
    const workingDirectories: string[] = [];
    const result = await runOutputQualityEvaluation(
      { skillPath: skillDir, agent: "test-agent" },
      {
        execute: async ({ system, workingDirectory }) => {
          execution += 1;
          workingDirectories.push(workingDirectory);
          return {
            output: system.includes("Follow this Agent Skill") ? "SUCCESS" : "baseline output",
            totalTokens: system.includes("Follow this Agent Skill") ? 10 : 6,
          };
        },
        grade: async ({ output, assertions }) =>
          assertions.map((text) => ({
            text,
            passed: output.includes("SUCCESS"),
            evidence: output,
          })),
        compare: async () => ({ winner: "A", evidence: "Output A completed the task." }),
      },
    );

    expect(execution).toBe(2);
    expect(result.iteration_dir).toBe(join(root, "example-workspace", "iteration-1"));
    const caseDir = join(result.iteration_dir, "eval-1");
    expect(workingDirectories).toEqual([
      join(caseDir, "with_skill"),
      join(caseDir, "without_skill"),
    ]);
    for (const arm of ["with_skill", "without_skill"]) {
      expect(existsSync(join(caseDir, arm, "outputs", "response.md"))).toBe(true);
      expect(existsSync(join(caseDir, arm, "timing.json"))).toBe(true);
      expect(existsSync(join(caseDir, arm, "grading.json"))).toBe(true);
      expect(readFileSync(join(caseDir, arm, "inputs", "input.txt"), "utf-8")).toBe("fixture");
    }
    expect(result.benchmark.run_summary.delta.pass_rate).toBe(1);
    expect(result.benchmark.run_summary.delta.tokens).toBe(4);
    expect(result.benchmark.cases[0]?.blind_comparison.winner).toBe("with_skill");
    expect(existsSync(join(result.iteration_dir, "feedback.json"))).toBe(true);

    const second = await runOutputQualityEvaluation(
      { skillPath: skillDir, agent: "test-agent" },
      {
        execute: async () => ({ output: "SUCCESS", totalTokens: 1 }),
        grade: async ({ assertions }) =>
          assertions.map((text) => ({ text, passed: true, evidence: "SUCCESS" })),
        compare: async () => ({ winner: "tie", evidence: "Equivalent outputs." }),
      },
    );
    expect(second.iteration_dir).toBe(join(root, "example-workspace", "iteration-2"));
  });
});
