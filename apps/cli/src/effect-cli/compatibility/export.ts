import { parseArgs } from "node:util";

import { EXPORT_TABLE_NAMES } from "@selftune/runtime/export-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export const EXPORT_INTERNAL_HELP_FLAG = "selftune-internal-export-help";

const EXPORT_TABLE_NAME_SET: ReadonlySet<string> = new Set(EXPORT_TABLE_NAMES);

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  target.push(flag, `:${value}`);
}

export function prepareLegacyExportArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        output: { type: "string", short: "o" },
        since: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });

    if (values.help) return [`--${EXPORT_INTERNAL_HELP_FLAG}`];

    for (const tableName of positionals) {
      if (EXPORT_TABLE_NAME_SET.has(tableName)) continue;
      throw new CLIError(
        `Invalid value for argument <table>: "${tableName}". Expected one of: ${EXPORT_TABLE_NAMES.join(", ")}`,
        "INVALID_FLAG",
        "selftune export --help",
      );
    }

    const normalized: string[] = [];
    appendStringValue(normalized, "--output", values.output);
    appendStringValue(normalized, "--since", values.since);
    normalized.push(...positionals);
    return normalized;
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune export --help",
    );
  }
}
