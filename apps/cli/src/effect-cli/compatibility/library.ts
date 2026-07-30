import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";
import { LIBRARY_HELP } from "@selftune/runtime/library/help";

export const LIBRARY_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-library-parent-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodeLibraryInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

interface LibraryValues {
  readonly url?: string;
  readonly "api-key"?: string;
  readonly output?: string;
  readonly target?: string;
  readonly "candidate-id"?: string;
  readonly action?: string;
  readonly reason?: string;
  readonly "snooze-until"?: string;
  readonly "output-dir"?: string;
  readonly title?: string;
  readonly summary?: string;
}

function prepareSynthesize(action: string, values: LibraryValues): ReadonlyArray<string> {
  const normalized: string[] = ["synthesize", action];
  switch (action) {
    case "scan":
    case "list":
      return normalized;
    case "review":
      appendValue(normalized, "--candidate-id", values["candidate-id"]);
      appendValue(normalized, "--action", values.action);
      appendValue(normalized, "--reason", values.reason);
      appendValue(normalized, "--snooze-until", values["snooze-until"]);
      appendValue(normalized, "--title", values.title);
      appendValue(normalized, "--summary", values.summary);
      return normalized;
    case "draft":
      appendValue(normalized, "--candidate-id", values["candidate-id"]);
      appendValue(normalized, "--output-dir", values["output-dir"]);
      return normalized;
    case "evaluate":
    case "release":
      appendValue(normalized, "--candidate-id", values["candidate-id"]);
      return normalized;
    default:
      if (!values["candidate-id"]?.trim()) {
        throw new CLIError("--candidate-id is required.", "MISSING_FLAG");
      }
      throw new CLIError(`Unknown synthesize action: ${action}`, "INVALID_FLAG", LIBRARY_HELP);
  }
}

function prepareCommand(
  command: string,
  positionals: ReadonlyArray<string>,
  values: LibraryValues,
): ReadonlyArray<string> {
  const normalized: string[] = [command];
  switch (command) {
    case "list":
    case "preview":
    case "sync":
    case "status":
    case "diagnostics":
      return normalized;
    case "configure":
      appendValue(normalized, "--url", values.url);
      appendValue(normalized, "--api-key", values["api-key"]);
      return normalized;
    case "export":
      appendValue(normalized, "--output", values.output);
      return normalized;
    case "restore":
      appendValue(normalized, "--target", values.target);
      return normalized;
    case "synthesize":
      return prepareSynthesize(positionals[1] ?? "list", values);
    default:
      throw new CLIError(`Unknown library command: ${command}`, "INVALID_FLAG", LIBRARY_HELP);
  }
}

export function prepareLegacyLibraryArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        url: { type: "string" },
        "api-key": { type: "string" },
        output: { type: "string" },
        target: { type: "string" },
        "candidate-id": { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        "snooze-until": { type: "string" },
        "output-dir": { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
      },
      strict: true,
    });
    if (values.help) return [`--${LIBRARY_INTERNAL_PARENT_HELP_FLAG}`];
    return prepareCommand(positionals[0] ?? "list", positionals, values);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune library --help",
    );
  }
}
