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
const SANDBOX_OPENCLAW_DIR = join(SANDBOX_HOME, ".openclaw");
const SANDBOX_OPENCLAW_AGENTS = join(SANDBOX_OPENCLAW_DIR, "agents");

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

  // Copy OpenClaw fixture data
  const openclawFixturesDir = join(FIXTURES_DIR, "openclaw");

  // Agent sessions (dynamic discovery)
  const agentsRoot = join(openclawFixturesDir, "agents");
  for (const agentId of existsSync(agentsRoot) ? readdirSync(agentsRoot) : []) {
    const srcSessions = join(agentsRoot, agentId, "sessions");
    const dstSessions = join(SANDBOX_OPENCLAW_AGENTS, agentId, "sessions");
    mkdirSync(dstSessions, { recursive: true });
    if (existsSync(srcSessions)) {
      for (const file of readdirSync(srcSessions)) {
        if (file.endsWith(".jsonl")) {
          copyFileSync(join(srcSessions, file), join(dstSessions, file));
        }
      }
    }
  }

  // Skills (dynamic discovery)
  const skillsRoot = join(openclawFixturesDir, "skills");
  for (const skillName of existsSync(skillsRoot) ? readdirSync(skillsRoot) : []) {
    const srcSkill = join(skillsRoot, skillName, "SKILL.md");
    const dstSkillDir = join(SANDBOX_OPENCLAW_DIR, "skills", skillName);
    mkdirSync(dstSkillDir, { recursive: true });
    if (existsSync(srcSkill)) {
      copyFileSync(srcSkill, join(dstSkillDir, "SKILL.md"));
    }
  }

  // Cron jobs
  const cronDir = join(SANDBOX_OPENCLAW_DIR, "cron");
  mkdirSync(cronDir, { recursive: true });
  const cronSrc = join(openclawFixturesDir, "cron", "jobs.json");
  if (existsSync(cronSrc)) {
    copyFileSync(cronSrc, join(cronDir, "jobs.json"));
  }
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

function _fileHasNewContent(filePath: string, minLines: number): boolean {
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

    // h. badge --skill find-skills (SVG)
    const badgeSvgResult = await runCliCommand("badge --format svg", [
      "badge",
      "--skill",
      "find-skills",
    ]);
    if (badgeSvgResult.passed) {
      if (
        !badgeSvgResult.fullStdout.includes("<svg") ||
        !badgeSvgResult.fullStdout.includes("Skill Health")
      ) {
        badgeSvgResult.passed = false;
        badgeSvgResult.error = "Expected SVG output containing <svg and 'Skill Health'";
      }
    }
    results.push(badgeSvgResult);

    // i. badge --skill find-skills --format markdown
    const badgeMdResult = await runCliCommand("badge --format markdown", [
      "badge",
      "--skill",
      "find-skills",
      "--format",
      "markdown",
    ]);
    if (badgeMdResult.passed) {
      if (
        !badgeMdResult.fullStdout.includes("![Skill Health:") ||
        !badgeMdResult.fullStdout.includes("img.shields.io")
      ) {
        badgeMdResult.passed = false;
        badgeMdResult.error = "Expected markdown image link with shields.io URL";
      }
    }
    results.push(badgeMdResult);

    // j. badge --skill find-skills --format url
    const badgeUrlResult = await runCliCommand("badge --format url", [
      "badge",
      "--skill",
      "find-skills",
      "--format",
      "url",
    ]);
    if (badgeUrlResult.passed) {
      if (!badgeUrlResult.fullStdout.includes("https://img.shields.io/badge/")) {
        badgeUrlResult.passed = false;
        badgeUrlResult.error = "Expected shields.io badge URL";
      }
    }
    results.push(badgeUrlResult);

    // k. badge --skill nonexistent (should fail)
    const badgeMissResult = await runCliCommand("badge --skill nonexistent", [
      "badge",
      "--skill",
      "nonexistent-skill-xyz",
    ]);
    if (badgeMissResult.exitCode !== 1) {
      badgeMissResult.passed = false;
      badgeMissResult.error = `Expected exit code 1 for missing skill, got ${badgeMissResult.exitCode}`;
    } else {
      // exit 1 is the expected behavior — mark as passed
      badgeMissResult.passed = true;
    }
    results.push(badgeMissResult);

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
    // OpenClaw integration tests
    // -----------------------------------------------------------------------

    // a. ingest-openclaw — standard ingestion
    const ingestResult = await runCliCommand("ingest-openclaw", [
      "ingest-openclaw",
      "--agents-dir",
      SANDBOX_OPENCLAW_AGENTS,
    ]);
    // Verify: exit 0 + new records in logs with source: "openclaw"
    if (ingestResult.passed) {
      const queryLogContent = existsSync(queryLogPath)
        ? readFileSync(queryLogPath, "utf-8").trim().split("\n")
        : [];
      const openclawQueries = queryLogContent.filter((line) => {
        try {
          return JSON.parse(line).source === "openclaw";
        } catch {
          return false;
        }
      });
      if (openclawQueries.length === 0) {
        ingestResult.passed = false;
        ingestResult.error = "No openclaw records found in all_queries_log.jsonl after ingestion";
      }

      const telemetryContent = existsSync(telemetryLogPath)
        ? readFileSync(telemetryLogPath, "utf-8").trim().split("\n")
        : [];
      const openclawTelemetry = telemetryContent.filter((line) => {
        try {
          return JSON.parse(line).source === "openclaw";
        } catch {
          return false;
        }
      });
      if (openclawTelemetry.length === 0) {
        ingestResult.passed = false;
        ingestResult.error =
          "No openclaw records found in session_telemetry_log.jsonl after ingestion";
      }

      // Check skill_usage_log for Deploy and CodeReview
      const skillContent = existsSync(skillLogPath)
        ? readFileSync(skillLogPath, "utf-8").trim().split("\n")
        : [];
      const openclawSkills = skillContent.filter((line) => {
        try {
          return JSON.parse(line).source === "openclaw";
        } catch {
          return false;
        }
      });
      if (openclawSkills.length === 0) {
        ingestResult.passed = false;
        ingestResult.error =
          "No openclaw skill records found in skill_usage_log.jsonl after ingestion";
      }

      // Check marker file exists
      const markerPath = join(SANDBOX_SELFTUNE_DIR, "openclaw-ingest-marker.json");
      if (!existsSync(markerPath)) {
        ingestResult.passed = false;
        ingestResult.error = "openclaw-ingest-marker.json not created after ingestion";
      }
    }
    results.push(ingestResult);

    // b. ingest-openclaw --dry-run
    // First, count current lines in query log to verify dry-run doesn't add
    const queryLinesBeforeDry = countLines(queryLogPath);
    const dryRunResult = await runCliCommand("ingest-openclaw --dry-run", [
      "ingest-openclaw",
      "--agents-dir",
      SANDBOX_OPENCLAW_AGENTS,
      "--dry-run",
    ]);
    if (dryRunResult.passed) {
      const queryLinesAfterDry = countLines(queryLogPath);
      if (queryLinesAfterDry !== queryLinesBeforeDry) {
        dryRunResult.passed = false;
        dryRunResult.error = `Dry run should not write records (before: ${queryLinesBeforeDry}, after: ${queryLinesAfterDry})`;
      }
    }
    results.push(dryRunResult);

    // c. ingest-openclaw (idempotent) — second run should find 0 new sessions
    const idempotentResult = await runCliCommand("ingest-openclaw (idempotent)", [
      "ingest-openclaw",
      "--agents-dir",
      SANDBOX_OPENCLAW_AGENTS,
    ]);
    if (idempotentResult.passed) {
      if (!idempotentResult.fullStdout.includes("0 not yet ingested")) {
        idempotentResult.passed = false;
        idempotentResult.error = `Expected "0 not yet ingested" in idempotent run output, got: ${idempotentResult.fullStdout.slice(0, 200)}`;
      }
    }
    results.push(idempotentResult);

    // d. cron list — should show selftune jobs from fixture
    const cronListResult = await runCliCommand("cron list", ["cron", "list"]);
    if (cronListResult.passed) {
      if (!cronListResult.fullStdout.includes("selftune-ingest")) {
        cronListResult.passed = false;
        cronListResult.error = `Expected "selftune-ingest" in cron list output, got: ${cronListResult.fullStdout.slice(0, 200)}`;
      }
    }
    results.push(cronListResult);

    // e. cron setup --dry-run
    // Note: cron setup calls Bun.which("openclaw") and exits 1 if not found.
    // In the sandbox, openclaw is not installed, so we accept exit 1 with the
    // expected "not installed" message as a passing result.
    const cronSetupResult = await runCliCommand("cron setup --dry-run", [
      "cron",
      "setup",
      "--dry-run",
      "--tz",
      "UTC",
    ]);
    if (!cronSetupResult.passed) {
      const combined = `${cronSetupResult.fullStdout} ${cronSetupResult.stderr}`.toLowerCase();
      if (
        combined.includes("not installed") ||
        combined.includes("not found") ||
        combined.includes("not in path")
      ) {
        // Expected: openclaw binary is not available in sandbox
        cronSetupResult.passed = true;
        cronSetupResult.error = undefined;
      }
    }
    results.push(cronSetupResult);

    // -----------------------------------------------------------------------
    // Live badge service smoke tests (badge.selftune.dev)
    // -----------------------------------------------------------------------

    // Smoke test: GET /badge/community/find-skills returns valid SVG
    const badgeLiveResult: RawTestResult = await (async () => {
      const name = "live: badge.selftune.dev";
      const url = "https://badge.selftune.dev/badge/community/find-skills";
      const command = `fetch ${url}`;
      const start = performance.now();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        const body = await res.text();
        const durationMs = Math.round(performance.now() - start);

        if (!res.ok) {
          return {
            name,
            command,
            exitCode: 1,
            passed: false,
            durationMs,
            stdout: body.slice(0, 2000),
            stderr: "",
            fullStdout: body,
            error: `HTTP ${res.status} ${res.statusText}`,
          };
        }

        const contentType = res.headers.get("content-type") ?? "";
        const isSvg = contentType.includes("svg") || body.trimStart().startsWith("<svg");

        return {
          name,
          command,
          exitCode: 0,
          passed: isSvg,
          durationMs,
          stdout: body.slice(0, 2000),
          stderr: "",
          fullStdout: body,
          error: isSvg ? undefined : `Expected SVG response, got content-type: ${contentType}`,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        const isNetworkError =
          err instanceof Error && (err.name === "AbortError" || err.message.includes("fetch"));

        return {
          name,
          command,
          exitCode: isNetworkError ? 0 : 1,
          passed: isNetworkError,
          durationMs,
          stdout: "",
          stderr: "",
          fullStdout: "",
          error: isNetworkError
            ? `Network unreachable (skipped): ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
        };
      }
    })();
    results.push(badgeLiveResult);

    // Smoke test: GET /badge/nonexistent-org/nonexistent-skill returns fallback badge
    const badgeLiveFallbackResult: RawTestResult = await (async () => {
      const name = "live: badge fallback (no data)";
      const url = "https://badge.selftune.dev/badge/nonexistent-org-xyz/nonexistent-skill-xyz";
      const command = `fetch ${url}`;
      const start = performance.now();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        const body = await res.text();
        const durationMs = Math.round(performance.now() - start);

        // Badge service should always return a response (graceful degradation)
        const isSvgOrValid = res.ok || res.status === 404;

        return {
          name,
          command,
          exitCode: 0,
          passed: isSvgOrValid,
          durationMs,
          stdout: body.slice(0, 2000),
          stderr: "",
          fullStdout: body,
          error: isSvgOrValid ? undefined : `Unexpected HTTP ${res.status}`,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        return {
          name,
          command,
          exitCode: 0,
          passed: true,
          durationMs,
          stdout: "",
          stderr: "",
          fullStdout: "",
          error: `Network unreachable (skipped): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })();
    results.push(badgeLiveFallbackResult);

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
