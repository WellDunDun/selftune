/**
 * CLI entrypoint for skill unit tests.
 *
 * Usage:
 *   selftune unit-test --skill <name> --tests <path> [--run-agent] [--generate]
 *
 *   --skill <name>    Skill name (required)
 *   --tests <path>    Path to unit test JSON file (default: ~/.selftune/unit-tests/<skill>.json)
 *   --run-agent       Actually run tests through an agent (otherwise dry-run with static checks)
 *   --generate        Generate tests from skill content using LLM (requires agent)
 *   --skill-path <p>  Path to skill file (used with --generate for content)
 *   --eval-set <p>    Path to eval set JSON (used with --generate for failure context)
 *   --model <m>       Model flag for LLM calls
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { EvalEntry } from "../types.js";
import { callLlm, detectAgent } from "../utils/llm-call.js";
import { generateUnitTests } from "./generate-unit-tests.js";
import { loadUnitTests, runUnitTestSuite } from "./unit-test.js";
import type { AgentRunner } from "./unit-test.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      tests: { type: "string" },
      "run-agent": { type: "boolean", default: false },
      generate: { type: "boolean", default: false },
      "skill-path": { type: "string" },
      "eval-set": { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });

  if (!values.skill) {
    console.error("[ERROR] --skill <name> is required.");
    process.exit(1);
  }

  const skillName = values.skill;
  const unitTestDir = join(SELFTUNE_CONFIG_DIR, "unit-tests");
  const defaultTestsPath = join(unitTestDir, `${skillName}.json`);
  const testsPath = values.tests ?? defaultTestsPath;

  // --generate: create tests from skill content
  if (values.generate) {
    const agent = detectAgent();
    if (!agent) {
      console.error("[ERROR] No agent CLI found (claude/codex/opencode). Cannot generate tests.");
      process.exit(1);
    }

    let skillContent = `Skill: ${skillName}`;
    if (values["skill-path"] && existsSync(values["skill-path"])) {
      skillContent = readFileSync(values["skill-path"], "utf-8");
    } else if (values["skill-path"]) {
      console.warn(`[WARN] Skill path not found: ${values["skill-path"]}. Using skill name only.`);
    }

    let evalFailures: EvalEntry[] = [];
    if (values["eval-set"] && existsSync(values["eval-set"])) {
      try {
        const raw = readFileSync(values["eval-set"], "utf-8");
        const entries: EvalEntry[] = JSON.parse(raw);
        evalFailures = entries.filter((e) => e.should_trigger);
      } catch {
        console.warn("[WARN] Failed to parse eval set. Proceeding without failure context.");
      }
    }

    const modelFlag = values.model;
    const llmCaller = (systemPrompt: string, userPrompt: string) =>
      callLlm(systemPrompt, userPrompt, agent, modelFlag);

    console.log(`Generating unit tests for skill '${skillName}'...`);
    const tests = await generateUnitTests(skillName, skillContent, evalFailures, llmCaller);

    if (tests.length === 0) {
      console.error("[ERROR] No tests generated. Check agent/LLM availability.");
      process.exit(1);
    }

    // Ensure output directory exists
    mkdirSync(unitTestDir, { recursive: true });
    writeFileSync(testsPath, JSON.stringify(tests, null, 2), "utf-8");
    console.log(`Generated ${tests.length} unit tests -> ${testsPath}`);
    return;
  }

  // Load and run tests
  const tests = loadUnitTests(testsPath);
  if (tests.length === 0) {
    console.error(`[ERROR] No tests found at ${testsPath}`);
    console.error("  Use --generate to create tests, or provide --tests <path>.");
    process.exit(1);
  }

  console.log(`Loaded ${tests.length} unit tests for skill '${skillName}'`);

  let agentRunner: AgentRunner;

  if (values["run-agent"]) {
    const agent = detectAgent();
    if (!agent) {
      console.error("[ERROR] No agent CLI found. Cannot run agent-based tests.");
      process.exit(1);
    }
    const modelFlag = values.model;
    agentRunner = async (query: string): Promise<string> => {
      return callLlm("You are a helpful assistant.", query, agent, modelFlag);
    };
  } else {
    // Dry-run: use query as transcript (only static assertions like contains work meaningfully)
    console.log("(dry-run mode — use --run-agent for full agent execution)\n");
    agentRunner = async (query: string): Promise<string> => query;
  }

  const suite = await runUnitTestSuite(tests, skillName, agentRunner);

  // Print results
  console.log(`\nResults for '${suite.skill_name}':`);
  console.log(`  Total: ${suite.total}  Passed: ${suite.passed}  Failed: ${suite.failed}`);
  console.log(`  Pass rate: ${(suite.pass_rate * 100).toFixed(1)}%`);

  if (suite.failed > 0) {
    console.log("\nFailed tests:");
    for (const r of suite.results.filter((r) => !r.passed)) {
      console.log(`  [FAIL] ${r.test_id} (${r.duration_ms}ms)`);
      if (r.error) {
        console.log(`         Error: ${r.error}`);
      }
      for (const a of r.assertion_results.filter((a) => !a.passed)) {
        console.log(
          `         - ${a.assertion.type}: expected "${a.assertion.value}", got "${a.actual}"`,
        );
      }
    }
  }

  console.log(`\n${JSON.stringify(suite, null, 2)}`);
  process.exit(suite.failed > 0 ? 1 : 0);
}
