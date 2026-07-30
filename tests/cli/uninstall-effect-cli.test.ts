import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { getLegacyCommandGroup } from "../../apps/cli/src/commands/router.js";
import {
  makeUninstallCommand,
  toUninstallCliError,
  type UninstallAction,
  UNINSTALL_HELP,
} from "../../apps/cli/src/effect-cli/commands/uninstall.js";
import { prepareEffectCliArguments } from "../../apps/cli/src/effect-cli/argument-compatibility.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type { UninstallOptions } from "../../apps/cli/src/commands/uninstall/types.js";
import { ServiceFailure } from "@selftune/local/service";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const SELF_TUNE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-uninstall-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "uninstall", ...args], {
    cwd: SELF_TUNE_ROOT,
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
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

function runCommand(args: ReadonlyArray<string>, action: UninstallAction) {
  const run = Command.runWith(makeUninstallCommand(action), { version: "test" });
  return Effect.gen(function* () {
    const prepared = yield* prepareEffectCliArguments(["uninstall", ...args]);
    yield* run(prepared.slice(1));
  }).pipe(Effect.provide(BunServices.layer));
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("Effect-owned uninstall command", () => {
  test("selects the Effect tree and has no legacy route", () => {
    expect(isEffectCliInvocation("uninstall", [])).toBe(true);
    expect(isEffectCliInvocation("uninstall", ["--help"])).toBe(true);
    expect(isEffectCliInvocation("uninstall", ["--unknown"])).toBe(true);
    expect(getLegacyCommandGroup("uninstall")).toBeUndefined();
  });

  test("maps defaults and public boolean flags without a global handler property", async () => {
    const inputs: UninstallOptions[] = [];
    const action: UninstallAction = (input) => Effect.sync(() => inputs.push(input));

    await Effect.runPromise(runCommand([], action));
    await Effect.runPromise(runCommand(["--dry-run", "--keep-logs", "--npm-uninstall"], action));
    await Effect.runPromise(runCommand(["--dry-run", "--dry-run"], action));
    await Effect.runPromise(runCommand(["--"], action));

    expect(inputs).toEqual([
      { dryRun: false, keepLogs: false, npmUninstall: false },
      { dryRun: true, keepLogs: true, npmUninstall: true },
      { dryRun: true, keepLogs: false, npmUninstall: false },
      { dryRun: false, keepLogs: false, npmUninstall: false },
    ]);
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(
      false,
    );
    const root = readFileSync(
      join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/root-command.ts"),
      "utf8",
    );
    expect(root).toContain("makeUninstallCommand(options.uninstallAction)");
  });

  test("renders command help without invoking cleanup", () => {
    const home = makeHome();
    const configDir = join(home, ".selftune");
    writeFileSync(join(home, "sentinel"), "preserve");

    const help = runCli(home, "--help");

    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toBe(`${UNINSTALL_HELP}\n`);
    expect(help.stdout).not.toContain("__none__");
    expect(help.stdout).not.toContain("--version");
    expect(help.stdout).not.toContain("--completions");
    expect(help.stdout).not.toContain("--log-level");
    expect(help.stdout).not.toContain("-h, --help");
    expect(readFileSync(join(home, "sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(configDir)).toBe(false);
  });

  test("preserves pretty JSON output and exact skip semantics in dry-run mode", () => {
    const home = makeHome();
    const sentinels = new Map([
      [join(home, ".selftune", "selftune.db"), "sqlite-sentinel"],
      [join(home, ".selftune", "config.json"), "config-sentinel"],
      [join(home, ".claude", "session_telemetry_log.jsonl"), "log-sentinel\n"],
      [join(home, ".claude", "claude_code_ingested_sessions.json"), "marker-sentinel"],
      [join(home, ".claude", "agents", "diagnosis-analyst.md"), "agent-sentinel"],
      [
        join(home, ".claude", "settings.json"),
        JSON.stringify({ hooks: { Stop: [{ command: "selftune hook session-stop" }] } }),
      ],
    ]);
    for (const [path, contents] of sentinels) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }

    const result = runCli(home, "--dry-run", "--keep-logs", "--npm-uninstall");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith('{\n  "dryRun": true,')).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      hooks: { removed: 1 },
      agents: { removed: 1 },
      logs: { removed: 0, files: [], skipped: true },
      markers: { removed: 1 },
      npm: { uninstalled: false, skipped: false },
    });
    for (const [path, contents] of sentinels) {
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
  });

  test("rejects the complete legacy-invalid grammar before invoking cleanup", async () => {
    const calls: UninstallOptions[] = [];
    const action: UninstallAction = (input) => Effect.sync(() => calls.push(input));
    const malformed: ReadonlyArray<ReadonlyArray<string>> = [
      ["--dry-run=true"],
      ["--dry-run=false"],
      ["--dry-run=0"],
      ["--help=true"],
      ["--help=false"],
      ["--help=0"],
      ["--keep-logs=true"],
      ["--npm-uninstall=false"],
      ["--no-dry-run"],
      ["--no-keep-logs"],
      ["--no-npm-uninstall"],
      ["--dry-run", "false"],
      ["--keep-logs", "false"],
      ["unexpected"],
      ["--", "unexpected"],
      ["--unknown"],
      ["--help", "--unknown"],
      ["--help", "unexpected"],
      ["-h"],
      ["--version"],
      ["--log-level", "info"],
      ["--completions", "bash"],
    ];

    const errors = await Promise.all(
      malformed.map((args) => Effect.runPromise(runCommand(args, action).pipe(Effect.flip))),
    );
    for (const error of errors) {
      expect(error).toMatchObject({ code: "INVALID_FLAG" });
    }
    expect(calls).toEqual([]);
  });

  test("validates all arguments before help and accepts legacy-compatible help combinations", () => {
    const home = makeHome();

    for (const args of [
      ["--help", "--unknown"],
      ["--help", "unexpected"],
      ["--help", "-h"],
    ]) {
      const result = runCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid arguments:");
    }

    const valid = runCli(home, "--help", "--dry-run", "--help");
    expect(valid.exitCode, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("selftune uninstall");
  });

  test("keeps the compatibility facade free of CLI parsing and process ownership", () => {
    const facade = readFileSync(join(SELF_TUNE_ROOT, "apps/cli/src/commands/uninstall.ts"), "utf8");
    expect(facade).not.toContain("parseArgs");
    expect(facade).not.toContain("process.argv");
    expect(facade).not.toContain("cliMain");
    expect(facade).not.toContain("import.meta.main");
  });

  test("fails closed when the shared Effect CLI test program selects uninstall", async () => {
    const received = await Effect.runPromise(
      makeEffectCliTestProgram(["uninstall"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(received).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live uninstall is disabled in the Effect CLI test program.",
    });
  });

  test("maps typed cleanup failures at the command boundary", () => {
    const failure = ServiceFailure.make({
      operation: "uninstall",
      message: "service ownership proof changed",
    });

    expect(toUninstallCliError(failure)).toMatchObject({
      code: "OPERATION_FAILED",
      message: "service ownership proof changed",
      suggestion: "selftune uninstall --dry-run",
    });
  });
});
