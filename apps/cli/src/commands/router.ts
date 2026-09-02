import { FULLY_EFFECT_OWNED_COMMANDS } from "../effect-cli/selection.js";

export type LegacyCommandGroup = "lifecycle" | "operations" | "harnesses";

export const LEGACY_COMMAND_GROUPS: Readonly<Record<LegacyCommandGroup, ReadonlyArray<string>>> = {
  lifecycle: ["ingest", "grade", "evolve", "improve", "search-run"],
  operations: [
    "init",
    "cron",
    "schedule",
    "repair-skill-usage",
    "export-canonical",
    "orchestrate",
    "run",
    "team",
  ],
  harnesses: ["hook", "codex", "opencode", "cline", "pi"],
};

export type LegacyCommandRouter = (command: string) => Promise<boolean>;

export interface LegacyRouterLoaders {
  readonly lifecycle: () => Promise<LegacyCommandRouter>;
  readonly operations: () => Promise<LegacyCommandRouter>;
  readonly harnesses: () => Promise<LegacyCommandRouter>;
}

const fullyEffectOwnedCommands: ReadonlySet<string> = new Set(FULLY_EFFECT_OWNED_COMMANDS);
const commandGroups = new Map<string, LegacyCommandGroup>();

function registerLegacyCommands(group: LegacyCommandGroup, commands: ReadonlyArray<string>): void {
  for (const command of commands) {
    if (fullyEffectOwnedCommands.has(command)) {
      throw new Error(`Effect-owned command cannot be registered as legacy: ${command}`);
    }
    const existingGroup = commandGroups.get(command);
    if (existingGroup) {
      throw new Error(
        `Legacy command ${command} is registered by both ${existingGroup} and ${group}`,
      );
    }
    commandGroups.set(command, group);
  }
}

registerLegacyCommands("lifecycle", LEGACY_COMMAND_GROUPS.lifecycle);
registerLegacyCommands("operations", LEGACY_COMMAND_GROUPS.operations);
registerLegacyCommands("harnesses", LEGACY_COMMAND_GROUPS.harnesses);

export const LEGACY_COMMANDS: ReadonlyArray<string> = [...commandGroups.keys()];

export function getLegacyCommandGroup(command: string): LegacyCommandGroup | undefined {
  return commandGroups.get(command);
}

const liveLegacyRouterLoaders: LegacyRouterLoaders = {
  lifecycle: async () => (await import("./lifecycle.js")).routeLifecycleCommand,
  operations: async () => (await import("./operations.js")).routeOperationsCommand,
  harnesses: async () => (await import("./harnesses.js")).routeHarnessCommand,
};

export async function routeLegacyCommand(
  command: string,
  loaders: LegacyRouterLoaders = liveLegacyRouterLoaders,
): Promise<boolean> {
  const group = getLegacyCommandGroup(command);
  if (!group) return false;
  const route = await loaders[group]();
  return route(command);
}
