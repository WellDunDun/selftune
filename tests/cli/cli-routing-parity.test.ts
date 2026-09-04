import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { LEGACY_COMMANDS } from "../../apps/cli/src/commands/router.js";
import { FULLY_EFFECT_OWNED_COMMANDS } from "../../apps/cli/src/effect-cli/selection.js";

const selftuneRoot = resolve(import.meta.dir, "../..");

const documentedTopLevelCommands = [
  "status",
  "skills",
  "library",
  "sets",
  "verify",
  "publish",
  "improve",
  "run",
  "create",
  "dashboard",
  "daemon",
  "service",
  "mcp",
  "evolve",
  "search-run",
  "eval",
  "grade",
  "watch",
  "sync",
  "orchestrate",
  "ingest",
  "init",
  "uninstall",
  "doctor",
  "last",
  "cron",
  "badge",
  "contribute",
  "contributions",
  "creator-contributions",
  "workflows",
  "quickstart",
  "repair-skill-usage",
  "export",
  "export-canonical",
  "recover",
  "registry",
  "team",
  "alpha",
  "telemetry",
  "hook",
  "codex",
  "opencode",
  "cline",
  "pi",
] as const;

const groupedHelpFixtures = [
  { command: "ingest", markers: ["Supported agents:", "wrap-codex"] },
  { command: "grade", markers: ["grade auto", "grade baseline"] },
  { command: "evolve", markers: ["evolve body", "evolve rollback", "apply-proposal"] },
  { command: "eval", markers: ["Actions:", "composability", "family-overlap"] },
  { command: "create", markers: ["Subcommands:", "replay", "publish"] },
  { command: "cron", markers: ["cron <subcommand>", "setup", "remove"] },
  { command: "registry", markers: ["registry <subcommand>", "push", "install", "rollback"] },
  { command: "team", markers: ["publish|assign|status|contribute|promote|deprecate|rollback"] },
  { command: "alpha", markers: ["SUBCOMMANDS", "upload", "relink"] },
  { command: "codex", markers: ["Codex platform hooks", "hook", "install"] },
  { command: "opencode", markers: ["OpenCode platform hooks", "hook", "install"] },
  { command: "cline", markers: ["Cline platform hooks", "hook", "install"] },
  { command: "pi", markers: ["Pi platform hooks", "hook", "install"] },
] as const;

function runCli(...args: string[]): string {
  const result = Bun.spawnSync(["bun", "apps/cli/src/main.ts", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      CI: "1",
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8");
  const stderr = Buffer.from(result.stderr).toString("utf8");
  expect(result.exitCode, `${args.join(" ")} failed:\n${stdout}\n${stderr}`).toBe(0);
  return stdout;
}

function extractDocumentedCommands(help: string): string[] {
  return help
    .split("\n")
    .filter((line) => /^  [a-z][a-z-]+(?:\s|$)/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]!)
    .filter((command) => command !== "selftune");
}

function extractRegisteredCommands(): Set<string> {
  const commands = new Set(LEGACY_COMMANDS);
  for (const command of FULLY_EFFECT_OWNED_COMMANDS) commands.add(command);
  commands.add("mcp");
  return commands;
}

describe("CLI routing parity", () => {
  test("every command in top-level help remains represented in the route map", () => {
    const helpCommands = extractDocumentedCommands(runCli("--help"));
    expect(helpCommands).toEqual(documentedTopLevelCommands);

    const routedCommands = extractRegisteredCommands();
    for (const command of documentedTopLevelCommands) {
      expect(routedCommands.has(command), `missing route for documented command: ${command}`).toBe(
        true,
      );
    }
  });

  test("every fully Effect-owned command is attached to the executable root", () => {
    for (const command of FULLY_EFFECT_OWNED_COMMANDS) {
      expect(runCli(command, "--help")).toContain(`selftune ${command}`);
    }
  }, 30_000);

  for (const fixture of groupedHelpFixtures) {
    test(`${fixture.command} dispatches to its grouped help surface`, () => {
      const help = runCli(fixture.command, "--help");
      for (const marker of fixture.markers) expect(help).toContain(marker);
    });
  }
});
