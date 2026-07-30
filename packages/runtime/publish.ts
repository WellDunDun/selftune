import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "./command-surface.js";
import {
  formatCreatePublishResult,
  runCreatePublish,
  type CreatePublishResult,
} from "./create/publish.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";

export interface RunPublishOptions {
  skillPath: string;
  watch?: boolean;
  ignoreWatchAlerts?: boolean;
}

export interface RunPublishDeps {
  readonly runCreatePublish?: typeof runCreatePublish;
}

export async function runPublish(
  options: RunPublishOptions,
  deps: RunPublishDeps = {},
): Promise<CreatePublishResult> {
  return (deps.runCreatePublish ?? runCreatePublish)({
    ...options,
    watch: options.watch ?? true,
  });
}

export function formatPublishResult(result: CreatePublishResult): string {
  return formatCreatePublishResult(result);
}

export async function cliMain(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.publish));
    process.exit(0);
  }

  const hasWatch = rawArgs.includes("--watch") || rawArgs.some((arg) => arg.startsWith("--watch="));
  const hasNoWatch = rawArgs.includes("--no-watch");

  if (hasWatch && hasNoWatch) {
    throw new CLIError(
      "Use either --watch or --no-watch, not both.",
      "INVALID_FLAG",
      "selftune publish --skill-path <path> [--no-watch]",
    );
  }

  const { values } = parseArgs({
    args: rawArgs.filter((arg) => arg !== "--no-watch"),
    options: {
      "skill-path": { type: "string" },
      watch: { type: "boolean", default: false },
      "ignore-watch-alerts": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const result = await runPublish({
    skillPath: values["skill-path"] ?? "",
    watch: hasNoWatch ? false : hasWatch || !hasNoWatch,
    ignoreWatchAlerts: values["ignore-watch-alerts"],
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatPublishResult(result));
  }
  process.exit(result.published ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
