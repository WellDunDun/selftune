import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECOVER_HELP } from "../../apps/cli/src/effect-cli/commands/recover.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const temporaryHomes: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RecoverSummary {
  mode: "incremental" | "full";
  source: "legacy_jsonl_or_export_snapshot";
  since: string | null;
  force: boolean;
  result: Record<string, number>;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-recover-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runRecover(home: string, ...args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "recover", ...args], {
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_LOG_DIR: join(home, "logs"),
      CI: "1",
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function parseSummary(result: CliResult): RecoverSummary {
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as RecoverSummary;
}

function expectNoRecoveryMutation(home: string): void {
  expect(existsSync(join(home, ".selftune"))).toBe(false);
  expect(existsSync(join(home, "logs"))).toBe(false);
  expect(existsSync(join(home, "sources"))).toBe(false);
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("recover Effect CLI compatibility", () => {
  test("defaults to incremental recovery over isolated paths", () => {
    const home = makeHome();
    const summary = parseSummary(runRecover(home, "--json"));
    expect(summary).toMatchObject({
      mode: "incremental",
      source: "legacy_jsonl_or_export_snapshot",
      since: null,
      force: false,
    });
    expect(Object.values(summary.result).every((count) => count === 0)).toBe(true);
    expect(existsSync(join(home, ".selftune"))).toBe(true);
  });

  test("full recovery preserves full and force options", () => {
    const home = makeHome();
    const summary = parseSummary(runRecover(home, "--full", "--force", "--json"));
    expect(summary.mode).toBe("full");
    expect(summary.force).toBe(true);
    expect(summary.since).toBeNull();
  });

  test("accepts since and every source-path option together", () => {
    const home = makeHome();
    const sources = join(home, "sources");
    const summary = parseSummary(
      runRecover(
        home,
        "--force",
        "--since",
        "2026-01-02",
        "--json",
        "--canonical-log",
        join(sources, "canonical.jsonl"),
        "--telemetry-log",
        join(sources, "telemetry.jsonl"),
        "--evolution-audit-log",
        join(sources, "evolution-audit.jsonl"),
        "--evolution-evidence-log",
        join(sources, "evolution-evidence.jsonl"),
        "--orchestrate-run-log",
        join(sources, "orchestrate-runs.jsonl"),
      ),
    );
    expect(summary).toMatchObject({
      mode: "incremental",
      force: true,
      since: "2026-01-02T00:00:00.000Z",
    });
  });

  test("help documents every option without opening recovery state", () => {
    const home = makeHome();
    const result = runRecover(home, "--help");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${RECOVER_HELP}\n`);
    expect(result.stdout).not.toContain("GLOBAL FLAGS");
    expect(result.stdout).not.toContain("--version");
    for (const flag of [
      "--full",
      "--force",
      "--since",
      "--json",
      "--canonical-log",
      "--telemetry-log",
      "--evolution-audit-log",
      "--evolution-evidence-log",
      "--orchestrate-run-log",
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expectNoRecoveryMutation(home);
  });

  test("full and since conflict before recovery state is opened", () => {
    const home = makeHome();
    const result = runRecover(home, "--full", "--since", "2026-01-01");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot combine --full with --since.");
    expectNoRecoveryMutation(home);
  });

  test("invalid since fails before recovery state is opened", () => {
    const home = makeHome();
    const result = runRecover(home, "--since", "not-a-date");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --since date: not-a-date");
    expectNoRecoveryMutation(home);
  });

  test("unknown flags fail in the parser without opening recovery state", () => {
    const home = makeHome();
    const result = runRecover(home, "--unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid arguments: Unknown option '--unknown'");
    expectNoRecoveryMutation(home);
  });

  test("missing string flag values fail before opening recovery state", () => {
    for (const flag of [
      "--since",
      "--canonical-log",
      "--telemetry-log",
      "--evolution-audit-log",
      "--evolution-evidence-log",
      "--orchestrate-run-log",
    ]) {
      const home = makeHome();
      const result = runRecover(home, flag);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("argument missing");
      expectNoRecoveryMutation(home);
    }
  });

  test("legacy-invalid forms fail before opening recovery state", () => {
    const malformed = [
      ["--full=true"],
      ["--force=false"],
      ["--json=0"],
      ["--help=true"],
      ["--no-full"],
      ["--full", "false"],
      ["--since", "-value"],
      ["unexpected"],
      ["--", "unexpected"],
      ["--version"],
      ["--log-level", "info"],
      ["--completions", "bash"],
      ["--help", "--unknown"],
      ["--help", "unexpected"],
      ["--help", "--since"],
      ["-h=true"],
    ];

    for (const args of malformed) {
      const home = makeHome();
      const result = runRecover(home, ...args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("Invalid arguments:");
      expectNoRecoveryMutation(home);
    }
  });
});
