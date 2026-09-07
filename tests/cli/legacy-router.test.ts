import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import {
  getLegacyCommandGroup,
  LEGACY_COMMAND_GROUPS,
  LEGACY_COMMANDS,
  routeLegacyCommand,
  type LegacyCommandGroup,
  type LegacyCommandRouter,
  type LegacyRouterLoaders,
} from "../../apps/cli/src/commands/router.js";
import { FULLY_EFFECT_OWNED_COMMANDS } from "../../apps/cli/src/effect-cli/selection.js";

const legacyCommandGroups: ReadonlyArray<LegacyCommandGroup> = [
  "lifecycle",
  "operations",
  "harnesses",
];
const legacyRouterSourcePaths: Readonly<Record<LegacyCommandGroup, string>> = {
  lifecycle: "../../apps/cli/src/commands/lifecycle.ts",
  operations: "../../apps/cli/src/commands/operations.ts",
  harnesses: "../../apps/cli/src/commands/harnesses.ts",
};
function readLegacyRouterCommands(group: LegacyCommandGroup): ReadonlyArray<string> {
  const sourcePath = resolve(import.meta.dir, legacyRouterSourcePaths[group]);
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const commands: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isSwitchStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "command"
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          commands.push(clause.expression.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return commands;
}

function makeRecordingLoaders(loaded: LegacyCommandGroup[]): LegacyRouterLoaders {
  const makeLoader =
    (group: LegacyCommandGroup): (() => Promise<LegacyCommandRouter>) =>
    async () => {
      loaded.push(group);
      return async () => true;
    };
  return {
    lifecycle: makeLoader("lifecycle"),
    operations: makeLoader("operations"),
    harnesses: makeLoader("harnesses"),
  };
}

describe("legacy CLI router", () => {
  test("maps every legacy command to exactly one group", () => {
    const seen = new Set<string>();
    for (const group of legacyCommandGroups) {
      for (const command of LEGACY_COMMAND_GROUPS[group]) {
        expect(seen.has(command), `duplicate legacy command: ${command}`).toBe(false);
        seen.add(command);
        expect(getLegacyCommandGroup(command)).toBe(group);
      }
    }
    expect([...seen]).toEqual([...LEGACY_COMMANDS]);
  });

  test("matches every legacy registry group to its router switch cases", () => {
    for (const group of legacyCommandGroups) {
      expect(readLegacyRouterCommands(group)).toEqual(LEGACY_COMMAND_GROUPS[group]);
    }
  });

  test("keeps fully Effect-owned commands out of legacy router implementations", () => {
    const routedCommands = new Set(legacyCommandGroups.flatMap(readLegacyRouterCommands));
    for (const command of FULLY_EFFECT_OWNED_COMMANDS) {
      expect(
        routedCommands.has(command),
        `legacy route remains for Effect command: ${command}`,
      ).toBe(false);
    }
  });

  test("keeps fully Effect-owned commands out of the legacy registry", async () => {
    await Promise.all(
      FULLY_EFFECT_OWNED_COMMANDS.map(async (command) => {
        const loaded: LegacyCommandGroup[] = [];
        expect(getLegacyCommandGroup(command)).toBeUndefined();
        expect(await routeLegacyCommand(command, makeRecordingLoaders(loaded))).toBe(false);
        expect(loaded).toEqual([]);
      }),
    );
  });

  test("loads only the router group selected for a legacy command", async () => {
    await Promise.all(
      legacyCommandGroups.flatMap((group) =>
        LEGACY_COMMAND_GROUPS[group].map(async (command) => {
          const loaded: LegacyCommandGroup[] = [];
          expect(await routeLegacyCommand(command, makeRecordingLoaders(loaded))).toBe(true);
          expect(loaded).toEqual([group]);
        }),
      ),
    );
  });

  test("unknown commands do not load a router", async () => {
    const loaded: LegacyCommandGroup[] = [];
    expect(await routeLegacyCommand("not-a-command", makeRecordingLoaders(loaded))).toBe(false);
    expect(loaded).toEqual([]);
  });

  test("main has no static imports of legacy router implementations", () => {
    const mainPath = resolve(import.meta.dir, "../../apps/cli/src/main.ts");
    const source = readFileSync(mainPath, "utf8");
    const sourceFile = ts.createSourceFile(
      mainPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const imports = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text);

    expect(imports).not.toContain("./commands/lifecycle.js");
    expect(imports).not.toContain("./commands/operations.js");
    expect(imports).not.toContain("./commands/harnesses.js");
    expect(source).toContain('await import("./commands/router.js")');
  });
});
