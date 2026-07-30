import { CLIError } from "@selftune/runtime/utils/cli-error";

export async function routeOperationsCommand(command: string): Promise<boolean> {
  switch (command) {
    case "init": {
      const { cliMain } = await import("@selftune/orchestration/init");
      await cliMain();
      break;
    }
    case "cron":
    case "schedule": {
      const sub = process.argv[2];
      if (sub === "--help" || sub === "-h" || (!sub && command === "cron")) {
        console.log(`selftune cron — Scheduling & automation for selftune

Usage:
  selftune cron <subcommand> [options]

Subcommands:
  setup              Auto-detect platform and install scheduled jobs (cron/launchd/systemd)
  setup --platform openclaw   Use OpenClaw-specific cron integration
  list               Show registered selftune cron jobs (OpenClaw)
  remove             Remove selftune cron jobs (OpenClaw)

Flags (setup):
  --platform <name>  Force a specific platform (openclaw, cron, launchd, systemd)
  --dry-run          Preview without installing
  --tz <timezone>    IANA timezone for job schedules (OpenClaw only)
  --format, -f       Alias for --platform (backward compat with schedule)
  --install          Write and activate artifacts (default for setup)

Aliases:
  selftune schedule  → selftune cron

Run 'selftune cron <subcommand> --help' for subcommand-specific options.`);
        process.exit(0);
      }

      // If invoked as `selftune schedule` with no subcommand or with flags,
      // route directly to the schedule module for backward compatibility
      if (command === "schedule" && (!sub || sub.startsWith("-"))) {
        const { cliMain } = await import("@selftune/orchestration/schedule");
        cliMain();
        break;
      }

      // Strip the subcommand so downstream sees clean argv
      process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

      switch (sub) {
        case "setup": {
          // Check for --platform flag to decide which setup path
          const platformIdx = process.argv.indexOf("--platform");
          const platformVal = platformIdx >= 0 ? process.argv[platformIdx + 1] : undefined;

          if (platformVal === "openclaw") {
            // Remove --platform openclaw from argv before passing to cron/setup
            process.argv = process.argv.filter(
              (_, i) => i !== platformIdx && i !== platformIdx + 1,
            );
            const { cliMain } = await import("@selftune/harness-openclaw/cron/setup");
            await cliMain();
          } else if (platformVal) {
            // Map --platform to --format for the schedule module
            process.argv = process.argv.filter(
              (_, i) => i !== platformIdx && i !== platformIdx + 1,
            );
            process.argv.push("--format", platformVal, "--install");
            const { cliMain } = await import("@selftune/orchestration/schedule");
            cliMain();
          } else {
            // Auto-detect: install schedule artifacts for the current platform
            process.argv.push("--install");
            const { cliMain } = await import("@selftune/orchestration/schedule");
            cliMain();
          }
          break;
        }
        case "list": {
          const { cliMain } = await import("@selftune/harness-openclaw/cron/setup");
          // Re-add 'list' so cron/setup.ts sees the subcommand
          process.argv = [process.argv[0], process.argv[1], "list", ...process.argv.slice(2)];
          await cliMain();
          break;
        }
        case "remove": {
          const { cliMain } = await import("@selftune/harness-openclaw/cron/setup");
          // Re-add 'remove' so cron/setup.ts sees the subcommand
          process.argv = [process.argv[0], process.argv[1], "remove", ...process.argv.slice(2)];
          await cliMain();
          break;
        }
        default:
          throw new CLIError(
            `Unknown cron subcommand: ${sub}`,
            "UNKNOWN_COMMAND",
            "selftune cron --help",
          );
      }
      break;
    }
    case "repair-skill-usage": {
      const { cliMain } = await import("@selftune/orchestration/repair/skill-usage");
      cliMain();
      break;
    }
    case "export-canonical": {
      const { cliMain } = await import("@selftune/orchestration/canonical-export");
      cliMain();
      break;
    }
    case "orchestrate": {
      const { cliMain } = await import("@selftune/orchestration/orchestrate");
      await cliMain();
      break;
    }

    case "run": {
      const { cliMain } = await import("@selftune/orchestration/run");
      await cliMain();
      break;
    }
    default:
      return false;
  }

  return true;
}
