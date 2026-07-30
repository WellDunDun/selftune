import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const PUBLISH_INTERNAL_HELP_FLAG = "selftune-internal-publish-help";
export const PUBLISH_INTERNAL_WATCH_FLAG = "selftune-internal-publish-watch";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodePublishInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyPublishArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return [`--${PUBLISH_INTERNAL_HELP_FLAG}`];
  }

  const hasWatch = args.includes("--watch") || args.some((arg) => arg.startsWith("--watch="));
  const hasNoWatch = args.includes("--no-watch");
  if (hasWatch && hasNoWatch) {
    throw new CLIError(
      "Use either --watch or --no-watch, not both.",
      "INVALID_FLAG",
      "selftune publish --skill-path <path> [--no-watch]",
    );
  }

  try {
    const delegatedArgs = args.filter((arg) => arg !== "--no-watch");
    if (!hasWatch && !hasNoWatch) delegatedArgs.push("--watch");
    const { values } = parseArgs({
      args: delegatedArgs,
      options: {
        "skill-path": { type: "string" },
        watch: { type: "boolean", default: false },
        "ignore-watch-alerts": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    if (values.help) return [`--${PUBLISH_INTERNAL_HELP_FLAG}`];
    const normalized: string[] = [];
    appendStringValue(normalized, "--skill-path", values["skill-path"]);
    if (values.watch) normalized.push(`--${PUBLISH_INTERNAL_WATCH_FLAG}`);
    if (values["ignore-watch-alerts"]) normalized.push("--ignore-watch-alerts");
    if (values.json) normalized.push("--json");
    return normalized;
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune publish --help",
    );
  }
}
