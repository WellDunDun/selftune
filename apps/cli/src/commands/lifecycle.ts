import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import * as Effect from "effect/Effect";

import { ingestHelp, isSingleSourceIngestCommand, runSingleSourceIngestCommand } from "./ingest.js";

export async function routeLifecycleCommand(command: string): Promise<boolean> {
  switch (command) {
    // ── Grouped commands ──────────────────────────────────────────────────

    case "ingest": {
      const sub = process.argv[2];
      if (!sub || sub === "--help" || sub === "-h") {
        console.log(ingestHelp());
        process.exit(0);
      }
      if (isSingleSourceIngestCommand(sub)) {
        await Effect.runPromise(runSingleSourceIngestCommand(sub, process.argv.slice(3)));
        break;
      }
      // Strip the subcommand for dedicated legacy routes.
      process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
      switch (sub) {
        case "openclaw": {
          const { cliMain } = await import("@selftune/harness-openclaw/ingestors/openclaw-ingest");
          cliMain();
          break;
        }
        case "wrap-codex": {
          const { cliMain } = await import("@selftune/harness-codex/ingestors/codex-wrapper");
          await cliMain();
          break;
        }
        default:
          throw new CLIError(
            `Unknown ingest agent: ${sub}`,
            "UNKNOWN_COMMAND",
            "selftune ingest --help",
          );
      }
      break;
    }

    case "grade": {
      const sub = process.argv[2];
      if (sub === "--help" || sub === "-h") {
        console.log(`selftune grade — Grade skill sessions

Usage:
  selftune grade [options]          Run the default session grader
  selftune grade auto [options]     Batch auto-grade sessions
  selftune grade baseline [options] Measure baseline lift (no-skill comparison)

Run 'selftune grade <subcommand> --help' for subcommand-specific options.`);
        process.exit(0);
      }
      // If no subcommand or starts with '-', run the default grader
      if (!sub || sub.startsWith("-")) {
        const { cliMain } = await import("@selftune/runtime/grading/grade-session");
        await cliMain();
      } else {
        // Strip the subcommand
        process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
        switch (sub) {
          case "auto": {
            const { cliMain } = await import("@selftune/runtime/grading/auto-grade");
            await cliMain();
            break;
          }
          case "baseline": {
            const { cliMain } = await import("@selftune/runtime/eval/baseline");
            await cliMain();
            break;
          }
          default:
            throw new CLIError(
              `Unknown grade mode: ${sub}`,
              "UNKNOWN_COMMAND",
              "selftune grade --help",
            );
        }
      }
      break;
    }

    case "evolve": {
      const sub = process.argv[2];
      if (sub === "--help" || sub === "-h") {
        console.log(`${renderCommandHelp(PUBLIC_COMMAND_SURFACES.evolve)}

Subcommands:
  selftune evolve body [options]              Evolve full body or routing table
  selftune evolve rollback [options]          Rollback a previous evolution
  selftune evolve apply-proposal [options]    Apply an approved contributor proposal

Run 'selftune evolve <subcommand> --help' for subcommand-specific options.`);
        process.exit(0);
      }
      // If no subcommand or starts with '-', run the default evolve
      if (!sub || sub.startsWith("-")) {
        const { cliMain } = await import("@selftune/orchestration/evolve");
        await cliMain();
      } else {
        // Strip the subcommand
        process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
        switch (sub) {
          case "body": {
            const { cliMain } = await import("@selftune/runtime/evolution/evolve-body");
            await cliMain();
            break;
          }
          case "rollback": {
            const { cliMain } = await import("@selftune/runtime/evolution/rollback");
            await cliMain();
            break;
          }
          case "apply-proposal": {
            const { cliMain } = await import("@selftune/runtime/evolution/apply-proposal");
            await cliMain();
            break;
          }
          default:
            throw new CLIError(
              `Unknown evolve target: ${sub}`,
              "UNKNOWN_COMMAND",
              "selftune evolve --help",
            );
        }
      }
      break;
    }

    case "improve": {
      const [{ runImprove }, { runHistoricalSkillImproveCli }] = await Promise.all([
        import("@selftune/orchestration/improve"),
        import("@selftune/local/historical-skill-improve-cli"),
      ]);
      await runImprove(process.argv.slice(2), {
        historicalImprove: runHistoricalSkillImproveCli,
      });
      break;
    }

    case "search-run": {
      const { cliMain } = await import("@selftune/orchestration/search-run");
      await cliMain();
      break;
    }

    // ── Unchanged commands ────────────────────────────────────────────────

    default:
      return false;
  }

  return true;
}
