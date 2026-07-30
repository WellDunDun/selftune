import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const CONTRIBUTE_INTERNAL_HELP_FLAG = "selftune-internal-contribute-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodeContributeInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyContributeArguments(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string", default: "selftune" },
        output: { type: "string" },
        preview: { type: "boolean", default: false },
        sanitize: { type: "string", default: "conservative" },
        since: { type: "string" },
        submit: { type: "boolean", default: false },
        endpoint: { type: "string" },
        github: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    if (values.help) return [`--${CONTRIBUTE_INTERNAL_HELP_FLAG}`];

    const normalized: string[] = [];
    appendStringValue(normalized, "--skill", values.skill);
    appendStringValue(normalized, "--output", values.output);
    if (values.preview) normalized.push("--preview");
    appendStringValue(normalized, "--sanitize", values.sanitize);
    appendStringValue(normalized, "--since", values.since);
    if (values.submit) normalized.push("--submit");
    appendStringValue(normalized, "--endpoint", values.endpoint);
    if (values.github) normalized.push("--github");
    return normalized;
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune contribute --help",
    );
  }
}
