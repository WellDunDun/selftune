#!/usr/bin/env bun
/**
 * run-with-llm.ts
 *
 * Layer 2 LLM integration test orchestrator for selftune.
 * Runs inside a devcontainer with `claude -p` for LLM calls.
 * Uses existing Claude subscription — no API key required.
 *
 * Tests:
 *   1. grade  — Grade a session using claude -p
 *   2. evolve — Generate an evolution proposal (dry-run)
 *   3. watch  — Run post-deploy monitoring snapshot (no LLM)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  duration_ms: number;
  output: unknown;
  error: string | null;
}

interface RunReport {
  timestamp: string;
  layer: "layer2-devcontainer";
  total: number;
  passed: number;
  failed: number;
  tests: TestResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const CLI_PATH = join(PROJECT_ROOT, "cli/selftune/index.ts");

async function runTest(name: string, fn: () => Promise<unknown>): Promise<TestResult> {
  const start = Date.now();
  try {
    const output = await fn();
    return { name, passed: true, duration_ms: Date.now() - start, output, error: null };
  } catch (err) {
    return {
      name,
      passed: false,
      duration_ms: Date.now() - start,
      output: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run a selftune CLI command and return stdout. */
async function runSelftune(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homedir() },
  });
  // Consume streams concurrently with process exit to prevent deadlock
  // when output exceeds the pipe buffer size.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Call claude -p with a prompt and return the response text. */
async function _claudePrompt(prompt: string, systemPrompt?: string): Promise<string> {
  const args = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const timeout = setTimeout(() => proc.kill(), 120_000);
  // Consume streams concurrently with process exit to prevent deadlock
  // when output exceeds the pipe buffer size.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(`claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  // Parse JSON output, extract result text
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? stdout;
  } catch {
    return stdout;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Grade a session using claude -p
// ---------------------------------------------------------------------------

async function testGrade(): Promise<unknown> {
  const skillName = "find-skills";
  const sessionId = "session-001";
  const expectations = ["Skill was triggered", "User query was about finding skills"];

  // Use selftune grade command which internally calls claude -p via callViaAgent
  // parseArgs with multiple:true requires --expectations per value
  const expectationArgs = expectations.flatMap((e) => ["--expectations", e]);
  const {
    exitCode,
    stdout: _stdout,
    stderr,
  } = await runSelftune([
    "grade",
    "--skill",
    skillName,
    "--session-id",
    sessionId,
    ...expectationArgs,
    "--output",
    join(homedir(), "grading-result.json"),
  ]);

  if (exitCode !== 0) {
    throw new Error(`grade exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  // Read and validate the grading result
  const resultPath = join(homedir(), "grading-result.json");
  if (!existsSync(resultPath)) {
    throw new Error("grading-result.json not created");
  }
  const raw = readFileSync(resultPath, "utf-8");
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`grading-result.json is not valid JSON: ${raw.slice(0, 300)}`);
  }

  const summary = result.summary as
    | { passed: number; total: number; pass_rate: number }
    | undefined;
  if (!summary || typeof summary.pass_rate !== "number") {
    throw new Error("Grading result missing summary.pass_rate");
  }

  console.log(
    `  [grade] ${summary.passed}/${summary.total} (${Math.round(summary.pass_rate * 100)}%)`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Test 2: Evolve a skill (dry-run) using claude -p
// ---------------------------------------------------------------------------

async function testEvolve(): Promise<unknown> {
  const skillPath = join(homedir(), ".claude", "skills", "frontend-design", "SKILL.md");

  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found at ${skillPath}`);
  }

  const { exitCode, stdout, stderr } = await runSelftune([
    "evolve",
    "--skill",
    "frontend-design",
    "--skill-path",
    skillPath,
    "--dry-run",
    "--confidence",
    "0.3",
    "--max-iterations",
    "1",
  ]);

  // evolve --dry-run exits 1 (deployed=false) which is expected.
  // Validate that stdout contains valid JSON result, not a crash.
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(
      `evolve exited ${exitCode}, stdout not valid JSON: ${stderr.slice(0, 300)} | ${stdout.slice(0, 300)}`,
    );
  }

  // Must have a reason or proposal — either path is valid for dry-run
  if (!result.reason && !result.proposal) {
    throw new Error("evolve result missing both 'reason' and 'proposal'");
  }

  console.log(`  [evolve] exit=${exitCode} reason=${result.reason ?? "proposal generated"}`);
  return result;
}

// ---------------------------------------------------------------------------
// Test 3: Watch (monitoring snapshot) — no LLM needed
// ---------------------------------------------------------------------------

async function testWatch(): Promise<unknown> {
  const skillPath = join(homedir(), ".claude", "skills", "find-skills", "SKILL.md");

  const {
    exitCode,
    stdout,
    stderr: _stderr,
  } = await runSelftune([
    "watch",
    "--skill",
    "find-skills",
    "--skill-path",
    skillPath,
    "--window",
    "20",
    "--threshold",
    "0.1",
  ]);

  // Watch exits 1 on regression detection (expected for test data)
  console.log(`  [watch] exit=${exitCode}`);
  console.log(`  [watch] ${stdout.slice(0, 200)}`);
  return { stdout: stdout.slice(0, 1000), exitCode };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== selftune Layer 2: Devcontainer LLM Tests ===\n");
  console.log(`HOME: ${homedir()}`);
  console.log(`CLI: ${CLI_PATH}\n`);

  // Verify claude is available
  const claudeCheck = Bun.which("claude");
  if (!claudeCheck) {
    console.error("[FATAL] claude CLI not found. Run inside devcontainer or install claude.");
    process.exit(1);
  }
  console.log(`claude CLI: ${claudeCheck}`);

  // Check for auth — claude login session (preferred) or ANTHROPIC_API_KEY
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const claudeAuthDir = join(homedir(), ".claude");
  const hasClaudeLogin =
    existsSync(claudeAuthDir) && existsSync(join(claudeAuthDir, ".credentials.json"));
  console.log(
    `Auth: ${hasClaudeLogin ? "claude login" : hasApiKey ? "ANTHROPIC_API_KEY" : "none"}`,
  );
  if (!hasApiKey && !hasClaudeLogin) {
    console.log(
      "[INFO] No auth detected. Set up auth via one of:\n" +
        "  1. Run 'claude login' inside the container (make sandbox-shell)  [recommended]\n" +
        "  2. Use 'make sandbox-shell-empty' or 'make sandbox-shell-empty-workspace' for a blank shell\n" +
        "  3. Set ANTHROPIC_API_KEY in .env.local\n",
    );
  } else {
    console.log("");
  }

  const tests: TestResult[] = [];

  console.log("[1/3] Testing grade command...");
  tests.push(await runTest("grade-via-claude-p", testGrade));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[2/3] Testing evolve command (dry-run)...");
  tests.push(await runTest("evolve-via-claude-p", testEvolve));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[3/3] Testing watch command...");
  tests.push(await runTest("watch-monitoring", testWatch));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  const passed = tests.filter((t) => t.passed).length;
  const failed = tests.filter((t) => !t.passed).length;

  const report: RunReport = {
    timestamp: new Date().toISOString(),
    layer: "layer2-devcontainer",
    total: tests.length,
    passed,
    failed,
    tests,
  };

  const resultsDir = join(PROJECT_ROOT, "tests", "sandbox", "results");
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `llm-run-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("=== Summary ===");
  console.log(`Total: ${report.total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Results: ${outputPath}`);

  for (const t of tests) {
    if (!t.passed) {
      console.error(`  FAIL: ${t.name} — ${t.error}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err}`);
  process.exit(1);
});
