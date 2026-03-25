#!/usr/bin/env bun
/**
 * Empty-state sandbox install test for selftune.
 *
 * Verifies the real setup path from a blank HOME:
 *   1. `selftune init` writes config
 *   2. Claude settings hooks are installed
 *   3. `selftune doctor` reports hook_settings as pass
 *   4. re-running init without --force is idempotent
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "cli", "selftune", "index.ts");
const PACKAGE_JSON = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as {
  version?: string;
};
const CLI_VERSION = PACKAGE_JSON.version ?? "0.0.0";
const dateStamp = new Date().toISOString().slice(0, 10);
const SANDBOX_ROOT = mkdtempSync(
  join(tmpdir(), `selftune-install-sandbox-v${CLI_VERSION}-${dateStamp}-`),
);
const SANDBOX_HOME = join(SANDBOX_ROOT, "home");
const CONFIG_PATH = join(SANDBOX_HOME, ".selftune", "config.json");
const SETTINGS_PATH = join(SANDBOX_HOME, ".claude", "settings.json");

mkdirSync(join(SANDBOX_HOME, ".claude"), { recursive: true });

const sandboxEnv = {
  ...process.env,
  HOME: SANDBOX_HOME,
  SELFTUNE_HOME: SANDBOX_HOME,
  NO_COLOR: "1",
};

async function runCliCommand(name: string, args: string[]): Promise<TestResult> {
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

    return {
      name,
      command,
      exitCode,
      passed: exitCode === 0,
      durationMs: Math.round(performance.now() - start),
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      name,
      command,
      exitCode: 1,
      passed: false,
      durationMs: Math.round(performance.now() - start),
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function formatRow(columns: string[], widths: number[]): string {
  return `| ${columns.map((column, i) => column.padEnd(widths[i])).join(" | ")} |`;
}

function printSummary(results: TestResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length), "Test".length);
  const statusWidth = Math.max(...results.map((r) => (r.passed ? 4 : 4)), "Status".length);
  const durationWidth = Math.max(
    ...results.map((r) => `${r.durationMs}ms`.length),
    "Duration".length,
  );
  const widths = [nameWidth, statusWidth, durationWidth];
  const separator = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;

  console.log(`\n${separator}`);
  console.log(formatRow(["Test", "Status", "Duration"], widths));
  console.log(separator);
  for (const result of results) {
    console.log(
      formatRow([result.name, result.passed ? "PASS" : "FAIL", `${result.durationMs}ms`], widths),
    );
  }
  console.log(`${separator}\n`);

  const passed = results.filter((r) => r.passed).length;
  console.log(`Results: ${passed}/${results.length} passed`);
}

async function main(): Promise<void> {
  console.log("\nSelftune Empty-State Install Sandbox");
  console.log("====================================");
  console.log(`Sandbox: ${SANDBOX_ROOT}`);
  console.log(`Project: ${PROJECT_ROOT}\n`);

  const results: TestResult[] = [];

  try {
    const initResult = await runCliCommand("init", [
      "init",
      "--agent",
      "claude_code",
      "--cli-path",
      CLI_PATH,
      "--force",
    ]);
    if (initResult.passed) {
      if (!existsSync(CONFIG_PATH)) {
        initResult.passed = false;
        initResult.error = `Expected config at ${CONFIG_PATH}`;
      } else if (!existsSync(SETTINGS_PATH)) {
        initResult.passed = false;
        initResult.error = `Expected Claude settings at ${SETTINGS_PATH}`;
      } else {
        const config = readJson(CONFIG_PATH) as Record<string, unknown>;
        if (config.agent_type !== "claude_code" || config.hooks_installed !== true) {
          initResult.passed = false;
          initResult.error = "Expected claude_code config with hooks_installed=true";
        }
      }
    }
    results.push(initResult);

    const hookInstallResult: TestResult = {
      name: "installed hooks",
      command: SETTINGS_PATH,
      exitCode: 0,
      passed: true,
      durationMs: 0,
      stdout: "",
      stderr: "",
    };
    if (existsSync(SETTINGS_PATH)) {
      const settings = readJson(SETTINGS_PATH) as {
        hooks?: Record<string, Array<Record<string, unknown>>>;
      };
      const hooks = settings.hooks ?? {};
      const requiredKeys = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
      const missing = requiredKeys.filter((key) => !Array.isArray(hooks[key]));
      const promptCommand =
        hooks.UserPromptSubmit?.[0]?.hooks &&
        Array.isArray(hooks.UserPromptSubmit[0].hooks) &&
        typeof hooks.UserPromptSubmit[0].hooks[0]?.command === "string"
          ? (hooks.UserPromptSubmit[0].hooks[0].command as string)
          : "";
      if (missing.length > 0) {
        hookInstallResult.passed = false;
        hookInstallResult.error = `Missing hook keys: ${missing.join(", ")}`;
      } else if (!promptCommand.includes(`${dirname(CLI_PATH)}/hooks/prompt-log.ts`)) {
        hookInstallResult.passed = false;
        hookInstallResult.error = "Prompt hook command did not resolve to the workspace hook path";
      }
    } else {
      hookInstallResult.passed = false;
      hookInstallResult.error = `Missing settings file at ${SETTINGS_PATH}`;
    }
    results.push(hookInstallResult);

    const doctorResult = await runCliCommand("doctor", ["doctor"]);
    if (doctorResult.passed) {
      try {
        const parsed = JSON.parse(doctorResult.stdout) as {
          checks?: Array<{ name?: string; status?: string }>;
        };
        const hookCheck = parsed.checks?.find((check) => check.name === "hook_settings");
        if (hookCheck?.status !== "pass") {
          doctorResult.passed = false;
          doctorResult.error = `Expected hook_settings=pass, got ${hookCheck?.status ?? "missing"}`;
        }
      } catch (error) {
        doctorResult.passed = false;
        doctorResult.error =
          error instanceof Error ? `Failed to parse doctor JSON: ${error.message}` : String(error);
      }
    }
    results.push(doctorResult);

    const idempotentResult = await runCliCommand("init (idempotent)", [
      "init",
      "--agent",
      "claude_code",
      "--cli-path",
      CLI_PATH,
    ]);
    if (idempotentResult.passed && !idempotentResult.stderr.includes("Already initialized")) {
      idempotentResult.passed = false;
      idempotentResult.error = 'Expected stderr to include "Already initialized"';
    }
    results.push(idempotentResult);

    printSummary(results);

    const failures = results.filter((result) => !result.passed);
    if (failures.length > 0) {
      console.error("\n--- Failures ---\n");
      for (const failure of failures) {
        console.error(`[${failure.name}] exit=${failure.exitCode}`);
        if (failure.error) console.error(`  Error: ${failure.error}`);
        if (failure.stderr.trim())
          console.error(`  Stderr: ${failure.stderr.trim().slice(0, 400)}`);
      }
      process.exit(1);
    }
  } finally {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  }
}

await main();
