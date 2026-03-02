#!/usr/bin/env bun
/**
 * run-openclaw-tests.ts
 *
 * Layer 2 OpenClaw integration test orchestrator for selftune.
 * Runs inside Docker with a real OpenClaw gateway container.
 *
 * Tests:
 *   1. gateway-health    — Verify OpenClaw gateway is responding
 *   2. ingest-openclaw   — Ingest sessions from gateway data
 *   3. cron setup        — Register cron jobs (dry-run)
 *   4. cron list         — List registered cron jobs
 *   5. status            — Show skill health after ingestion
 *   6. doctor            — Run health checks
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
  layer: "layer2-openclaw";
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
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";

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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Test 1: Gateway Health
// ---------------------------------------------------------------------------

async function testGatewayHealth(): Promise<unknown> {
  const url = `${GATEWAY_URL}/healthz`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gateway health check failed: HTTP ${res.status}`);
  }
  const body = await res.text();
  console.log(`  [gateway-health] ${url} -> ${res.status}`);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Test 2: Ingest OpenClaw
// ---------------------------------------------------------------------------

async function testIngestOpenclaw(): Promise<unknown> {
  const agentsDir = join(homedir(), ".openclaw", "agents");
  const { exitCode, stdout, stderr } = await runSelftune([
    "ingest-openclaw",
    "--agents-dir",
    agentsDir,
  ]);

  if (exitCode !== 0) {
    throw new Error(`ingest-openclaw exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  if (!stdout.toLowerCase().includes("ingest")) {
    throw new Error(`Expected stdout to mention ingestion, got: ${stdout.slice(0, 200)}`);
  }

  console.log(`  [ingest-openclaw] ${stdout.trim().split("\n").slice(-2).join(" | ")}`);
  return { exitCode, stdout: stdout.slice(0, 1000) };
}

// ---------------------------------------------------------------------------
// Test 3: Cron Setup (dry-run)
// ---------------------------------------------------------------------------

async function testCronSetup(): Promise<unknown> {
  const { exitCode, stdout, stderr } = await runSelftune([
    "cron",
    "setup",
    "--dry-run",
    "--tz",
    "UTC",
  ]);

  if (exitCode !== 0) {
    throw new Error(`cron setup exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  if (!stdout.includes("[DRY RUN]")) {
    throw new Error(`Expected [DRY RUN] in stdout, got: ${stdout.slice(0, 200)}`);
  }

  console.log(`  [cron setup] ${stdout.trim().split("\n")[0]}`);
  return { exitCode, stdout: stdout.slice(0, 1000) };
}

// ---------------------------------------------------------------------------
// Test 4: Cron List
// ---------------------------------------------------------------------------

async function testCronList(): Promise<unknown> {
  const { exitCode, stdout, stderr } = await runSelftune(["cron", "list"]);

  if (exitCode !== 0) {
    throw new Error(`cron list exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  if (!stdout.includes("selftune-ingest")) {
    throw new Error(`Expected selftune-ingest in stdout, got: ${stdout.slice(0, 200)}`);
  }

  console.log(`  [cron list] ${stdout.trim().split("\n")[0]}`);
  return { exitCode, stdout: stdout.slice(0, 1000) };
}

// ---------------------------------------------------------------------------
// Test 5: Status
// ---------------------------------------------------------------------------

async function testStatus(): Promise<unknown> {
  const { exitCode, stdout, stderr } = await runSelftune(["status"]);

  if (exitCode !== 0) {
    throw new Error(`status exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  if (stdout.trim().length === 0) {
    throw new Error("status produced empty output");
  }

  console.log(`  [status] ${stdout.trim().split("\n")[0]}`);
  return { exitCode, stdout: stdout.slice(0, 1000) };
}

// ---------------------------------------------------------------------------
// Test 6: Doctor
// ---------------------------------------------------------------------------

async function testDoctor(): Promise<unknown> {
  const { exitCode, stdout } = await runSelftune(["doctor"]);

  // doctor may exit 1 for unhealthy checks — that's acceptable
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // doctor may output non-JSON (table format); check for any meaningful output
    if (stdout.trim().length === 0) {
      throw new Error(`doctor produced empty output (exit ${exitCode})`);
    }
    console.log(
      `  [doctor] exit=${exitCode}, non-JSON output (${stdout.trim().split("\n").length} lines)`,
    );
    return { exitCode, stdout: stdout.slice(0, 1000) };
  }

  const checks = (parsed as Record<string, unknown>).checks;
  if (!Array.isArray(checks)) {
    throw new Error(`doctor JSON missing checks array: ${stdout.slice(0, 200)}`);
  }

  console.log(`  [doctor] exit=${exitCode}, ${checks.length} checks`);
  return { exitCode, checks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== selftune Layer 2: OpenClaw Docker Integration Tests ===\n");
  console.log(`HOME: ${homedir()}`);
  console.log(`CLI:  ${CLI_PATH}`);
  console.log(`GW:   ${GATEWAY_URL}\n`);

  const tests: TestResult[] = [];

  console.log("[1/6] Testing gateway health...");
  tests.push(await runTest("gateway-health", testGatewayHealth));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[2/6] Testing ingest-openclaw...");
  tests.push(await runTest("ingest-openclaw", testIngestOpenclaw));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[3/6] Testing cron setup --dry-run...");
  tests.push(await runTest("cron-setup-dry-run", testCronSetup));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[4/6] Testing cron list...");
  tests.push(await runTest("cron-list", testCronList));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[5/6] Testing status...");
  tests.push(await runTest("status", testStatus));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  console.log("[6/6] Testing doctor...");
  tests.push(await runTest("doctor", testDoctor));
  console.log(`  -> ${tests[tests.length - 1].passed ? "PASS" : "FAIL"}\n`);

  const passed = tests.filter((t) => t.passed).length;
  const failed = tests.filter((t) => !t.passed).length;

  const report: RunReport = {
    timestamp: new Date().toISOString(),
    layer: "layer2-openclaw",
    total: tests.length,
    passed,
    failed,
    tests,
  };

  const resultsDir = join(PROJECT_ROOT, "tests", "sandbox", "results");
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `openclaw-run-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("=== Summary ===");
  console.log(`Total: ${report.total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Results: ${outputPath}`);

  for (const t of tests) {
    if (!t.passed) {
      console.error(`  FAIL: ${t.name} — ${t.error}`);
    }
  }

  if (process.env.KEEP_DATA === "1") {
    console.log("\nKEEP_DATA=1: Data preserved in Docker volumes for inspection.");
    console.log("  Run 'make sandbox-openclaw-clean' to remove volumes when done.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err}`);
  process.exit(1);
});
