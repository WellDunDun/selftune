import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const CREATOR_CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG =
  "selftune-internal-creator-contributions-parent-help";
export const CREATOR_CONTRIBUTIONS_INTERNAL_STATUS_HELP_FLAG =
  "selftune-internal-creator-contributions-status-help";
export const CREATOR_CONTRIBUTIONS_INTERNAL_ENABLE_HELP_FLAG =
  "selftune-internal-creator-contributions-enable-help";
export const CREATOR_CONTRIBUTIONS_INTERNAL_DISABLE_HELP_FLAG =
  "selftune-internal-creator-contributions-disable-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodeCreatorContributionsInternalValue(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

function invalidArguments(cause: unknown, subcommand: string): never {
  if (cause instanceof CLIError) throw cause;
  throw new CLIError(
    `Invalid arguments: ${failureMessage(cause)}`,
    "INVALID_FLAG",
    `selftune creator-contributions ${subcommand} --help`,
  );
}

function prepareStatus(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) return [`--${CREATOR_CONTRIBUTIONS_INTERNAL_STATUS_HELP_FLAG}`];
    const normalized: string[] = [];
    appendValue(normalized, "--skill", values.skill);
    return normalized;
  } catch (cause) {
    return invalidArguments(cause, "status");
  }
}

function prepareEnable(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        all: { type: "boolean", default: false },
        prefix: { type: "string" },
        "skill-path": { type: "string" },
        "creator-id": { type: "string" },
        signals: { type: "string", default: "trigger,grade,miss_category" },
        message: { type: "string" },
        "privacy-url": { type: "string" },
        "feedback-endpoint": { type: "string" },
        "no-helper": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) return [`--${CREATOR_CONTRIBUTIONS_INTERNAL_ENABLE_HELP_FLAG}`];
    const normalized: string[] = [];
    appendValue(normalized, "--skill", values.skill);
    if (values.all) normalized.push("--all");
    appendValue(normalized, "--prefix", values.prefix);
    appendValue(normalized, "--skill-path", values["skill-path"]);
    appendValue(normalized, "--creator-id", values["creator-id"]);
    appendValue(normalized, "--signals", values.signals);
    appendValue(normalized, "--message", values.message);
    appendValue(normalized, "--privacy-url", values["privacy-url"]);
    appendValue(normalized, "--feedback-endpoint", values["feedback-endpoint"]);
    if (values["no-helper"]) normalized.push("--no-helper");
    return normalized;
  } catch (cause) {
    return invalidArguments(cause, "enable");
  }
}

function prepareDisable(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        "skill-path": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) return [`--${CREATOR_CONTRIBUTIONS_INTERNAL_DISABLE_HELP_FLAG}`];
    const normalized: string[] = [];
    appendValue(normalized, "--skill", values.skill);
    appendValue(normalized, "--skill-path", values["skill-path"]);
    return normalized;
  } catch (cause) {
    return invalidArguments(cause, "disable");
  }
}

export function prepareLegacyCreatorContributionsArguments(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") {
    return [`--${CREATOR_CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG}`];
  }

  switch (subcommand ?? "status") {
    case "status":
      return ["status", ...prepareStatus(rest)];
    case "enable":
      return ["enable", ...prepareEnable(rest)];
    case "disable":
      return ["disable", ...prepareDisable(rest)];
    default:
      throw new CLIError(
        `Unknown creator-contributions subcommand: ${subcommand}`,
        "UNKNOWN_COMMAND",
        "selftune creator-contributions --help",
      );
  }
}
