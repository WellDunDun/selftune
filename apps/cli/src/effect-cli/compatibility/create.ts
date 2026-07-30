import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const CREATE_INTERNAL_HELP_FLAG = "selftune-internal-create-help";
export const CREATE_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-create-parent-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

function finish(
  subcommand: string,
  help: boolean,
  normalized: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return help ? [subcommand, `--${CREATE_INTERNAL_HELP_FLAG}`] : [subcommand, ...normalized];
}

function normalizeLeaf(subcommand: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  switch (subcommand) {
    case "init": {
      const { values } = parseArgs({
        args,
        options: {
          name: { type: "string" },
          description: { type: "string" },
          "output-dir": { type: "string" },
          force: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--name", values.name);
      appendStringValue(normalized, "--description", values.description);
      appendStringValue(normalized, "--output-dir", values["output-dir"]);
      if (values.force) normalized.push("--force");
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    case "status":
    case "check": {
      const { values } = parseArgs({
        args,
        options: {
          "skill-path": { type: "string" },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--skill-path", values["skill-path"]);
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    case "scaffold": {
      const { values } = parseArgs({
        args,
        options: {
          "from-workflow": { type: "string" },
          "output-dir": { type: "string" },
          "skill-name": { type: "string" },
          description: { type: "string" },
          write: { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          "min-occurrences": { type: "string" },
          skill: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--from-workflow", values["from-workflow"]);
      appendStringValue(normalized, "--output-dir", values["output-dir"]);
      appendStringValue(normalized, "--skill-name", values["skill-name"]);
      appendStringValue(normalized, "--description", values.description);
      appendStringValue(normalized, "--min-occurrences", values["min-occurrences"]);
      appendStringValue(normalized, "--skill", values.skill);
      if (values.write) normalized.push("--write");
      if (values.force) normalized.push("--force");
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    case "replay":
    case "baseline": {
      const { values } = parseArgs({
        args,
        options: {
          "skill-path": { type: "string" },
          mode: { type: "string", default: "routing" },
          agent: { type: "string" },
          "eval-set": { type: "string" },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--skill-path", values["skill-path"]);
      appendStringValue(normalized, "--mode", values.mode);
      appendStringValue(normalized, "--agent", values.agent);
      appendStringValue(normalized, "--eval-set", values["eval-set"]);
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    case "report": {
      const { values } = parseArgs({
        args,
        options: {
          "skill-path": { type: "string" },
          agent: { type: "string" },
          "eval-set": { type: "string" },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--skill-path", values["skill-path"]);
      appendStringValue(normalized, "--agent", values.agent);
      appendStringValue(normalized, "--eval-set", values["eval-set"]);
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    case "publish": {
      const { values } = parseArgs({
        args,
        options: {
          "skill-path": { type: "string" },
          watch: { type: "boolean", default: false },
          "ignore-watch-alerts": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      const normalized: string[] = [];
      appendStringValue(normalized, "--skill-path", values["skill-path"]);
      if (values.watch) normalized.push("--watch");
      if (values["ignore-watch-alerts"]) normalized.push("--ignore-watch-alerts");
      if (values.json) normalized.push("--json");
      return finish(subcommand, values.help, normalized);
    }
    default:
      throw new CLIError(
        `Unknown create subcommand: ${subcommand}`,
        "UNKNOWN_COMMAND",
        "selftune create --help",
      );
  }
}

export function decodeCreateInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyCreateArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const [subcommand, ...leafArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return [`--${CREATE_INTERNAL_PARENT_HELP_FLAG}`];
  }
  try {
    return normalizeLeaf(subcommand, leafArgs);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      `selftune create ${subcommand} --help`,
    );
  }
}
