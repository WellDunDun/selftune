import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const effectCommands = ["doctor", "status", "last", "quickstart"] as const;
const selftuneRoot = resolve(import.meta.dir, "../..");
const isolatedHome = mkdtempSync(join(tmpdir(), "selftune-effect-cli-compat-"));
const legacyGroupedCommands = Object.values(LEGACY_COMMAND_GROUPS).flat();

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(...args: string[]): CliResult {
  const result = Bun.spawnSync(["bun", "apps/cli/src/main.ts", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      HOME: isolatedHome,
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

function runLegacyRuntimeCli(modulePath: string): CliResult {
  const result = Bun.spawnSync(
    [
      "bun",
      "-e",
      `const runtime = await import(${JSON.stringify(modulePath)}); await runtime.cliMain();`,
    ],
    {
      cwd: selftuneRoot,
      env: {
        ...process.env,
        HOME: isolatedHome,
        CI: "1",
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function readFastCommands(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "apps/cli/src/main.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let commands: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "FAST_COMMANDS" &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const values = node.initializer.arguments?.[0];
      if (values && ts.isArrayLiteralExpression(values)) {
        commands = values.elements.filter(ts.isStringLiteral).map((element) => element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return commands;
}

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

describe("hybrid Effect CLI compatibility", () => {
  test("read-only commands keep every argument shape inside Effect", () => {
    for (const command of effectCommands) {
      expect(isEffectCliInvocation(command, ["--help"])).toBe(true);
      expect(isEffectCliInvocation(command, ["-h"])).toBe(true);
      expect(isEffectCliInvocation(command, ["--json"])).toBe(true);
      expect(isEffectCliInvocation(command, ["unexpected"])).toBe(true);
    }
  });

  test("legacy grouped commands never select the Effect command tree", () => {
    for (const command of legacyGroupedCommands) {
      expect(isEffectCliInvocation(command, [])).toBe(false);
      expect(isEffectCliInvocation(command, ["--help"])).toBe(false);
    }
  });

  test("live read-only commands preserve their normal output and exit behavior", () => {
    const status = runCli("status");
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("selftune status");

    const last = runCli("last");
    expect(last.exitCode, last.stderr).toBe(0);
    expect(last.stdout).toContain("No session data found.");

    const doctor = runCli("doctor");
    expect(doctor.exitCode).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ command: "doctor", healthy: false });
  });

  test("Effect status and last preserve standalone facade output and exit behavior", () => {
    for (const { command, modulePath } of [
      { command: "status", modulePath: "./packages/runtime/status.ts" },
      { command: "last", modulePath: "./packages/runtime/last.ts" },
    ]) {
      const effectResult = runCli(command);
      const legacyResult = runLegacyRuntimeCli(modulePath);

      expect(effectResult.exitCode, effectResult.stderr).toBe(legacyResult.exitCode);
      expect(effectResult.stdout).toBe(legacyResult.stdout);
      expect(effectResult.stderr).toBe(legacyResult.stderr);
    }
  });

  test("Effect read-only actions call reusable programs without delegating process ownership", () => {
    const commandSource = readFileSync(
      resolve(selftuneRoot, "apps/cli/src/effect-cli/commands/read-only.ts"),
      "utf8",
    );
    const statusSource = readFileSync(resolve(selftuneRoot, "packages/runtime/status.ts"), "utf8");
    const lastSource = readFileSync(resolve(selftuneRoot, "packages/runtime/last.ts"), "utf8");

    expect(commandSource).toContain("runStatusProgram");
    expect(commandSource).toContain("runLastProgram");
    expect(commandSource).not.toContain("cliMain");
    expect(commandSource).not.toContain("process.exit(");
    const statusProgramSource = statusSource.slice(
      statusSource.indexOf("export async function runStatusProgram"),
      statusSource.indexOf("export async function cliMain"),
    );
    const lastProgramSource = lastSource.slice(
      lastSource.indexOf("export function runLastProgram"),
      lastSource.indexOf("export function cliMain"),
    );
    expect(statusProgramSource).not.toContain("process.exit(");
    expect(lastProgramSource).not.toContain("process.exit(");
    expect(statusSource).toContain("process.exit(await runStatusProgram())");
    expect(lastSource).toContain("runLastProgram();\n  process.exit(0);");
  });

  test("Effect-owned help exits without running read-only command behavior", () => {
    for (const command of effectCommands) {
      const result = runCli(command, "--help");
      expect(result.exitCode, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("USAGE");
      expect(result.stdout).toContain(`selftune ${command} [flags]`);
    }
  });

  test("no-command status skips advisory and dashboard action-stream startup", () => {
    const mainSource = readFileSync(resolve(selftuneRoot, "apps/cli/src/main.ts"), "utf8");
    expect(readFastCommands(mainSource)).toEqual([
      "hook",
      "codex",
      "opencode",
      "cline",
      "pi",
      "daemon",
      "service",
      "mcp",
    ]);
    expect(mainSource.match(/!FAST_COMMANDS\.has\(command\)/g)).toHaveLength(2);
    expect(mainSource.match(/command !== "--help"/g)).toHaveLength(2);
    expect(mainSource.match(/command !== "-h"/g)).toHaveLength(2);

    const analytics = mainSource.indexOf('import("@selftune/runtime/analytics")');
    const update = mainSource.indexOf('import("@selftune/runtime/auto-update")');
    const defaultStatus = mainSource.indexOf("if (!internalCommand && !command)");
    const defaultEffectStatus = mainSource.indexOf('runEffectCliMain("status", [])');
    const dashboardActionStream = mainSource.indexOf(
      'import("@selftune/runtime/dashboard-action-stream")',
    );
    const hybridDispatch = mainSource.indexOf("if (isEffectCliInvocation");
    expect(analytics).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(analytics);
    expect(defaultStatus).toBeGreaterThan(update);
    expect(defaultEffectStatus).toBeGreaterThan(defaultStatus);
    expect(dashboardActionStream).toBeGreaterThan(defaultEffectStatus);
    expect(hybridDispatch).toBeGreaterThan(defaultStatus);
  });
});
