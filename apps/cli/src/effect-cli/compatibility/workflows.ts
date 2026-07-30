import { parseArgs } from "node:util";

import { WORKFLOWS_HELP } from "@selftune/runtime/workflows/help";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export { WORKFLOWS_HELP };

export const WORKFLOWS_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-workflows-parent-help";

interface WorkflowValues {
  readonly "min-occurrences"?: string;
  readonly window?: string;
  readonly skill?: string;
  readonly "skill-path"?: string;
  readonly "output-dir"?: string;
  readonly "skill-name"?: string;
  readonly description?: string;
  readonly write?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly help?: boolean;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

function appendDiscoveryValues(target: string[], values: WorkflowValues): void {
  appendValue(target, "--min-occurrences", values["min-occurrences"]);
  appendValue(target, "--window", values.window);
  appendValue(target, "--skill", values.skill);
}

function normalizeInteger(value: string | undefined, flag: string): string | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new CLIError(`${flag} must be a non-negative integer.`, "INVALID_FLAG");
  }
  return String(parsed);
}

function normalizeValues(values: WorkflowValues): WorkflowValues {
  return {
    ...values,
    "min-occurrences": normalizeInteger(values["min-occurrences"], "--min-occurrences"),
    window: normalizeInteger(values.window, "--window"),
  };
}

function prepareDiscover(values: WorkflowValues): ReadonlyArray<string> {
  const normalized: string[] = ["discover"];
  appendDiscoveryValues(normalized, values);
  if (values.json) normalized.push("--json");
  return normalized;
}

function prepareSave(selection: string | undefined, values: WorkflowValues): ReadonlyArray<string> {
  const normalized: string[] = ["save"];
  appendValue(normalized, "--selection", selection);
  appendDiscoveryValues(normalized, values);
  appendValue(normalized, "--skill-path", values["skill-path"]);
  return normalized;
}

function prepareScaffold(
  selection: string | undefined,
  values: WorkflowValues,
): ReadonlyArray<string> {
  const normalized: string[] = ["scaffold"];
  appendValue(normalized, "--selection", selection);
  appendDiscoveryValues(normalized, values);
  appendValue(normalized, "--output-dir", values["output-dir"]);
  appendValue(normalized, "--skill-name", values["skill-name"]);
  appendValue(normalized, "--description", values.description);
  if (values.write) normalized.push("--write");
  if (values.force) normalized.push("--force");
  if (values.json) normalized.push("--json");
  return normalized;
}

export function decodeWorkflowsInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyWorkflowsArguments(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  try {
    const { values: parsedValues, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "min-occurrences": { type: "string" },
        window: { type: "string" },
        skill: { type: "string" },
        "skill-path": { type: "string" },
        "output-dir": { type: "string" },
        "skill-name": { type: "string" },
        description: { type: "string" },
        write: { type: "boolean" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
    if (parsedValues.help) return [`--${WORKFLOWS_INTERNAL_PARENT_HELP_FLAG}`];
    const values = normalizeValues(parsedValues);

    const command = positionals[0];
    if (command === "save") return prepareSave(positionals[1], values);
    if (command === "scaffold") return prepareScaffold(positionals[1], values);
    return prepareDiscover(values);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune workflows --help",
    );
  }
}
