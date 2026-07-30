import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runCliEntrypoint(args: ReadonlyArray<string>, root?: string) {
  const runtimeRoot = root ?? mkdtempSync(join(tmpdir(), "selftune-effect-cli-"));
  if (!root) temporaryRoots.push(runtimeRoot);
  const child = Bun.spawn([process.execPath, "run", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      HOME: runtimeRoot,
      SELFTUNE_CONFIG_DIR: join(runtimeRoot, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("Effect CLI hybrid selection", () => {
  test("selects fully owned commands for every argument shape", () => {
    for (const command of ["doctor", "status", "last", "quickstart"]) {
      expect(isEffectCliInvocation(command, [])).toBe(true);
      expect(isEffectCliInvocation(command, ["--help"])).toBe(true);
      expect(isEffectCliInvocation(command, ["-h"])).toBe(true);
      expect(isEffectCliInvocation(command, ["--json"])).toBe(true);
      expect(isEffectCliInvocation(command, ["unexpected"])).toBe(true);
    }
    expect(isEffectCliInvocation("telemetry", [])).toBe(true);
    expect(isEffectCliInvocation("telemetry", ["status"])).toBe(true);
    expect(isEffectCliInvocation("telemetry", ["enable"])).toBe(true);
    expect(isEffectCliInvocation("telemetry", ["disable"])).toBe(true);
    expect(isEffectCliInvocation("telemetry", ["--help"])).toBe(true);
  });

  test("leaves commands outside the owned tree on the legacy router", () => {
    expect(isEffectCliInvocation("eval", [])).toBe(true);
    expect(isEffectCliInvocation("ingest", ["claude"])).toBe(false);
  });
});

describe("Effect CLI read-only command family", () => {
  test("dispatches each typed command through the Effect program", async () => {
    const calls: string[] = [];
    for (const command of ["doctor", "status", "last", "quickstart"]) {
      await Effect.runPromise(
        makeEffectCliTestProgram([command], {
          quickstartAction: () => Effect.sync(() => calls.push("quickstart")),
          readOnlyActions: {
            doctor: () => Effect.sync(() => calls.push("doctor")),
            status: () => Effect.sync(() => calls.push("status")),
            last: () => Effect.sync(() => calls.push("last")),
          },
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }

    expect(calls).toEqual(["doctor", "status", "last", "quickstart"]);

    for (const command of ["doctor", "status", "last"]) {
      const error = await Effect.runPromise(
        makeEffectCliTestProgram([command]).pipe(Effect.provide(BunServices.layer), Effect.flip),
      );
      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: `Live ${command} is disabled in the Effect CLI test program.`,
      });
    }
    expect(calls).toEqual(["doctor", "status", "last", "quickstart"]);
  });

  test("dispatches the complete telemetry command family", async () => {
    const calls: string[] = [];
    for (const args of [
      ["telemetry"],
      ["telemetry", "status"],
      ["telemetry", "enable"],
      ["telemetry", "disable"],
    ]) {
      await Effect.runPromise(
        makeEffectCliTestProgram(args, {
          telemetryAction: (action) => Effect.sync(() => calls.push(action)),
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }

    expect(calls).toEqual(["status", "status", "enable", "disable"]);

    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["telemetry", "disable"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live telemetry changes are disabled in the Effect CLI test program.",
    });
    expect(calls).toEqual(["status", "status", "enable", "disable"]);
  });

  test("keeps no-argument default output aligned with explicit status", async () => {
    const defaultStatus = await runCliEntrypoint([]);
    const explicitStatus = await runCliEntrypoint(["status"]);

    expect(defaultStatus.exitCode).toBe(explicitStatus.exitCode);
    expect(defaultStatus.exitCode).toBe(0);
    expect(defaultStatus.stdout).not.toBe("");
    expect(defaultStatus.stdout).toBe(explicitStatus.stdout);
    expect(defaultStatus.stderr).toBe(explicitStatus.stderr);
  });

  test("renders quickstart help without running onboarding or creating state", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-quickstart-"));
    temporaryRoots.push(root);

    const help = await runCliEntrypoint(["quickstart", "--help"], root);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("selftune quickstart");
    expect(help.stdout).toContain("guided onboarding");
    expect(existsSync(join(root, ".selftune"))).toBe(false);
  });

  test("rejects flags and positionals outside the empty command grammar", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-read-only-grammar-"));
    temporaryRoots.push(root);

    const results = await Promise.all(
      ["doctor", "status", "last", "quickstart"].map(async (command) => {
        const [unknownFlag, positional, positionalAfterMarker] = await Promise.all([
          runCliEntrypoint([command, "--json"], root),
          runCliEntrypoint([command, "unexpected"], root),
          runCliEntrypoint([command, "--", "--help"], root),
        ]);
        return { command, positional, positionalAfterMarker, unknownFlag };
      }),
    );

    for (const { command, positional, positionalAfterMarker, unknownFlag } of results) {
      expect(unknownFlag.exitCode).toBe(1);
      expect(unknownFlag.stdout).toBe("");
      expect(unknownFlag.stderr).toContain("Unknown option '--json'");

      expect(positional.exitCode).toBe(1);
      expect(positional.stdout).toBe("");
      expect(positional.stderr).toBe(
        `[ERROR] Invalid arguments: Unexpected argument 'unexpected'. This command does not take positional arguments\n  \u2192 selftune ${command} --help\n`,
      );

      expect(positionalAfterMarker.exitCode).toBe(1);
      expect(positionalAfterMarker.stdout).toBe("");
      expect(positionalAfterMarker.stderr).toContain("Unexpected argument '--help'");
      expect(positionalAfterMarker.stderr).toContain(`selftune ${command} --help`);
    }

    expect(existsSync(join(root, ".selftune"))).toBe(false);
  });

  test("rejects missing and invalid global values before running a handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-read-only-global-values-"));
    temporaryRoots.push(root);

    const results = await Promise.all(
      ["doctor", "status", "last", "quickstart"].map(async (command) => {
        const [missingCompletions, missingLogLevel, invalidCompletions, invalidLogLevel] =
          await Promise.all([
            runCliEntrypoint([command, "--completions"], root),
            runCliEntrypoint([command, "--log-level"], root),
            runCliEntrypoint([command, "--completions", "powershell"], root),
            runCliEntrypoint([command, "--log-level=verbose"], root),
          ]);
        return {
          command,
          invalidCompletions,
          invalidLogLevel,
          missingCompletions,
          missingLogLevel,
        };
      }),
    );

    for (const result of results) {
      for (const malformed of [result.missingCompletions, result.missingLogLevel]) {
        expect(malformed.exitCode).toBe(1);
        expect(malformed.stdout).toBe("");
        expect(malformed.stderr).toContain("<value>' argument missing");
        expect(malformed.stderr).toContain(`selftune ${result.command} --help`);
      }
      for (const malformed of [result.invalidCompletions, result.invalidLogLevel]) {
        expect(malformed.exitCode).toBe(1);
        expect(malformed.stdout).toBe("");
        expect(malformed.stderr).toContain("Invalid value");
        expect(malformed.stderr).not.toContain("timestamp=");
        expect(malformed.stderr).toContain(`selftune ${result.command} --help`);
      }
    }

    expect(existsSync(join(root, ".selftune"))).toBe(false);
  });

  test("rejects malformed arguments even when help or version would short-circuit", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-read-only-short-circuit-"));
    temporaryRoots.push(root);

    const checkMalformedArguments = async (command: string) => {
      const [
        compatibleHelp,
        helpMissingValue,
        helpPositional,
        helpUnknown,
        versionPositional,
        versionUnknown,
      ] = await Promise.all([
        runCliEntrypoint([command, "--help", "--log-level", "info"], root),
        runCliEntrypoint([command, "--help", "--log-level"], root),
        runCliEntrypoint([command, "--help", "unexpected"], root),
        runCliEntrypoint([command, "--help", "--unknown"], root),
        runCliEntrypoint([command, "--version", "unexpected"], root),
        runCliEntrypoint([command, "--version", "--unknown"], root),
      ]);
      expect(compatibleHelp.exitCode).toBe(0);
      expect(compatibleHelp.stdout).toContain(`selftune ${command} [flags]`);
      expect(compatibleHelp.stderr).toBe("");

      expect(helpMissingValue.exitCode).toBe(1);
      expect(helpMissingValue.stdout).toBe("");
      expect(helpMissingValue.stderr).toContain("Option '--log-level <value>' argument missing");

      for (const malformed of [helpPositional, versionPositional]) {
        expect(malformed.exitCode).toBe(1);
        expect(malformed.stdout).toBe("");
        expect(malformed.stderr).toContain("Unexpected argument 'unexpected'");
        expect(malformed.stderr).toContain(`selftune ${command} --help`);
      }
      for (const malformed of [helpUnknown, versionUnknown]) {
        expect(malformed.exitCode).toBe(1);
        expect(malformed.stdout).toBe("");
        expect(malformed.stderr).toContain("Unknown option '--unknown'");
        expect(malformed.stderr).toContain(`selftune ${command} --help`);
      }
    };

    await checkMalformedArguments("doctor");
    await checkMalformedArguments("status");
    await checkMalformedArguments("last");
    await checkMalformedArguments("quickstart");
  }, 30_000);

  test("rejects attached help and version spellings before they can hide extra input", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-read-only-attached-globals-"));
    temporaryRoots.push(root);

    const results = await Promise.all(
      ["doctor", "status", "last", "quickstart"].map(async (command) => {
        const [shortHelp, longHelp, version] = await Promise.all([
          runCliEntrypoint([command, "-hfoo", "unexpected"], root),
          runCliEntrypoint([command, "--help=true", "--unknown"], root),
          runCliEntrypoint([command, "--version=false", "unexpected"], root),
        ]);
        return { command, longHelp, shortHelp, version };
      }),
    );

    for (const { command, longHelp, shortHelp, version } of results) {
      for (const malformed of [shortHelp, longHelp, version]) {
        expect(malformed.exitCode).toBe(1);
        expect(malformed.stdout).toBe("");
        expect(malformed.stderr).toContain("Unknown option");
        expect(malformed.stderr).toContain(`selftune ${command} --help`);
      }
    }

    expect(existsSync(join(root, ".selftune"))).toBe(false);
  });

  test("runs telemetry status, enable, disable, and help through the hybrid entrypoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-effect-telemetry-"));
    temporaryRoots.push(root);
    const configPath = join(root, ".selftune", "config.json");
    mkdirSync(join(root, ".selftune"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ agent_type: "codex", preserved_field: "keep" }),
      "utf-8",
    );

    const disabled = await runCliEntrypoint(["telemetry", "disable"], root);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout).toContain("Telemetry disabled.");
    const disabledConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(disabledConfig.analytics_disabled).toBe(true);
    expect(disabledConfig.agent_type).toBe("codex");
    expect(disabledConfig.preserved_field).toBe("keep");

    const status = await runCliEntrypoint(["telemetry", "status"], root);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Telemetry: disabled");
    expect(status.stdout).toContain("Disabled via: config file");

    const enabled = await runCliEntrypoint(["telemetry", "enable"], root);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.stdout).toContain("Telemetry enabled.");
    expect(JSON.parse(readFileSync(configPath, "utf-8")).analytics_disabled).toBe(false);

    const help = await runCliEntrypoint(["telemetry", "--help"], root);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("selftune telemetry <subcommand>");
    expect(help.stdout).toContain("status");
    expect(help.stdout).toContain("enable");
    expect(help.stdout).toContain("disable");
    expect(help.stdout).toContain("SELFTUNE_NO_ANALYTICS=1");
    expect(help.stdout).toContain("No PII");
    expect(help.stdout).toContain("https://github.com/selftune-dev/selftune#telemetry");

    for (const subcommand of ["status", "enable", "disable"]) {
      const leafHelp = await runCliEntrypoint(["telemetry", subcommand, "--help"], root);
      expect(leafHelp.exitCode).toBe(0);
      expect(leafHelp.stdout).toContain(`selftune telemetry ${subcommand}`);
    }

    const unknownSubcommand = await runCliEntrypoint(["telemetry", "unknown"], root);
    expect(unknownSubcommand.exitCode).toBe(1);
    expect(unknownSubcommand.stderr).toContain('Unknown subcommand "unknown"');

    const unknownFlag = await runCliEntrypoint(["telemetry", "--unknown"], root);
    expect(unknownFlag.exitCode).toBe(1);
    expect(unknownFlag.stderr).toContain("Unrecognized flag: --unknown");
  });
});
