#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune ingest <agent>     — Ingest agent sessions (claude, codex, opencode, openclaw, wrap-codex)
 *   selftune grade [mode]       — Grade skill sessions (auto, baseline)
 *   selftune evolve [target]    — Evolve skill descriptions (body, rollback)
 *   selftune eval <action>      — Evaluation tools (generate, unit-test, import, composability)
 *   selftune sync               — Sync source-truth telemetry across supported agents
 *   selftune orchestrate        — Run autonomous core loop (sync → status → evolve → watch)
 *   selftune init               — Initialize agent identity and config
 *   selftune status             — Show skill health summary
 *   selftune watch              — Monitor post-deploy skill health
 *   selftune doctor             — Run health checks
 *   selftune dashboard          — Open visual data dashboard
 *   selftune last               — Show last session details
 *   selftune schedule           — Generate scheduling examples (cron, launchd, systemd)
 *   selftune cron               — OpenClaw cron integration (setup, list, remove)
 *   selftune badge              — Generate skill health badges for READMEs
 *   selftune contribute         — Export anonymized skill data for community
 *   selftune workflows          — Discover and manage multi-skill workflows
 *   selftune quickstart         — Guided onboarding: init, replay, status, and suggestions
 *   selftune repair-skill-usage — Rebuild trustworthy skill usage from transcripts
 *   selftune export-canonical   — Export canonical telemetry for downstream ingestion
 *   selftune hook <name>        — Run a hook by name (prompt-log, session-stop, etc.)
 */

const command = process.argv[2];

if (command === "--help" || command === "-h") {
  console.log(`selftune — Skill observability and continuous improvement

Usage:
  selftune <command> [options]

Commands:
  ingest <agent>     Ingest agent sessions (claude, codex, opencode, openclaw, wrap-codex)
  grade [mode]       Grade skill sessions (auto, baseline)
  evolve [target]    Evolve skill descriptions (body, rollback)
  eval <action>      Evaluation tools (generate, unit-test, import, composability)
  sync               Sync source-truth telemetry across supported agents
  orchestrate        Run autonomous core loop (sync → status → evolve → watch)
  init               Initialize agent identity and config
  status             Show skill health summary
  watch              Monitor post-deploy skill health
  doctor             Run health checks
  dashboard          Open visual data dashboard
  last               Show last session details
  schedule           Generate scheduling examples (cron, launchd, systemd)
  cron               OpenClaw cron integration (setup, list, remove)
  badge              Generate skill health badges for READMEs
  contribute         Export anonymized skill data for community
  workflows          Discover and manage multi-skill workflows
  quickstart         Guided onboarding: init, replay, status, and suggestions
  repair-skill-usage Rebuild trustworthy skill usage from transcripts
  export-canonical   Export canonical telemetry for downstream ingestion
  hook <name>        Run a hook by name (prompt-log, session-stop, etc.)

Run 'selftune <command> --help' for command-specific options.`);
  process.exit(0);
}

if (!command) {
  // Show status by default — same as `selftune status`
  const { cliMain: statusMain } = await import("./status.js");
  statusMain();
  process.exit(0);
}

// Route to the appropriate subcommand module.
// We use dynamic imports so only the needed module is loaded.
// Each module exports a cliMain() function that the router calls explicitly,
// since import.meta.main is false for dynamically imported modules.
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

switch (command) {
  // ── Grouped commands ──────────────────────────────────────────────────

  case "ingest": {
    const sub = process.argv[2];
    if (!sub || sub === "--help" || sub === "-h") {
      console.log(`selftune ingest — Import agent sessions into shared telemetry logs

Usage:
  selftune ingest <agent> [options]

Agents:
  claude       Replay Claude Code transcripts into logs
  codex        Ingest Codex rollout logs
  opencode     Ingest OpenCode sessions
  openclaw     Ingest OpenClaw sessions
  wrap-codex   Wrap codex exec with real-time telemetry

Run 'selftune ingest <agent> --help' for agent-specific options.`);
      process.exit(0);
    }
    // Strip the subcommand so downstream sees the same argv as before
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "claude": {
        const { cliMain } = await import("./ingestors/claude-replay.js");
        cliMain();
        break;
      }
      case "codex": {
        const { cliMain } = await import("./ingestors/codex-rollout.js");
        cliMain();
        break;
      }
      case "opencode": {
        const { cliMain } = await import("./ingestors/opencode-ingest.js");
        cliMain();
        break;
      }
      case "openclaw": {
        const { cliMain } = await import("./ingestors/openclaw-ingest.js");
        cliMain();
        break;
      }
      case "wrap-codex": {
        const { cliMain } = await import("./ingestors/codex-wrapper.js");
        await cliMain();
        break;
      }
      default:
        console.error(
          `Unknown ingest agent: ${sub}\nRun 'selftune ingest --help' for available agents.`,
        );
        process.exit(1);
    }
    break;
  }

  case "grade": {
    const sub = process.argv[2];
    // If no subcommand or starts with '-', run the default grader
    if (!sub || sub.startsWith("-")) {
      const { cliMain } = await import("./grading/grade-session.js");
      await cliMain();
    } else {
      // Strip the subcommand
      process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
      switch (sub) {
        case "auto": {
          const { cliMain } = await import("./grading/auto-grade.js");
          await cliMain();
          break;
        }
        case "baseline": {
          const { cliMain } = await import("./eval/baseline.js");
          await cliMain();
          break;
        }
        default:
          console.error(
            `Unknown grade mode: ${sub}\nRun 'selftune grade --help' for available modes.`,
          );
          process.exit(1);
      }
    }
    break;
  }

  case "evolve": {
    const sub = process.argv[2];
    // If no subcommand or starts with '-', run the default evolve
    if (!sub || sub.startsWith("-")) {
      const { cliMain } = await import("./evolution/evolve.js");
      await cliMain();
    } else {
      // Strip the subcommand
      process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
      switch (sub) {
        case "body": {
          const { cliMain } = await import("./evolution/evolve-body.js");
          await cliMain();
          break;
        }
        case "rollback": {
          const { cliMain } = await import("./evolution/rollback.js");
          await cliMain();
          break;
        }
        default:
          console.error(
            `Unknown evolve target: ${sub}\nRun 'selftune evolve --help' for available targets.`,
          );
          process.exit(1);
      }
    }
    break;
  }

  case "eval": {
    const sub = process.argv[2];
    if (!sub || sub === "--help" || sub === "-h") {
      console.log(`selftune eval — Evaluation and testing tools

Usage:
  selftune eval <action> [options]

Actions:
  generate       Generate eval sets from hook logs
  unit-test      Run or generate skill unit tests
  import         Import SkillsBench task corpus as eval entries
  composability  Analyze skill co-occurrence conflicts

Run 'selftune eval <action> --help' for action-specific options.`);
      process.exit(0);
    }
    // Strip the subcommand
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "generate": {
        const { cliMain } = await import("./eval/hooks-to-evals.js");
        cliMain();
        break;
      }
      case "unit-test": {
        const { cliMain } = await import("./eval/unit-test-cli.js");
        await cliMain();
        break;
      }
      case "import": {
        const { cliMain } = await import("./eval/import-skillsbench.js");
        cliMain();
        break;
      }
      case "composability": {
        const { parseArgs } = await import("node:util");
        const { readJsonl } = await import("./utils/jsonl.js");
        const { TELEMETRY_LOG } = await import("./constants.js");
        const { analyzeComposability } = await import("./eval/composability.js");
        let values: ReturnType<typeof parseArgs>["values"];
        try {
          ({ values } = parseArgs({
            options: {
              skill: { type: "string" },
              window: { type: "string" },
              "telemetry-log": { type: "string" },
            },
            strict: true,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Invalid arguments: ${message}`);
          console.error("Run 'selftune eval composability --help' for usage.");
          process.exit(1);
        }
        if (!values.skill) {
          console.error("[ERROR] --skill <name> is required.");
          process.exit(1);
        }
        const logPath = values["telemetry-log"] ?? TELEMETRY_LOG;
        const telemetry = readJsonl(logPath);
        const windowSize =
          values.window === undefined ? undefined : Number.parseInt(values.window as string, 10);
        if (windowSize !== undefined && (!Number.isInteger(windowSize) || windowSize <= 0)) {
          console.error("Invalid --window value. Use a positive integer number of days.");
          process.exit(1);
        }
        const report = analyzeComposability(values.skill, telemetry, windowSize);
        console.log(JSON.stringify(report, null, 2));
        break;
      }
      default:
        console.error(
          `Unknown eval action: ${sub}\nRun 'selftune eval --help' for available actions.`,
        );
        process.exit(1);
    }
    break;
  }

  // ── Unchanged commands ────────────────────────────────────────────────

  case "init": {
    const { cliMain } = await import("./init.js");
    await cliMain();
    break;
  }
  case "contribute": {
    const { cliMain } = await import("./contribute/contribute.js");
    await cliMain();
    break;
  }
  case "watch": {
    const { cliMain } = await import("./monitoring/watch.js");
    await cliMain();
    break;
  }
  case "doctor": {
    const { doctor } = await import("./observability.js");
    const result = doctor();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.healthy ? 0 : 1);
    break;
  }
  case "status": {
    const { cliMain } = await import("./status.js");
    cliMain();
    break;
  }
  case "last": {
    const { cliMain } = await import("./last.js");
    cliMain();
    break;
  }
  case "dashboard": {
    const { cliMain } = await import("./dashboard.js");
    await cliMain();
    break;
  }
  case "cron": {
    const { cliMain } = await import("./cron/setup.js");
    await cliMain();
    break;
  }
  case "badge": {
    const { cliMain } = await import("./badge/badge.js");
    cliMain();
    break;
  }
  case "sync": {
    const { cliMain } = await import("./sync.js");
    cliMain();
    break;
  }
  case "schedule": {
    const { cliMain } = await import("./schedule.js");
    cliMain();
    break;
  }
  case "workflows": {
    const { cliMain } = await import("./workflows/workflows.js");
    await cliMain();
    break;
  }
  case "quickstart": {
    const { cliMain } = await import("./quickstart.js");
    await cliMain();
    break;
  }
  case "repair-skill-usage": {
    const { cliMain } = await import("./repair/skill-usage.js");
    cliMain();
    break;
  }
  case "export-canonical": {
    const { cliMain } = await import("./canonical-export.js");
    cliMain();
    break;
  }
  case "orchestrate": {
    const { cliMain } = await import("./orchestrate.js");
    await cliMain();
    break;
  }
  case "hook": {
    // Dispatch to the appropriate hook file by name.
    const hookName = process.argv[2]; // argv was shifted above
    const HOOK_MAP: Record<string, string> = {
      "prompt-log": "prompt-log.ts",
      "session-stop": "session-stop.ts",
      "skill-eval": "skill-eval.ts",
      "auto-activate": "auto-activate.ts",
      "skill-change-guard": "skill-change-guard.ts",
      "evolution-guard": "evolution-guard.ts",
    };
    if (!hookName || !HOOK_MAP[hookName]) {
      const available = Object.keys(HOOK_MAP).join(", ");
      console.error(`Unknown hook: ${hookName ?? "(none)"}\nAvailable hooks: ${available}`);
      process.exit(1);
    }
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawnSync } = await import("node:child_process");
    const hooksDir = resolve(dirname(fileURLToPath(import.meta.url)), "hooks");
    const hookFile = resolve(hooksDir, HOOK_MAP[hookName]);
    const result = spawnSync("bun", ["run", hookFile], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 1);
    break;
  }
  default:
    console.error(`Unknown command: ${command}\nRun 'selftune --help' for available commands.`);
    process.exit(1);
}
