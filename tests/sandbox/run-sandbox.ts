#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const keepSandbox = process.argv.includes("--keep");

// Preserve the installed browser cache when each test process receives a blank HOME.
function browserCachePath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "ms-playwright");
    case "linux":
      return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
    case "win32":
      return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright");
    default:
      throw new Error(`Unsupported browser platform: ${process.platform}`);
  }
}

// Each suite owns its fixtures and assertions. Separate processes prevent module
// mocks or imported environment constants from leaking between journeys.
const checks = [
  { name: "blank-home install", args: ["run", "tests/sandbox/run-install-sandbox.ts"] },
  { name: "CLI entrypoints", args: ["test", "tests/cli/effect-cli.test.ts"] },
  { name: "doctor", args: ["test", "tests/observability.test.ts"] },
  { name: "status", args: ["test", "tests/status/status.test.ts"] },
  { name: "last", args: ["test", "tests/last/last.test.ts"] },
  { name: "hook-to-eval generation", args: ["test", "tests/eval/hooks-to-evals.test.ts"] },
  { name: "eval CLI", args: ["test", "tests/cli/eval-effect-cli.test.ts"] },
  { name: "contribution preview", args: ["test", "tests/contribute/contribute.test.ts"] },
  { name: "contribution CLI", args: ["test", "tests/cli/contribute-effect-cli.test.ts"] },
  {
    name: "badge output",
    args: ["test", "tests/badge/badge.test.ts", "tests/badge/badge-svg.test.ts"],
  },
  { name: "badge CLI", args: ["test", "tests/cli/badge-entrypoint-compat.test.ts"] },
  { name: "prompt hook", args: ["test", "tests/hooks/prompt-log.test.ts"] },
  { name: "skill hook", args: ["test", "tests/hooks/skill-eval.test.ts"] },
  { name: "session hook", args: ["test", "tests/hooks/session-stop.test.ts"] },
  { name: "hook dispatch", args: ["test", "tests/hooks/in-process-dispatch.test.ts"] },
  { name: "OpenClaw ingestion", args: ["test", "tests/ingestors/openclaw-ingest.test.ts"] },
  { name: "cron configuration", args: ["test", "tests/cron/setup.test.ts"] },
  { name: "browser and API journey", args: ["test", "e2e/tests"] },
];

async function main() {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "selftune-sandbox-"));
  const results = [];
  console.log(`Sandbox: ${sandboxRoot}`);
  try {
    for (const [index, check] of checks.entries()) {
      const sandboxHome = join(sandboxRoot, String(index));
      mkdirSync(sandboxHome, { recursive: true });
      const start = performance.now();
      const proc = Bun.spawn([process.execPath, ...check.args], {
        cwd: projectRoot,
        env: {
          PATH: process.env.PATH,
          PLAYWRIGHT_BROWSERS_PATH: browserCachePath(),
          HOME: sandboxHome,
          SELFTUNE_HOME: sandboxHome,
          SELFTUNE_CONFIG_DIR: join(sandboxHome, ".selftune"),
          CODEX_HOME: join(sandboxHome, ".codex"),
          XDG_CONFIG_HOME: join(sandboxHome, ".config"),
          XDG_DATA_HOME: join(sandboxHome, ".local", "share"),
          SELFTUNE_NO_ANALYTICS: "1",
          SELFTUNE_SKIP_UPDATE_CHECK: "1",
          SELFTUNE_NO_BROWSER: "1",
          BUN_ENV: "test",
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, 120_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).finally(() => clearTimeout(timer));
      const result = {
        name: check.name,
        command: [process.execPath, ...check.args].join(" "),
        exitCode,
        passed: exitCode === 0 && !timedOut,
        timedOut,
        durationMs: Math.round(performance.now() - start),
        stdout,
        stderr,
      };
      results.push(result);
      console.log(`${result.passed ? "PASS" : "FAIL"} ${check.name} (${result.durationMs}ms)`);
      if (!result.passed) console.error(stdout, stderr);
    }
    const resultsDir = join(import.meta.dir, "results");
    mkdirSync(resultsDir, { recursive: true });
    const reportPath = join(resultsDir, `sandbox-run-${Date.now()}.json`);
    writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(
      `${results.filter((result) => result.passed).length}/${results.length} suites passed`,
    );
    console.log(`Report: ${reportPath}`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } finally {
    if (keepSandbox) console.log(`Sandbox kept at: ${sandboxRoot}`);
    else rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

await main();
