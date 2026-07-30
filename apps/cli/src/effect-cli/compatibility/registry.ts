import { CLIError } from "@selftune/runtime/utils/cli-error";

export const REGISTRY_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-registry-parent-help";
export const REGISTRY_INTERNAL_VERSION_FLAG = "selftune-internal-registry-version";

export const REGISTRY_HELP = `selftune registry — Team skill distribution

Usage:
  selftune registry <subcommand> [options]

Subcommands:
  push [name]          Push current skill folder as a new version
  install <name>       Download from the registry or install github:owner/repo[@ref][//path]
  sync                 Check for updates and pull latest versions
  status               Show installed entries and version drift
  rollback <name>      Rollback to a previous version
  history <name>       Show version timeline
  list                 Show all published entries

Options:
  --version=<semver>   Set version explicitly (push)
  --summary=<text>     Change summary (push)
  --global             Install to ~/.claude/skills/ (install)
  --to=<version>       Target version (rollback)
  --reason=<text>      Rollback reason (rollback)
`;

const REGISTRY_LEAVES: ReadonlySet<string> = new Set([
  "push",
  "install",
  "sync",
  "status",
  "rollback",
  "history",
  "list",
]);

function firstPositional(args: ReadonlyArray<string>): string | undefined {
  return args.find((argument) => !argument.startsWith("--"));
}

function firstAttachedValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const prefix = `${flag}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

export function decodeRegistryInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyRegistryArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const [subcommand, ...leafArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return [`--${REGISTRY_INTERNAL_PARENT_HELP_FLAG}`];
  }
  if (!REGISTRY_LEAVES.has(subcommand)) {
    throw new CLIError(
      `Unknown registry subcommand: ${subcommand}`,
      "UNKNOWN_COMMAND",
      "selftune registry --help",
    );
  }

  const normalized: string[] = [subcommand];
  switch (subcommand) {
    case "push":
      appendValue(normalized, "--name", firstPositional(leafArgs));
      appendValue(
        normalized,
        `--${REGISTRY_INTERNAL_VERSION_FLAG}`,
        firstAttachedValue(leafArgs, "--version"),
      );
      appendValue(normalized, "--summary", firstAttachedValue(leafArgs, "--summary"));
      return normalized;
    case "install":
      appendValue(normalized, "--target", firstPositional(leafArgs));
      if (leafArgs.includes("--global")) normalized.push("--global");
      return normalized;
    case "rollback":
      appendValue(normalized, "--name", firstPositional(leafArgs));
      appendValue(normalized, "--to", firstAttachedValue(leafArgs, "--to"));
      appendValue(normalized, "--reason", firstAttachedValue(leafArgs, "--reason"));
      return normalized;
    case "history":
      appendValue(normalized, "--name", firstPositional(leafArgs));
      return normalized;
    case "sync":
    case "status":
    case "list":
      return normalized;
  }
  return normalized;
}
