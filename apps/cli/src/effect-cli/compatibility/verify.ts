import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const VERIFY_INTERNAL_HELP_FLAG = "selftune-internal-verify-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  target.push(flag, `:${value}`);
}

export function prepareLegacyVerifyArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        "skill-path": { type: "string" },
        agent: { type: "string" },
        "eval-set": { type: "string" },
        "no-auto-fix": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    if (values.help) return [`--${VERIFY_INTERNAL_HELP_FLAG}`];

    const normalized: string[] = [];
    appendStringValue(normalized, "--skill-path", values["skill-path"]);
    appendStringValue(normalized, "--agent", values.agent);
    appendStringValue(normalized, "--eval-set", values["eval-set"]);
    if (values["no-auto-fix"]) normalized.push("--no-auto-fix");
    if (values.json) normalized.push("--json");
    return normalized;
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune verify --help",
    );
  }
}
