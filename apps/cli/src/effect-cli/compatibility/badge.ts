import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const BADGE_INTERNAL_HELP_FLAG = "selftune-internal-badge-help";

const VALID_BADGE_FORMATS: ReadonlySet<string> = new Set(["svg", "markdown", "url"]);

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string): void {
  if (value !== "-" && value.startsWith("-")) {
    target.push(`${flag}=${value}`);
    return;
  }
  target.push(flag, value);
}

export function prepareLegacyBadgeArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    });

    if (values.help) {
      return [`--${BADGE_INTERNAL_HELP_FLAG}`, "--skill", ""];
    }

    if (!values.skill) {
      throw new CLIError("--skill is required", "MISSING_FLAG", "selftune badge --skill <name>");
    }

    if (values.format && !VALID_BADGE_FORMATS.has(values.format)) {
      throw new CLIError(
        `Invalid format '${values.format}'. Must be one of: svg, markdown, url`,
        "INVALID_FLAG",
        "selftune badge --skill <name> --format svg",
      );
    }

    const normalized: string[] = [];
    appendStringValue(normalized, "--skill", values.skill);
    if (values.format) appendStringValue(normalized, "--format", values.format);
    if (values.output) appendStringValue(normalized, "--output", values.output);
    return normalized;
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune badge --help",
    );
  }
}
