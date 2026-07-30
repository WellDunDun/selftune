import * as Effect from "effect/Effect";

import { CLIError } from "@selftune/runtime/utils/cli-error";

import { prepareLegacyBadgeArguments } from "./compatibility/badge.js";
import { prepareLegacyContributeArguments } from "./compatibility/contribute.js";
import { prepareLegacyContributionsArguments } from "./compatibility/contributions.js";
import { prepareLegacyCreatorContributionsArguments } from "./compatibility/creator-contributions.js";
import { prepareLegacyCreateArguments } from "./compatibility/create.js";
import { prepareLegacyExportArguments } from "./compatibility/export.js";
import { prepareLegacyLibraryArguments } from "./compatibility/library.js";
import { prepareLegacyPublishArguments } from "./compatibility/publish.js";
import { prepareLegacyRecoverArguments } from "./compatibility/recover.js";
import { prepareLegacyRegistryArguments } from "./compatibility/registry.js";
import { prepareLegacySkillsArguments } from "./compatibility/skills.js";
import { prepareLegacySetsArguments } from "./compatibility/sets.js";
import { prepareLegacyVerifyArguments } from "./compatibility/verify.js";
import { prepareLegacyWorkflowsArguments } from "./compatibility/workflows.js";
import { prepareLegacySyncArguments, SyncLegacyParseFailure } from "./compatibility/sync.js";
import { prepareLegacyWatchArguments, WatchLegacyParseFailure } from "./compatibility/watch.js";
import { UNINSTALL_INTERNAL_HELP_FLAG } from "./commands/uninstall.js";

interface ValueFlagSpec {
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly normalizedName?: string;
}

const VALUE_FLAGS_BY_COMMAND: ReadonlyMap<string, ReadonlyArray<ValueFlagSpec>> = new Map([
  ["badge", [{ name: "--skill" }, { name: "--format" }, { name: "--output" }]],
  [
    "recover",
    [
      { name: "--since" },
      { name: "--canonical-log" },
      { name: "--telemetry-log" },
      { name: "--evolution-audit-log" },
      { name: "--evolution-evidence-log" },
      { name: "--orchestrate-run-log" },
    ],
  ],
  ["export", [{ name: "--output", aliases: ["-o"] }, { name: "--since" }]],
  ["dashboard", [{ name: "--port" }]],
  [
    "daemon",
    [
      { name: "--port" },
      { name: "--hostname" },
      { name: "--config-dir" },
      { name: "--spa-dir" },
      { name: "--owner" },
      { name: "--runtime-mode" },
      { name: "--service-installation-nonce" },
      { name: "--expected-pid" },
      { name: "--expected-instance-id" },
    ],
  ],
  [
    "service",
    [
      { name: "--port" },
      { name: "--config-dir" },
      { name: "--owner" },
      { name: "--executable" },
      { name: "--resource-dir" },
      { name: "--service-version" },
      { name: "--version", normalizedName: "--service-version" },
    ],
  ],
]);

const ARGUMENT_FREE_COMMANDS: ReadonlySet<string> = new Set([
  "doctor",
  "status",
  "last",
  "quickstart",
]);
const GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "--version"]);
const GLOBAL_VALUE_CHOICES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["--completions", new Set(["bash", "zsh", "fish", "sh"])],
  [
    "--log-level",
    new Set(["all", "trace", "debug", "info", "warn", "warning", "error", "fatal", "none"]),
  ],
]);

function findExactSpec(
  specs: ReadonlyArray<ValueFlagSpec>,
  token: string,
): ValueFlagSpec | undefined {
  return specs.find((spec) => spec.name === token || spec.aliases?.includes(token));
}

function findAttachedShortValue(
  specs: ReadonlyArray<ValueFlagSpec>,
  token: string,
): { readonly alias: string; readonly value: string } | undefined {
  if (token.startsWith("--")) return undefined;
  for (const spec of specs) {
    for (const alias of spec.aliases ?? []) {
      if (token.startsWith(alias) && token.length > alias.length) {
        return { alias, value: token.slice(alias.length) };
      }
    }
  }
  return undefined;
}

function findAttachedNormalizedLongValue(
  specs: ReadonlyArray<ValueFlagSpec>,
  token: string,
): { readonly name: string; readonly value: string } | undefined {
  for (const spec of specs) {
    if (!spec.normalizedName) continue;
    const prefix = `${spec.name}=`;
    if (token.startsWith(prefix)) {
      return { name: spec.normalizedName, value: token.slice(prefix.length) };
    }
  }
  return undefined;
}

function normalizeCommandArguments(
  command: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const specs = VALUE_FLAGS_BY_COMMAND.get(command);
  if (!specs) return args;

  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      normalized.push(...args.slice(index));
      break;
    }

    const exactSpec = findExactSpec(specs, token);
    if (exactSpec) {
      const value = args[index + 1];
      if (value === undefined || (value !== "-" && value.startsWith("-"))) {
        throw new CLIError(
          `Invalid arguments: Option '${token} <value>' argument missing`,
          "INVALID_FLAG",
          `selftune ${command} --help`,
        );
      }
      normalized.push(exactSpec.normalizedName ?? token, value);
      index += 1;
      continue;
    }

    const attachedLong = findAttachedNormalizedLongValue(specs, token);
    if (attachedLong) {
      if (attachedLong.value.length === 0) {
        throw new CLIError(
          `Invalid arguments: Option '${token.slice(0, token.indexOf("="))} <value>' argument missing`,
          "INVALID_FLAG",
          `selftune ${command} --help`,
        );
      }
      normalized.push(attachedLong.name, attachedLong.value);
      continue;
    }

    const attached = findAttachedShortValue(specs, token);
    if (attached) {
      normalized.push(attached.alias, attached.value);
      continue;
    }

    normalized.push(token);
  }
  return normalized;
}

function rejectRemovedDashboardModes(args: ReadonlyArray<string>): void {
  if (!args.includes("--export") && !args.includes("--out")) return;
  throw new CLIError(
    "Legacy dashboard export was removed.",
    "INVALID_FLAG",
    "Use `selftune dashboard` to run the SPA locally, then share a route or screenshot instead.",
  );
}

function rejectDaemonAuthToken(args: ReadonlyArray<string>): void {
  if (
    !args.some((argument) => argument === "--auth-token" || argument.startsWith("--auth-token="))
  ) {
    return;
  }
  throw new CLIError(
    "--auth-token is not supported because process arguments are observable. Use the owner-only local auth file.",
    "INVALID_FLAG",
    "selftune daemon --help",
  );
}

function invalidAlphaArguments(message: string, suggestion: string): never {
  throw new CLIError(`Invalid arguments: ${message}`, "INVALID_FLAG", suggestion);
}

function validateAlphaLeafArguments(
  subcommand: "upload" | "relink",
  args: ReadonlyArray<string>,
): void {
  const allowed =
    subcommand === "upload" ? new Set(["--dry-run", "--help", "-h"]) : new Set(["--help", "-h"]);
  for (const argument of args) {
    if (allowed.has(argument)) continue;
    if (subcommand === "upload" && argument.startsWith("--dry-run=")) {
      invalidAlphaArguments(
        "Option '--dry-run' does not take an argument",
        "selftune alpha upload --help",
      );
    }
    const message = argument.startsWith("-")
      ? `Unknown option '${argument}'`
      : `Unexpected argument '${argument}'. This command does not take positional arguments`;
    invalidAlphaArguments(message, `selftune alpha ${subcommand} --help`);
  }
}

function validateAlphaArguments(args: ReadonlyArray<string>): void {
  const [subcommand, ...subcommandArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") return;
  if (subcommand === "upload" || subcommand === "relink") {
    validateAlphaLeafArguments(subcommand, subcommandArgs);
    return;
  }
  throw new CLIError(
    `Unknown alpha subcommand: ${subcommand}`,
    "UNKNOWN_COMMAND",
    "selftune alpha --help",
  );
}

const UNINSTALL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--dry-run",
  "--help",
  "--keep-logs",
  "--npm-uninstall",
]);

function invalidUninstallArguments(message: string): never {
  throw new CLIError(`Invalid arguments: ${message}`, "INVALID_FLAG", "selftune uninstall --help");
}

function validateUninstallArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let optionsEnded = false;
  for (const argument of args) {
    if (optionsEnded) {
      invalidUninstallArguments(
        `Unexpected argument '${argument}'. This command does not take positional arguments`,
      );
    }
    if (argument === "--") {
      optionsEnded = true;
      continue;
    }
    for (const flag of UNINSTALL_BOOLEAN_FLAGS) {
      if (argument.startsWith(`${flag}=`)) {
        invalidUninstallArguments(`Option '${flag}' does not take an argument`);
      }
    }
    if (UNINSTALL_BOOLEAN_FLAGS.has(argument)) continue;

    invalidUninstallArguments(
      argument.startsWith("-")
        ? `Unknown option '${argument}'`
        : `Unexpected argument '${argument}'. This command does not take positional arguments`,
    );
  }
  return args.map((argument) =>
    argument === "--help" ? `--${UNINSTALL_INTERNAL_HELP_FLAG}` : argument,
  );
}

interface EvalLeafSpec {
  readonly booleans: ReadonlySet<string>;
  readonly values: ReadonlySet<string>;
}

const EVAL_LEAF_SPECS: ReadonlyMap<string, EvalLeafSpec> = new Map([
  [
    "generate",
    {
      booleans: new Set([
        "--list-skills",
        "--stats",
        "--no-negatives",
        "--no-taxonomy",
        "--synthetic",
        "--auto-synthetic",
        "--blend",
      ]),
      values: new Set([
        "--skill",
        "--output",
        "--out",
        "--agent",
        "--max",
        "--seed",
        "--skill-log",
        "--query-log",
        "--telemetry-log",
        "--skill-path",
        "--model",
      ]),
    },
  ],
  [
    "unit-test",
    {
      booleans: new Set(["--run-agent", "--generate"]),
      values: new Set(["--skill", "--tests", "--skill-path", "--eval-set", "--model"]),
    },
  ],
  [
    "import",
    {
      booleans: new Set(),
      values: new Set(["--dir", "--skill", "--output", "--match-strategy"]),
    },
  ],
  [
    "composability",
    {
      booleans: new Set(),
      values: new Set(["--skill", "--window", "--telemetry-log"]),
    },
  ],
  [
    "family-overlap",
    {
      booleans: new Set(),
      values: new Set(["--prefix", "--skills", "--parent-skill", "--min-overlap", "--min-shared"]),
    },
  ],
]);

function invalidEvalArguments(action: string | undefined, message: string): never {
  const command = action ? `selftune eval ${action}` : "selftune eval";
  throw new CLIError(`Invalid arguments: ${message}`, "INVALID_FLAG", `${command} --help`);
}

function validateEvalNumericValue(action: string, flag: string, value: string): void {
  if (action === "generate" && flag === "--max") {
    const parsed = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
      invalidEvalArguments(action, "Invalid --max value. Use a positive integer");
    }
  }
  if (action === "generate" && flag === "--seed") {
    const parsed = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
      invalidEvalArguments(action, "Invalid --seed value. Use an integer");
    }
  }
  if (
    action === "generate" &&
    flag === "--agent" &&
    value !== "claude" &&
    value !== "codex" &&
    value !== "opencode" &&
    value !== "pi"
  ) {
    invalidEvalArguments(action, "Invalid --agent value. Use claude, codex, opencode, or pi");
  }
  if (action === "composability" && flag === "--window") {
    const parsed = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
      invalidEvalArguments(
        action,
        "Invalid --window value. Use a positive integer number of sessions within the safe integer range.",
      );
    }
  }
  if (action === "family-overlap" && flag === "--min-overlap") {
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value) || Number(value) <= 0) {
      invalidEvalArguments(action, "Invalid --min-overlap value. Use a number between 0 and 1");
    }
  }
  if (action === "family-overlap" && flag === "--min-shared") {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      invalidEvalArguments(action, "Invalid --min-shared value. Use a positive integer");
    }
  }
  if (
    action === "import" &&
    flag === "--match-strategy" &&
    value !== "exact" &&
    value !== "fuzzy"
  ) {
    invalidEvalArguments(action, "Invalid --match-strategy value. Use exact or fuzzy");
  }
}

function validateEvalLeafArguments(action: string, args: ReadonlyArray<string>): void {
  const spec = EVAL_LEAF_SPECS.get(action);
  if (!spec) {
    throw new CLIError(`Unknown eval action: ${action}`, "UNKNOWN_COMMAND", "selftune eval --help");
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      if (index === args.length - 1) continue;
      invalidEvalArguments(
        action,
        `Unexpected argument '${args[index + 1]}'. This command does not take positional arguments`,
      );
    }
    if (GLOBAL_BOOLEAN_FLAGS.has(argument)) continue;

    for (const booleanFlag of spec.booleans) {
      if (argument === `${booleanFlag}=true` || argument === `${booleanFlag}=false`) {
        invalidEvalArguments(action, `Option '${booleanFlag}' does not take an argument`);
      }
      if (argument === `--no-${booleanFlag.slice(2)}`) {
        invalidEvalArguments(action, `Unknown option '${argument}'`);
      }
    }
    if (spec.booleans.has(argument)) {
      const next = args[index + 1];
      if (next === "true" || next === "false") {
        invalidEvalArguments(
          action,
          `Unexpected argument '${next}'. Option '${argument}' does not take an argument`,
        );
      }
      continue;
    }

    let matchedValue = false;
    for (const flag of spec.values) {
      const attachedPrefix = `${flag}=`;
      const attached = argument.startsWith(attachedPrefix);
      if (argument !== flag && !attached) continue;
      const value = attached ? argument.slice(attachedPrefix.length) : args[index + 1];
      if (!attached) index += 1;
      if (!value || value === "--" || (!attached && value !== "-" && value.startsWith("-"))) {
        invalidEvalArguments(action, `Option '${flag} <value>' argument missing`);
      }
      validateEvalNumericValue(action, flag, value);
      matchedValue = true;
      break;
    }
    if (matchedValue) continue;

    let matchedGlobalValue = false;
    for (const [flag, choices] of GLOBAL_VALUE_CHOICES) {
      const attachedPrefix = `${flag}=`;
      const attached = argument.startsWith(attachedPrefix);
      if (argument !== flag && !attached) continue;
      const value = attached ? argument.slice(attachedPrefix.length) : args[index + 1];
      if (!attached) index += 1;
      if (!value || value.startsWith("-")) {
        invalidEvalArguments(action, `Option '${flag} <value>' argument missing`);
      }
      if (!choices.has(value))
        invalidEvalArguments(action, `Invalid value '${value}' for '${flag}'`);
      matchedGlobalValue = true;
      break;
    }
    if (matchedGlobalValue) continue;

    invalidEvalArguments(
      action,
      argument.startsWith("-")
        ? `Unknown option '${argument}'`
        : `Unexpected argument '${argument}'. This command does not take positional arguments`,
    );
  }
}

function validateEvalArguments(args: ReadonlyArray<string>): void {
  const [action, ...actionArgs] = args;
  if (!action) return;
  if (
    GLOBAL_BOOLEAN_FLAGS.has(action) ||
    [...GLOBAL_VALUE_CHOICES.keys()].some(
      (flag) => action === flag || action.startsWith(`${flag}=`),
    )
  ) {
    validateArgumentFreeCommand("eval", args);
    return;
  }
  if (action.startsWith("-")) invalidEvalArguments(undefined, `Unknown option '${action}'`);
  validateEvalLeafArguments(action, actionArgs);
}

function invalidArgumentFreeCommand(command: string, message: string): never {
  throw new CLIError(`Invalid arguments: ${message}`, "INVALID_FLAG", `selftune ${command} --help`);
}

function validateArgumentFreeCommand(command: string, args: ReadonlyArray<string>): void {
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (optionsEnded) {
      invalidArgumentFreeCommand(
        command,
        `Unexpected argument '${argument}'. This command does not take positional arguments`,
      );
    }
    if (argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (GLOBAL_BOOLEAN_FLAGS.has(argument)) {
      continue;
    }

    let matchedValueFlag = false;
    for (const [flag, choices] of GLOBAL_VALUE_CHOICES) {
      const attachedPrefix = `${flag}=`;
      const isAttached = argument.startsWith(attachedPrefix);
      if (argument !== flag && !isAttached) continue;

      const value = isAttached ? argument.slice(attachedPrefix.length) : args[index + 1];
      if (!isAttached) index += 1;
      if (!value || value.startsWith("-")) {
        invalidArgumentFreeCommand(command, `Option '${flag} <value>' argument missing`);
      }
      if (!choices.has(value)) {
        invalidArgumentFreeCommand(command, `Invalid value '${value}' for option '${flag}'`);
      }
      matchedValueFlag = true;
      break;
    }
    if (matchedValueFlag) continue;

    invalidArgumentFreeCommand(
      command,
      argument.startsWith("-")
        ? `Unknown option '${argument}'`
        : `Unexpected argument '${argument}'. This command does not take positional arguments`,
    );
  }
}

export const prepareEffectCliArguments = Effect.fn("selftune.cli.prepareArguments")(function* (
  args: ReadonlyArray<string>,
) {
  const [command, ...commandArgs] = args;
  if (!command) return args;
  if (
    (command === "dashboard" || command === "daemon" || command === "service") &&
    (commandArgs.includes("--help") || commandArgs.includes("-h"))
  ) {
    return args;
  }

  const normalized = yield* Effect.try({
    try: () => {
      if (command === "dashboard") rejectRemovedDashboardModes(commandArgs);
      if (command === "daemon") rejectDaemonAuthToken(commandArgs);
      if (command === "alpha") validateAlphaArguments(commandArgs);
      if (command === "eval") validateEvalArguments(commandArgs);
      const compatibleArgs =
        command === "watch"
          ? prepareLegacyWatchArguments(commandArgs)
          : command === "sync"
            ? prepareLegacySyncArguments(commandArgs)
            : command === "registry"
              ? prepareLegacyRegistryArguments(commandArgs)
              : command === "workflows"
                ? prepareLegacyWorkflowsArguments(commandArgs)
                : command === "library"
                  ? prepareLegacyLibraryArguments(commandArgs)
                  : command === "sets"
                    ? prepareLegacySetsArguments(commandArgs)
                    : command === "skills"
                      ? prepareLegacySkillsArguments(commandArgs)
                      : command === "creator-contributions"
                        ? prepareLegacyCreatorContributionsArguments(commandArgs)
                        : command === "contributions"
                          ? prepareLegacyContributionsArguments(commandArgs)
                          : command === "contribute"
                            ? prepareLegacyContributeArguments(commandArgs)
                            : command === "publish"
                              ? prepareLegacyPublishArguments(commandArgs)
                              : command === "create"
                                ? prepareLegacyCreateArguments(commandArgs)
                                : command === "uninstall"
                                  ? validateUninstallArguments(commandArgs)
                                  : command === "badge"
                                    ? prepareLegacyBadgeArguments(commandArgs)
                                    : command === "export"
                                      ? prepareLegacyExportArguments(commandArgs)
                                      : command === "recover"
                                        ? prepareLegacyRecoverArguments(commandArgs)
                                        : command === "verify"
                                          ? prepareLegacyVerifyArguments(commandArgs)
                                          : commandArgs;
      if (ARGUMENT_FREE_COMMANDS.has(command)) {
        validateArgumentFreeCommand(command, commandArgs);
      }
      return normalizeCommandArguments(command, compatibleArgs);
    },
    catch: (cause) =>
      cause instanceof CLIError ||
      cause instanceof SyncLegacyParseFailure ||
      cause instanceof WatchLegacyParseFailure
        ? cause
        : new CLIError(
            `Invalid arguments: ${cause instanceof Error ? cause.message : String(cause)}`,
            "INVALID_FLAG",
            `selftune ${command} --help`,
          ),
  });
  return [command, ...normalized];
});
