#!/usr/bin/env bun
/**
 * Layer 1 Local Sandbox Orchestrator for selftune.
 *
 * Sets up an isolated sandbox with HOME redirected to /tmp,
 * copies fixture data, runs every CLI command and hook,
 * records results, and prints a summary table.
 *
 * Usage:
 *   bun run tests/sandbox/run-sandbox.ts [--keep]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Resolve project root and paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "cli", "selftune", "index.ts");
const FIXTURES_DIR = join(PROJECT_ROOT, "tests", "sandbox", "fixtures");
const RESULTS_DIR = join(PROJECT_ROOT, "tests", "sandbox", "results");

const keepSandbox = process.argv.includes("--keep");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sandbox setup
// ---------------------------------------------------------------------------

const timestamp = Date.now();
const SANDBOX_ROOT = `/tmp/selftune-sandbox-${timestamp}`;
const SANDBOX_HOME = join(SANDBOX_ROOT, "home");
const SANDBOX_CLAUDE_DIR = join(SANDBOX_HOME, ".claude");
const SANDBOX_PROJECTS_DIR = join(SANDBOX_CLAUDE_DIR, "projects", "default");
const SANDBOX_SELFTUNE_DIR = join(SANDBOX_HOME, ".selftune");

function setupSandbox(): void {
  // Create directory structure
  mkdirSync(SANDBOX_SELFTUNE_DIR, { recursive: true });
  mkdirSync(SANDBOX_PROJECTS_DIR, { recursive: true });

  // Copy JSONL log fixtures into ~/.claude/
  const logFiles = [
    "all_queries_log.jsonl",
    "skill_usage_log.jsonl",
    "session_telemetry_log.jsonl",
    "evolution_audit_log.jsonl",
  ];
  for (const file of logFiles) {
    const src = join(FIXTURES_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, join(SANDBOX_CLAUDE_DIR, file));
    }
  }

  // Copy transcripts into ~/.claude/projects/default/ as individual session files
  const transcriptsDir = join(FIXTURES_DIR, "transcripts");
  if (existsSync(transcriptsDir)) {
    for (const file of readdirSync(transcriptsDir)) {
      if (file.endsWith(".jsonl")) {
        copyFileSync(join(transcriptsDir, file), join(SANDBOX_PROJECTS_DIR, file));
      }
    }
  }

  // Copy selftune config
  copyFileSync(
    join(FIXTURES_DIR, "selftune-config.json"),
    join(SANDBOX_SELFTUNE_DIR, "config.json"),
  );

  // Copy Claude Code settings
  copyFileSync(
    join(FIXTURES_DIR, "claude-settings.json"),
    join(SANDBOX_CLAUDE_DIR, "settings.json"),
  );
}

// Need readdirSync for transcripts
import { readdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

const sandboxEnv = { ...process.env, HOME: SANDBOX_HOME, NO_COLOR: "1" };

interface RawTestResult extends TestResult {
  fullStdout: string;
}

async function runCliCommand(name: string, args: string[]): Promise<RawTestResult> {
  const command = `bun run ${CLI_PATH} ${args.join(" ")}`;
  const start = performance.now();

  try {
    const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
      env: sandboxEnv,
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    return {
      name,
      command,
      exitCode,
      passed: exitCode === 0,
      durationMs,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
      fullStdout: stdout,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name,
      command,
      exitCode: 1,
      passed: false,
      durationMs,
      stdout: "",
      stderr: "",
      fullStdout: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

async function runHook(name: string, hookPath: string, payload: unknown): Promise<RawTestResult> {
  const command = `bun run ${hookPath} < payload`;
  const start = performance.now();

  try {
    const proc = Bun.spawn(["bun", "run", hookPath], {
      env: sandboxEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    return {
      name,
      command,
      exitCode,
      passed: exitCode === 0,
      durationMs,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
      fullStdout: stdout,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name,
      command,
      exitCode: 1,
      passed: false,
      durationMs,
      stdout: "",
      stderr: "",
      fullStdout: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return 0;
  return content.split("\n").length;
}

function fileHasNewContent(filePath: string, minLines: number): boolean {
  return countLines(filePath) >= minLines;
}

// ---------------------------------------------------------------------------
// Main test sequence
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nSelftune Layer 1 Sandbox Orchestrator`);
  console.log(`${"=".repeat(40)}`);
  console.log(`Sandbox: ${SANDBOX_ROOT}`);
  console.log(`Project: ${PROJECT_ROOT}\n`);

  // Setup
  setupSandbox();
  console.log("Sandbox directories created and fixtures copied.\n");

  const results: RawTestResult[] = [];

  try {
    // -----------------------------------------------------------------------
    // CLI command tests
    // -----------------------------------------------------------------------

    // a. doctor
    const doctorResult = await runCliCommand("doctor", ["doctor"]);
    // Doctor exits 1 when healthy=false (hooks missing in sandbox) — that's expected.
    // We accept the result as passed if stdout contains valid doctor JSON output.
    if (!doctorResult.passed) {
      try {
        const parsed = JSON.parse(doctorResult.fullStdout);
        if (parsed.command === "doctor" && Array.isArray(parsed.checks)) {
          doctorResult.passed = true;
        }
      } catch {
        // Not valid JSON — leave as failed
      }
    }
    results.push(doctorResult);

    // b. evals --skill find-skills
    const evalsOutput = join(SANDBOX_HOME, "find-skills_eval.json");
    const evalsFsResult = await runCliCommand("evals (find-skills)", [
      "evals",
      "--skill",
      "find-skills",
      "--output",
      evalsOutput,
    ]);
    results.push(evalsFsResult);

    // c. evals --skill frontend-design
    const evalsFeOutput = join(SANDBOX_HOME, "frontend-design_eval.json");
    const evalsFeResult = await runCliCommand("evals (frontend-design)", [
      "evals",
      "--skill",
      "frontend-design",
      "--output",
      evalsFeOutput,
    ]);
    results.push(evalsFeResult);

    // d. status
    const statusResult = await runCliCommand("status", ["status"]);
    results.push(statusResult);

    // e. last
    const lastResult = await runCliCommand("last", ["last"]);
    results.push(lastResult);

    // f. dashboard --export
    const dashboardResult = await runCliCommand("dashboard --export", ["dashboard", "--export"]);
    // Dashboard --export writes HTML to stdout; verify it contains HTML
    if (
      dashboardResult.passed &&
      !dashboardResult.fullStdout.includes("<!DOCTYPE html") &&
      !dashboardResult.fullStdout.includes("<html")
    ) {
      dashboardResult.passed = false;
      dashboardResult.error = "Expected HTML output from dashboard --export";
    }
    results.push(dashboardResult);

    // g. contribute --skill find-skills --preview
    const contributeResult = await runCliCommand("contribute --preview", [
      "contribute",
      "--skill",
      "find-skills",
      "--preview",
    ]);
    // contribute --preview writes JSON to stdout (may exceed 2000 char truncation limit)
    if (contributeResult.passed) {
      try {
        const bundle = JSON.parse(contributeResult.fullStdout);
        if (!bundle.schema_version || !bundle.positive_queries) {
          contributeResult.passed = false;
          contributeResult.error = "JSON missing expected bundle fields";
        }
      } catch {
        contributeResult.passed = false;
        contributeResult.error = "Expected valid JSON from contribute --preview";
      }
    }
    results.push(contributeResult);

    // -----------------------------------------------------------------------
    // Hook tests
    // -----------------------------------------------------------------------

    const hooksDir = join(PROJECT_ROOT, "cli", "selftune", "hooks");

    // Read hook payloads
    const promptPayload = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "hook-payloads", "prompt-submit.json"), "utf-8"),
    );
    const toolUsePayload = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "hook-payloads", "post-tool-use.json"), "utf-8"),
    );
    const sessionStopPayload = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "hook-payloads", "session-stop.json"), "utf-8"),
    );

    // a. prompt-log hook
    const queryLogPath = join(SANDBOX_CLAUDE_DIR, "all_queries_log.jsonl");
    const queryLinesBefore = countLines(queryLogPath);

    const promptHookResult = await runHook(
      "hook: prompt-log",
      join(hooksDir, "prompt-log.ts"),
      promptPayload,
    );
    // Verify record was appended
    const queryLinesAfter = countLines(queryLogPath);
    if (promptHookResult.passed && queryLinesAfter <= queryLinesBefore) {
      promptHookResult.passed = false;
      promptHookResult.error = `Expected new record in all_queries_log.jsonl (before: ${queryLinesBefore}, after: ${queryLinesAfter})`;
    }
    results.push(promptHookResult);

    // b. skill-eval hook
    const skillLogPath = join(SANDBOX_CLAUDE_DIR, "skill_usage_log.jsonl");
    const skillLinesBefore = countLines(skillLogPath);

    const skillHookResult = await runHook(
      "hook: skill-eval",
      join(hooksDir, "skill-eval.ts"),
      toolUsePayload,
    );
    const skillLinesAfter = countLines(skillLogPath);
    if (skillHookResult.passed && skillLinesAfter <= skillLinesBefore) {
      skillHookResult.passed = false;
      skillHookResult.error = `Expected new record in skill_usage_log.jsonl (before: ${skillLinesBefore}, after: ${skillLinesAfter})`;
    }
    results.push(skillHookResult);

    // c. session-stop hook
    const telemetryLogPath = join(SANDBOX_CLAUDE_DIR, "session_telemetry_log.jsonl");
    const telemetryLinesBefore = countLines(telemetryLogPath);

    const sessionHookResult = await runHook(
      "hook: session-stop",
      join(hooksDir, "session-stop.ts"),
      sessionStopPayload,
    );
    const telemetryLinesAfter = countLines(telemetryLogPath);
    if (sessionHookResult.passed && telemetryLinesAfter <= telemetryLinesBefore) {
      sessionHookResult.passed = false;
      sessionHookResult.error = `Expected new record in session_telemetry_log.jsonl (before: ${telemetryLinesBefore}, after: ${telemetryLinesAfter})`;
    }
    results.push(sessionHookResult);

    // -----------------------------------------------------------------------
    // Record results
    // -----------------------------------------------------------------------

    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const resultsPath = join(RESULTS_DIR, `sandbox-run-${timestamp}.json`);
    // Strip fullStdout from saved results (internal-only field)
    const savedResults: TestResult[] = results.map((r) => ({
      name: r.name,
      command: r.command,
      exitCode: r.exitCode,
      passed: r.passed,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.error ? { error: r.error } : {}),
    }));
    writeFileSync(resultsPath, JSON.stringify(savedResults, null, 2), "utf-8");

    // -----------------------------------------------------------------------
    // Print summary table
    // -----------------------------------------------------------------------

    const nameWidth = Math.max(25, ...results.map((r) => r.name.length + 2));
    const divider = `+${"-".repeat(nameWidth + 2)}+--------+----------+`;

    console.log("");
    console.log(divider);
    console.log(`| ${"Test".padEnd(nameWidth)} | Status | Duration |`);
    console.log(divider);

    for (const r of results) {
      const status = r.passed ? "PASS" : "FAIL";
      const duration = `${r.durationMs}ms`;
      console.log(
        `| ${r.name.padEnd(nameWidth)} | ${status.padEnd(6)} | ${duration.padStart(8)} |`,
      );
    }

    console.log(divider);

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    console.log(`\nResults: ${passed}/${total} passed`);
    console.log(`Results written to: ${resultsPath}`);

    // Print failures in detail
    const failures = results.filter((r) => !r.passed);
    if (failures.length > 0) {
      console.log("\n--- Failures ---");
      for (const f of failures) {
        console.log(`\n[${f.name}] exit=${f.exitCode}`);
        if (f.error) console.log(`  Error: ${f.error}`);
        if (f.stderr) console.log(`  Stderr: ${f.stderr.slice(0, 500)}`);
        if (f.stdout) console.log(`  Stdout: ${f.stdout.slice(0, 500)}`);
      }
    }

    process.exit(passed === total ? 0 : 1);
  } finally {
    // -----------------------------------------------------------------------
    // Cleanup always runs, even if tests throw
    // -----------------------------------------------------------------------

    if (keepSandbox) {
      console.log(`\nSandbox kept at: ${SANDBOX_ROOT}`);
    } else {
      rmSync(SANDBOX_ROOT, { recursive: true, force: true });
      console.log(`\nSandbox cleaned up.`);
    }
  }
}

main().catch((err) => {
  console.error("Sandbox orchestrator failed:", err);
  process.exit(1);
});
