import { CLIError } from "@selftune/runtime/utils/cli-error";

export const CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG =
  "selftune-internal-contributions-parent-help";
export const CONTRIBUTIONS_INTERNAL_UPLOAD_HELP_FLAG =
  "selftune-internal-contributions-upload-help";

function invalidUpload(message: string): never {
  throw new CLIError(message, "INVALID_FLAG", "selftune contributions upload --help");
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodeContributionsInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

function prepareUploadArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let dryRun = false;
  let retryFailed = false;
  let limit: string | undefined;
  let endpoint: string | undefined;
  let apiKey: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--retry-failed":
        retryFailed = true;
        break;
      case "--limit": {
        const value = args[index + 1];
        if (!value) invalidUpload("Missing value for --limit.");
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) invalidUpload(`Invalid limit: ${value}`);
        limit = String(parsed);
        index += 1;
        break;
      }
      case "--endpoint":
        endpoint = args[index + 1];
        if (!endpoint) invalidUpload("Missing value for --endpoint.");
        index += 1;
        break;
      case "--api-key":
        apiKey = args[index + 1];
        if (!apiKey) invalidUpload("Missing value for --api-key.");
        index += 1;
        break;
      case "--help":
      case "-h":
        return [`--${CONTRIBUTIONS_INTERNAL_UPLOAD_HELP_FLAG}`];
      default:
        invalidUpload(`Unknown contributions upload flag: ${token}`);
    }
  }

  const normalized: string[] = [];
  if (dryRun) normalized.push("--dry-run");
  if (retryFailed) normalized.push("--retry-failed");
  appendValue(normalized, "--limit", limit);
  appendValue(normalized, "--endpoint", endpoint);
  appendValue(normalized, "--api-key", apiKey);
  return normalized;
}

export function prepareLegacyContributionsArguments(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const [subcommand, argument, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") {
    return [`--${CONTRIBUTIONS_INTERNAL_PARENT_HELP_FLAG}`];
  }

  switch (subcommand) {
    case undefined:
    case "status":
      return ["status"];
    case "preview":
    case "approve":
    case "revoke":
    case "default":
      return argument === undefined ? [subcommand] : [subcommand, `:${argument}`];
    case "reset":
      return ["reset"];
    case "upload":
      return [
        "upload",
        ...prepareUploadArguments(argument === undefined ? rest : [argument, ...rest]),
      ];
    default:
      throw new CLIError(
        `Unknown contributions subcommand: ${subcommand}`,
        "INVALID_FLAG",
        "selftune contributions --help",
      );
  }
}
