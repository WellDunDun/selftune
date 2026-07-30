import { CLIError } from "@selftune/runtime/utils/cli-error";
import {
  type ClaudeHookName,
  forwardHookToDaemon,
} from "@selftune/harness-claude-code/hooks/daemon-forward";
import { writeHookExecutionResult } from "@selftune/harness-claude-code/hooks/execution-result";

async function runClaudeHook(hookName: ClaudeHookName): Promise<number> {
  const rawStdin = await Bun.stdin.text();
  const forwarded = await forwardHookToDaemon(hookName, rawStdin);
  if (forwarded) return writeHookExecutionResult(forwarded);

  switch (hookName) {
    case "prompt-log": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/prompt-log");
      return cliMain(rawStdin);
    }
    case "session-stop": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/session-stop");
      return cliMain(rawStdin);
    }
    case "skill-eval": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/skill-eval");
      return cliMain(rawStdin);
    }
    case "skill-edit-capture": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/skill-edit-capture");
      return cliMain(rawStdin);
    }
    case "auto-activate": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/auto-activate");
      return cliMain(rawStdin);
    }
    case "skill-change-guard": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/skill-change-guard");
      return cliMain(rawStdin);
    }
    case "evolution-guard": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/evolution-guard");
      return cliMain(rawStdin);
    }
    case "commit-track": {
      const { cliMain } = await import("@selftune/harness-claude-code/hooks/commit-track");
      return cliMain(rawStdin);
    }
  }
}

export async function routeHarnessCommand(command: string): Promise<boolean> {
  switch (command) {
    case "hook": {
      const hookName = process.argv[2];
      switch (hookName) {
        case "prompt-log":
        case "session-stop":
        case "skill-eval":
        case "skill-edit-capture":
        case "auto-activate":
        case "skill-change-guard":
        case "evolution-guard":
        case "commit-track": {
          process.exitCode = await runClaudeHook(hookName);
          break;
        }
        default:
          throw new CLIError(
            `Unknown hook: ${hookName ?? "(none)"}. Available: prompt-log, session-stop, skill-eval, skill-edit-capture, auto-activate, skill-change-guard, evolution-guard, commit-track`,
            "UNKNOWN_COMMAND",
            "selftune hook prompt-log",
          );
      }
      break;
    }
    // ── Platform hook adapters ─────────────────────────────────────────

    case "codex":
    case "opencode":
    case "cline":
    case "pi": {
      const platform = command;
      const displayName = { codex: "Codex", opencode: "OpenCode", cline: "Cline", pi: "Pi" }[
        platform
      ];
      const sub = process.argv[2];
      if (!sub || sub === "--help" || sub === "-h") {
        console.log(`selftune ${platform} — ${displayName} platform hooks

Usage:
  selftune ${platform} <subcommand> [options]

Subcommands:
  hook       Handle a real-time hook event from ${displayName}
  install    Install or remove selftune hooks in ${displayName} config

Run 'selftune ${platform} <subcommand> --help' for subcommand-specific options.`);
        process.exit(0);
      }
      process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
      switch (sub) {
        case "hook": {
          switch (platform) {
            case "codex": {
              const { cliMain } = await import("@selftune/harness-codex/adapters/codex/hook");
              await cliMain();
              break;
            }
            case "opencode": {
              const { cliMain } = await import("@selftune/harness-opencode/adapters/opencode/hook");
              await cliMain();
              break;
            }
            case "cline": {
              const { cliMain } = await import("@selftune/harness-cline/adapters/cline/hook");
              await cliMain();
              break;
            }
            case "pi": {
              const { cliMain } = await import("@selftune/harness-pi/adapters/pi/hook");
              await cliMain();
              break;
            }
          }
          break;
        }
        case "install": {
          switch (platform) {
            case "codex": {
              const { cliMain } = await import("@selftune/harness-codex/adapters/codex/install");
              await cliMain();
              break;
            }
            case "opencode": {
              const { cliMain } =
                await import("@selftune/harness-opencode/adapters/opencode/install");
              await cliMain();
              break;
            }
            case "cline": {
              const { cliMain } = await import("@selftune/harness-cline/adapters/cline/install");
              await cliMain();
              break;
            }
            case "pi": {
              const { cliMain } = await import("@selftune/harness-pi/adapters/pi/install");
              await cliMain();
              break;
            }
          }
          break;
        }
        default:
          throw new CLIError(
            `Unknown ${platform} subcommand: ${sub}`,
            "UNKNOWN_COMMAND",
            `selftune ${platform} --help`,
          );
      }
      break;
    }

    default:
      return false;
  }

  return true;
}
