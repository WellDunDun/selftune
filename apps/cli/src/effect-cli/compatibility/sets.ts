import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const SETS_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-sets-parent-help";
export const SETS_INTERNAL_HELP_FLAG = "selftune-internal-sets-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

function appendValues(target: string[], flag: string, values: ReadonlyArray<string>): void {
  for (const value of values) appendValue(target, flag, value);
}

function positiveInteger(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CLIError(`${flag} must be a positive integer.`, "INVALID_FLAG");
  }
  return String(parsed);
}

function ratio(
  value: string | undefined,
  flag: string,
  minimum = 0,
  maximum = 1,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new CLIError(`${flag} must be between ${minimum} and ${maximum}.`, "INVALID_FLAG");
  }
  return String(parsed);
}

function finish(
  subcommand: string,
  help: boolean,
  normalized: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return help ? [subcommand, `--${SETS_INTERNAL_HELP_FLAG}`] : [subcommand, ...normalized];
}

export function decodeSetsInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

function prepareListLike(
  subcommand: "list" | "receipts" | "outcomes",
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  if (values.json) normalized.push("--json");
  return finish(subcommand, values.help, normalized);
}

function prepareSuggest(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      "min-occurrences": { type: "string" },
      "min-affinity": { type: "string" },
      "holdout-ratio": { type: "string" },
      "min-validation-occurrences": { type: "string" },
      "min-evidence-score": { type: "string" },
      max: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) return ["suggest", `--${SETS_INTERNAL_HELP_FLAG}`];
  const normalized: string[] = [];
  appendValue(
    normalized,
    "--min-occurrences",
    positiveInteger(values["min-occurrences"], "--min-occurrences"),
  );
  appendValue(normalized, "--min-affinity", ratio(values["min-affinity"], "--min-affinity"));
  appendValue(
    normalized,
    "--holdout-ratio",
    ratio(values["holdout-ratio"], "--holdout-ratio", 0.1, 0.5),
  );
  appendValue(
    normalized,
    "--min-validation-occurrences",
    positiveInteger(values["min-validation-occurrences"], "--min-validation-occurrences"),
  );
  appendValue(
    normalized,
    "--min-evidence-score",
    ratio(values["min-evidence-score"], "--min-evidence-score"),
  );
  appendValue(normalized, "--max", positiveInteger(values.max, "--max"));
  if (values.json) normalized.push("--json");
  return ["suggest", ...normalized];
}

function prepareCreate(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      harness: { type: "string", multiple: true },
      "skill-path": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--name", values.name);
  appendValue(normalized, "--description", values.description);
  appendValues(normalized, "--harness", values.harness ?? []);
  appendValues(normalized, "--skill-path", values["skill-path"] ?? []);
  if (values.json) normalized.push("--json");
  return finish("create", values.help, normalized);
}

function prepareUpdate(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      set: { type: "string" },
      "parent-revision": { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      harness: { type: "string", multiple: true },
      "skill-path": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--set", values.set);
  appendValue(normalized, "--parent-revision", values["parent-revision"]);
  appendValue(normalized, "--name", values.name);
  appendValue(normalized, "--description", values.description);
  appendValues(normalized, "--harness", values.harness ?? []);
  appendValues(normalized, "--skill-path", values["skill-path"] ?? []);
  if (values.json) normalized.push("--json");
  return ["update", ...normalized];
}

function prepareCapture(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      project: { type: "string" },
      harness: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--name", values.name);
  appendValue(normalized, "--description", values.description);
  appendValue(normalized, "--project", values.project);
  appendValues(normalized, "--harness", values.harness ?? []);
  if (values.json) normalized.push("--json");
  return finish("capture", values.help, normalized);
}

function prepareDerive(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      project: { type: "string" },
      harness: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--name", values.name);
  appendValue(normalized, "--description", values.description);
  appendValue(normalized, "--project", values.project);
  appendValues(normalized, "--harness", values.harness ?? []);
  if (values.json) normalized.push("--json");
  return ["derive", ...normalized];
}

function prepareHistory(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      set: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--set", values.set);
  if (values.json) normalized.push("--json");
  return ["history", ...normalized];
}

function prepareExport(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      set: { type: "string" },
      project: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--set", values.set);
  appendValue(normalized, "--project", values.project);
  appendValue(normalized, "--output", values.output);
  return ["export", ...normalized];
}

function prepareImport(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--manifest", values.manifest);
  if (values.json) normalized.push("--json");
  return ["import", ...normalized];
}

function preparePlanLike(
  subcommand: "plan" | "apply",
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      set: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--set", values.set);
  appendValue(normalized, "--project", values.project);
  if (values.json) normalized.push("--json");
  return finish(subcommand, values.help, normalized);
}

function prepareRollback(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      receipt: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--receipt", values.receipt);
  if (values.json) normalized.push("--json");
  return finish("rollback", values.help, normalized);
}

function prepareLeaf(subcommand: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  switch (subcommand) {
    case "list":
    case "receipts":
    case "outcomes":
      return prepareListLike(subcommand, args);
    case "suggest":
      return prepareSuggest(args);
    case "create":
      return prepareCreate(args);
    case "update":
      return prepareUpdate(args);
    case "derive":
      return prepareDerive(args);
    case "capture":
      return prepareCapture(args);
    case "history":
      return prepareHistory(args);
    case "export":
      return prepareExport(args);
    case "import":
      return prepareImport(args);
    case "plan":
    case "apply":
      return preparePlanLike(subcommand, args);
    case "rollback":
      return prepareRollback(args);
    default:
      throw new CLIError(
        `Unknown sets subcommand: ${subcommand}`,
        "UNKNOWN_COMMAND",
        "selftune sets --help",
      );
  }
}

export function prepareLegacySetsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const [subcommand, ...leafArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return [`--${SETS_INTERNAL_PARENT_HELP_FLAG}`];
  }
  try {
    return prepareLeaf(subcommand, leafArgs);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      `selftune sets ${subcommand} --help`,
    );
  }
}
