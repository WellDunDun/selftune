/**
 * selftune registry — Team skill distribution.
 *
 * Subcommands:
 *   push       Push current skill folder as a new version
 *   install    Download and install a skill from the registry
 *   sync       Check for updates and pull latest versions
 *   status     Show installed entries and version drift
 *   rollback   Rollback a skill to a previous version
 *   history    Show version timeline for a skill
 *   list       Show all published entries in the org
 */

import { CLIError } from "../utils/cli-error.js";

const sub = process.argv[2];

export async function cliMain() {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`selftune registry — Team skill distribution

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
`);
    return;
  }

  // Strip 'registry' from argv so subcommands see the right args
  process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

  switch (sub) {
    case "push": {
      const { cliMain } = await import("./push.js");
      await cliMain();
      break;
    }
    case "install": {
      const { cliMain } = await import("./install.js");
      await cliMain();
      break;
    }
    case "sync": {
      const { cliMain } = await import("./sync.js");
      await cliMain();
      break;
    }
    case "status": {
      const { cliMain } = await import("./status.js");
      await cliMain();
      break;
    }
    case "rollback": {
      const { cliMain } = await import("./rollback.js");
      await cliMain();
      break;
    }
    case "history": {
      const { cliMain } = await import("./history.js");
      await cliMain();
      break;
    }
    case "list": {
      const { cliMain } = await import("./list.js");
      await cliMain();
      break;
    }
    default:
      throw new CLIError(
        `Unknown registry subcommand: ${sub}`,
        "UNKNOWN_COMMAND",
        "selftune registry --help",
      );
  }
}
