import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const temporaryHomes: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-telemetry-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runTelemetry(home: string, ...args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "telemetry", ...args], {
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      CI: "",
      SELFTUNE_NO_ANALYTICS: "",
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

function readAnalyticsDisabled(home: string): boolean {
  const config = JSON.parse(readFileSync(join(home, ".selftune", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return config.analytics_disabled === true;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("telemetry Effect CLI compatibility", () => {
  test("default and explicit status preserve telemetry status output", () => {
    const home = makeHome();
    const defaultStatus = runTelemetry(home);
    const explicitStatus = runTelemetry(home, "status");

    expect(defaultStatus.exitCode, defaultStatus.stderr).toBe(0);
    expect(explicitStatus.exitCode, explicitStatus.stderr).toBe(0);
    expect(defaultStatus.stdout).toBe(explicitStatus.stdout);
    expect(defaultStatus.stdout).toContain("Telemetry: enabled");
    expect(defaultStatus.stdout).toContain("To opt out: selftune telemetry disable");
  });

  test("leaf help is owned without executing mutations", () => {
    const home = makeHome();
    for (const args of [
      ["status", "--help"],
      ["enable", "--help"],
      ["disable", "--help"],
    ]) {
      const result = runTelemetry(home, ...args);
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("USAGE");
      expect(result.stdout).toContain(`selftune telemetry ${args[0]}`);
    }
    const configPath = join(home, ".selftune", "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(config.analytics_disabled).toBeUndefined();
    }
  });

  test("unknown subcommands and flags fail with actionable parser errors", () => {
    const home = makeHome();
    const unknownCommand = runTelemetry(home, "unknown");
    expect(unknownCommand.exitCode).toBe(1);
    expect(unknownCommand.stderr).toContain('Unknown subcommand "unknown"');

    const unknownFlag = runTelemetry(home, "--unknown");
    expect(unknownFlag.exitCode).toBe(1);
    expect(unknownFlag.stderr).toContain("Unrecognized flag: --unknown");
  });

  test("telemetry state stays isolated between configured homes", () => {
    const firstHome = makeHome();
    const secondHome = makeHome();
    expect(runTelemetry(firstHome, "disable").exitCode).toBe(0);
    expect(runTelemetry(secondHome, "enable").exitCode).toBe(0);

    expect(readAnalyticsDisabled(firstHome)).toBe(true);
    expect(readAnalyticsDisabled(secondHome)).toBe(false);
    expect(runTelemetry(firstHome, "status").stdout).toContain("Telemetry: disabled");
    expect(runTelemetry(secondHome, "status").stdout).toContain("Telemetry: enabled");
  });

  test("telemetry ownership does not capture legacy command families", () => {
    expect(isEffectCliInvocation("telemetry", ["status"])).toBe(true);
    expect(isEffectCliInvocation("eval", [])).toBe(true);
    expect(isEffectCliInvocation("eval", ["--help"])).toBe(true);
    for (const command of Object.values(LEGACY_COMMAND_GROUPS).flat()) {
      expect(isEffectCliInvocation(command, [])).toBe(false);
      expect(isEffectCliInvocation(command, ["--help"])).toBe(false);
    }
  });
});
