import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "./command-surface.js";
import { cliMain as createPublishCliMain } from "./create/publish.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";

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

  const delegatedArgs = rawArgs.filter((arg) => arg !== "--no-watch");
  if (!hasWatch && !hasNoWatch) {
    delegatedArgs.push("--watch");
  }

  process.argv = [process.argv[0], process.argv[1], ...delegatedArgs];
  await createPublishCliMain();
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
