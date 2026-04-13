#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune ingest <agent>     — Ingest agent sessions (claude, codex, opencode, openclaw, pi, wrap-codex)
 *   selftune grade [mode]       — Grade skill sessions (auto, baseline)
 *   selftune evolve [target]    — Evolve skill descriptions (body, rollback)
 *   selftune eval <action>      — Evaluation tools (generate, unit-test, import, composability, family-overlap)
 *   selftune sync               — Sync source-truth telemetry across supported agents
 *   selftune orchestrate        — Run autonomous core loop (sync → status → evolve → watch)
 *   selftune init               — Initialize agent identity and config
 *   selftune uninstall          — Clean removal of all selftune data and config
 *   selftune status             — Show skill health summary
 *   selftune watch              — Monitor post-deploy skill health
 *   selftune doctor             — Run health checks
 *   selftune dashboard          — Open visual data dashboard
 *   selftune last               — Show last session details
 *   selftune cron               — Scheduling & automation (setup, list, remove)
 *   selftune badge              — Generate skill health badges for READMEs
 *   selftune contribute         — Export anonymized skill data for community
 *   selftune contributions      — Manage creator-directed sharing preferences
 *   selftune creator-contributions — Manage creator-side contribution configs
 *   selftune workflows          — Discover workflows and scaffold workflow skills
 *   selftune quickstart         — Guided onboarding: init, ingest, status, and suggestions
 *   selftune repair-skill-usage — Rebuild trustworthy skill usage from transcripts
 *   selftune export             — Export SQLite data to JSONL snapshots
 *   selftune export-canonical   — Export canonical telemetry for downstream ingestion
 *   selftune recover            — Recover SQLite from legacy/exported JSONL
 *   selftune telemetry          — Manage anonymous usage analytics (status, enable, disable)
 *   selftune registry <sub>    — Team skill distribution (push, install, sync, status, rollback, history, list)
 *   selftune alpha <subcommand> — Alpha program management (upload)
 *   selftune hook <name>        — Run a hook by name (prompt-log, session-stop, etc.)
 *   selftune codex <subcommand> — Codex platform hooks (hook, install)
 *   selftune opencode <sub>     — OpenCode platform hooks (hook, install)
 *   selftune cline <subcommand> — Cline platform hooks (hook, install)
 *   selftune pi <subcommand>    — Pi platform hooks (hook, install)
 */

import { CLIError, handleCLIError } from "./utils/cli-error.js";
import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "./command-surface.js";

process.on("uncaughtException", handleCLIError);
process.on("unhandledRejection", handleCLIError);

const command = process.argv[2];

if (command === "--help" || command === "-h") {
  console.log(`selftune — Skill observability and continuous improvement

Usage:
  selftune <command> [options]

Commands:
  ingest <agent>     Ingest agent sessions (claude, codex, opencode, openclaw, pi, wrap-codex)
  grade [mode]       Grade skill sessions (auto, baseline)
  evolve [target]    Evolve skill descriptions (body, rollback)
  eval <action>      Evaluation tools (generate, unit-test, import, composability, family-overlap)
  sync               Sync source-truth telemetry across supported agents
  orchestrate        Run autonomous core loop (sync → status → evolve → watch)
  init               Initialize agent identity and config
  uninstall          Clean removal of all selftune data and config
  status             Show skill health summary
  watch              Monitor post-deploy skill health
  doctor             Run health checks
  dashboard          Open visual data dashboard
  last               Show last session details
  cron               Scheduling & automation (setup, list, remove)
  badge              Generate skill health badges for READMEs
  contribute         Export anonymized skill data for community
  contributions      Manage creator-directed sharing preferences
  creator-contributions Manage creator-side contribution configs
  workflows          Discover workflows and scaffold workflow skills
  quickstart         Guided onboarding: init, ingest, status, and suggestions
  repair-skill-usage Rebuild trustworthy skill usage from transcripts
  export             Export SQLite data to JSONL snapshots
  export-canonical   Export canonical telemetry for downstream ingestion
  recover            Recover SQLite from legacy/exported JSONL
  registry <sub>    Team skill distribution (push, install, sync, status, rollback, history, list)
  alpha <subcommand> Alpha program management (upload)
  telemetry          Manage anonymous usage analytics (status, enable, disable)
  hook <name>        Run a hook by name (prompt-log, session-stop, etc.)
  codex <sub>        Codex platform hooks (hook, install)
  opencode <sub>     OpenCode platform hooks (hook, install)
  cline <sub>        Cline platform hooks (hook, install)
  pi <sub>           Pi platform hooks (hook, install)

Run 'selftune <command> --help' for command-specific options.`);
  process.exit(0);
}

// Fast-path commands (real-time hooks) — skip analytics and auto-update to minimize latency
const FAST_COMMANDS: ReadonlySet<string> = new Set(["hook", "codex", "opencode", "cline", "pi"]);

// Track command usage (lazy import — skip for hooks and --help to avoid loading crypto/os)
if (command && !FAST_COMMANDS.has(command) && command !== "--help" && command !== "-h") {
  import("./analytics.js")
    .then(({ trackEvent }) => trackEvent("command_run", { command }))
    .catch(() => {});
}

// Auto-update check (skip for hooks and platform hook commands — they must be fast — and --help)
if (command && !FAST_COMMANDS.has(command) && command !== "--help" && command !== "-h") {
  const { autoUpdate } = await import("./auto-update.js");
  await autoUpdate();
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
  codex        Ingest Codex rollout logs (experimental)
  opencode     Ingest OpenCode sessions (experimental)
  openclaw     Ingest OpenClaw sessions (experimental)
  pi           Ingest Pi sessions (experimental)
  wrap-codex   Wrap codex exec with real-time telemetry (experimental)

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
      case "pi": {
        const { cliMain } = await import("./ingestors/pi-ingest.js");
        cliMain();
        break;
      }
      case "wrap-codex": {
        const { cliMain } = await import("./ingestors/codex-wrapper.js");
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
        case "apply-proposal": {
          const { cliMain } = await import("./evolution/apply-proposal.js");
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
  family-overlap Detect sibling-skill overlap and consolidation pressure

Recommended creator loop:
  1. selftune eval generate --skill <name>
  2. selftune eval unit-test --skill <name> --generate --skill-path <path>
  3. selftune evolve --skill <name> --skill-path <path> --dry-run --validation-mode replay
  4. selftune grade baseline --skill <name> --skill-path <path>

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
        if (process.argv[2] === "--help" || process.argv[2] === "-h") {
          console.log(
            "selftune eval composability --skill <name> [--window <days>] [--telemetry-log <path>]",
          );
          process.exit(0);
        }
        const { parseArgs } = await import("node:util");
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
          throw new CLIError(
            `Invalid arguments: ${message}`,
            "INVALID_FLAG",
            "selftune eval composability --help",
          );
        }
        if (!values.skill) {
          throw new CLIError(
            "--skill <name> is required.",
            "MISSING_FLAG",
            "selftune eval composability --skill <name>",
          );
        }
        const logPath =
          typeof values["telemetry-log"] === "string" ? values["telemetry-log"] : TELEMETRY_LOG;
        let telemetry: unknown[];
        if (logPath === TELEMETRY_LOG) {
          try {
            const { getDb } = await import("./localdb/db.js");
            const { querySessionTelemetry } = await import("./localdb/queries.js");
            const db = getDb();
            telemetry = querySessionTelemetry(db);
          } catch {
            // DB unavailable — fall back to JSONL
            const { readJsonl } = await import("./utils/jsonl.js");
            telemetry = readJsonl(logPath);
          }
        } else {
          const { readJsonl } = await import("./utils/jsonl.js");
          telemetry = readJsonl(logPath);
        }
        const rawWindow = values.window as string | undefined;
        if (rawWindow !== undefined && !/^[1-9]\d*$/.test(rawWindow)) {
          throw new CLIError(
            "Invalid --window value. Use a positive integer number of days.",
            "INVALID_FLAG",
            "selftune eval composability --skill <name> --window 30",
          );
        }
        const windowSize = rawWindow === undefined ? undefined : Number(rawWindow);
        const skillName = typeof values.skill === "string" ? values.skill : undefined;
        if (!skillName) {
          throw new CLIError(
            "--skill <name> is required.",
            "MISSING_FLAG",
            "selftune eval composability --skill <name>",
          );
        }
        const report = analyzeComposability(
          skillName,
          telemetry as import("./types.js").SessionTelemetryRecord[],
          windowSize,
        );
        console.log(JSON.stringify(report, null, 2));
        break;
      }
      case "family-overlap": {
        if (process.argv[2] === "--help" || process.argv[2] === "-h") {
          console.log(
            "selftune eval family-overlap --prefix <family-> | --skills <a,b,c> [--parent-skill <name>] [--min-overlap 0.3] [--min-shared 2]",
          );
          process.exit(0);
        }
        const { cliMain } = await import("./eval/family-overlap.js");
        await cliMain();
        break;
      }
      default:
        throw new CLIError(
          `Unknown eval action: ${sub}`,
          "UNKNOWN_COMMAND",
          "selftune eval --help",
        );
    }
    break;
  }

  // ── Unchanged commands ────────────────────────────────────────────────

  case "init": {
    const { cliMain } = await import("./init.js");
    await cliMain();
    break;
  }
  case "uninstall": {
    const { cliMain } = await import("./uninstall.js");
    await cliMain();
    break;
  }
  case "contribute": {
    const { cliMain } = await import("./contribute/contribute.js");
    await cliMain();
    break;
  }
  case "contributions": {
    const { cliMain } = await import("./contributions.js");
    await cliMain();
    break;
  }
  case "creator-contributions": {
    const { cliMain } = await import("./creator-contributions.js");
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
    const result = await doctor();
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
      const { cliMain } = await import("./schedule.js");
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
          process.argv = process.argv.filter((_, i) => i !== platformIdx && i !== platformIdx + 1);
          const { cliMain } = await import("./cron/setup.js");
          await cliMain();
        } else if (platformVal) {
          // Map --platform to --format for the schedule module
          process.argv = process.argv.filter((_, i) => i !== platformIdx && i !== platformIdx + 1);
          process.argv.push("--format", platformVal, "--install");
          const { cliMain } = await import("./schedule.js");
          cliMain();
        } else {
          // Auto-detect: install schedule artifacts for the current platform
          process.argv.push("--install");
          const { cliMain } = await import("./schedule.js");
          cliMain();
        }
        break;
      }
      case "list": {
        const { cliMain } = await import("./cron/setup.js");
        // Re-add 'list' so cron/setup.ts sees the subcommand
        process.argv = [process.argv[0], process.argv[1], "list", ...process.argv.slice(2)];
        await cliMain();
        break;
      }
      case "remove": {
        const { cliMain } = await import("./cron/setup.js");
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
  case "badge": {
    const { cliMain } = await import("./badge/badge.js");
    cliMain();
    break;
  }
  case "sync": {
    const { cliMain } = await import("./sync.js");
    await cliMain();
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
  case "export": {
    const { parseArgs } = await import("node:util");
    let values: ReturnType<typeof parseArgs>["values"];
    let positionals: string[];
    try {
      ({ values, positionals } = parseArgs({
        options: {
          output: { type: "string", short: "o" },
          since: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CLIError(`Invalid arguments: ${message}`, "INVALID_FLAG", "selftune export --help");
    }
    if (values.help) {
      console.log(`selftune export — Export SQLite data to JSONL snapshots

Usage:
  selftune export [tables...] [options]

Use this for portability, debugging, contribute flows, or explicit recovery
snapshots. Normal runtime reads and writes stay in SQLite.

Tables (default: all):
  telemetry    Session telemetry records
  skills       Skill usage records
  queries      Query log entries
  audit        Evolution audit trail
  evidence     Evolution evidence trail
  signals      Improvement signals
  orchestrate  Orchestrate run log

Options:
  -o, --output <dir>   Output directory (default: current directory)
  --since <date>       Only export records after this date (ISO 8601)
  -h, --help           Show this help`);
      process.exit(0);
    }
    const { exportToJsonl } = await import("./export.js");
    const outputDir = (values.output as string | undefined) ?? process.cwd();
    const since = values.since as string | undefined;
    const tables = positionals.length > 0 ? positionals : undefined;
    try {
      const result = exportToJsonl({ outputDir, since, tables });
      console.log(
        `Exported ${result.records} records to ${result.files.length} files in ${outputDir}`,
      );
      for (const file of result.files) {
        console.log(`  ${file}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CLIError(`Export failed: ${message}`, "OPERATION_FAILED", "selftune sync");
    }
    break;
  }
  case "export-canonical": {
    const { cliMain } = await import("./canonical-export.js");
    cliMain();
    break;
  }
  case "recover": {
    const { cliMain } = await import("./recover.js");
    cliMain();
    break;
  }
  case "orchestrate": {
    const { cliMain } = await import("./orchestrate.js");
    await cliMain();
    break;
  }
  case "registry": {
    const { cliMain } = await import("./registry/index.js");
    await cliMain();
    break;
  }
  case "alpha": {
    const sub = process.argv[2];
    if (!sub || sub === "--help" || sub === "-h") {
      console.log(`selftune alpha — Alpha program management

Usage:
  selftune alpha <subcommand> [options]

Subcommands:
  upload        Run a manual alpha data upload cycle
  relink        Re-authenticate with the cloud (revokes old key, issues new one)

Run 'selftune alpha <subcommand> --help' for subcommand-specific options.`);
      process.exit(0);
    }
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "upload": {
        const { parseArgs } = await import("node:util");
        let values: ReturnType<typeof parseArgs>["values"];
        try {
          ({ values } = parseArgs({
            options: {
              "dry-run": { type: "boolean", default: false },
              help: { type: "boolean", short: "h", default: false },
            },
            strict: true,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new CLIError(
            `Invalid arguments: ${message}`,
            "INVALID_FLAG",
            "selftune alpha upload --help",
          );
        }
        if (values.help) {
          console.log(`selftune alpha upload — Run a manual alpha data upload cycle

Usage:
  selftune alpha upload [--dry-run]

Options:
  --dry-run   Log what would be uploaded without sending
  -h, --help  Show this help message

Output:
  JSON summary: { enrolled, prepared, sent, failed, skipped, guidance? }`);
          process.exit(0);
        }

        const { SELFTUNE_CONFIG_PATH } = await import("./constants.js");
        const { getAlphaGuidance } = await import("./agent-guidance.js");
        const { readAlphaIdentity } = await import("./alpha-identity.js");
        const { getDb } = await import("./localdb/db.js");
        const { runUploadCycle } = await import("./alpha-upload/index.js");
        const { getSelftuneVersion, readConfiguredAgentType } =
          await import("./utils/selftune-meta.js");

        const identity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
        if (!identity?.enrolled) {
          const guidance = getAlphaGuidance(identity);
          throw new CLIError(
            `[alpha upload] ${guidance.message}`,
            "OPERATION_FAILED",
            guidance.next_command,
          );
        }

        if (!identity.user_id?.trim() || !identity.api_key?.trim()) {
          const guidance = getAlphaGuidance(identity);
          throw new CLIError(
            `[alpha upload] ${guidance.message}`,
            "OPERATION_FAILED",
            guidance.next_command,
          );
        }

        const db = getDb();

        const result = await runUploadCycle(db, {
          enrolled: true,
          userId: identity.user_id,
          agentType: readConfiguredAgentType(SELFTUNE_CONFIG_PATH, "unknown"),
          selftuneVersion: getSelftuneVersion(),
          dryRun: values["dry-run"] === true,
          apiKey: identity.api_key,
        });

        console.log(JSON.stringify(result, null, 2));
        process.exit(result.failed > 0 ? 1 : 0);
        break;
      }
      case "relink": {
        const { SELFTUNE_CONFIG_PATH } = await import("./constants.js");
        const { readAlphaIdentity, writeAlphaIdentity, generateUserId } =
          await import("./alpha-identity.js");
        const { buildVerificationUrl, pollDeviceCode, requestDeviceCode, tryOpenUrl } =
          await import("./auth/device-code.js");
        const { chmodSync } = await import("node:fs");

        const existingIdentity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
        process.stderr.write("[alpha relink] Starting device-code authentication flow...\n");

        const grant = await requestDeviceCode();
        const verificationUrlWithCode = buildVerificationUrl(
          grant.verification_url,
          grant.user_code,
        );

        console.log(
          JSON.stringify({
            level: "info",
            code: "device_code_issued",
            verification_url: grant.verification_url,
            verification_url_with_code: verificationUrlWithCode,
            user_code: grant.user_code,
            expires_in: grant.expires_in,
            message: `Open ${verificationUrlWithCode} to approve.`,
          }),
        );

        // Try to open browser
        if (tryOpenUrl(verificationUrlWithCode)) {
          process.stderr.write("[alpha relink] Browser opened. Waiting for approval...\n");
        } else {
          process.stderr.write(
            `[alpha relink] Could not open browser. Visit ${verificationUrlWithCode} manually.\n`,
          );
        }

        process.stderr.write("[alpha relink] Polling");
        const result = await pollDeviceCode(grant.device_code, grant.interval, grant.expires_in);
        process.stderr.write("\n[alpha relink] Approved!\n");

        const updatedIdentity = {
          enrolled: true,
          user_id: existingIdentity?.user_id ?? generateUserId(),
          cloud_user_id: result.cloud_user_id,
          cloud_org_id: result.org_id,
          email: existingIdentity?.email,
          display_name: existingIdentity?.display_name,
          consent_timestamp: new Date().toISOString(),
          api_key: result.api_key,
        };

        writeAlphaIdentity(SELFTUNE_CONFIG_PATH, updatedIdentity);
        chmodSync(SELFTUNE_CONFIG_PATH, 0o600);

        console.log(
          JSON.stringify({
            level: "info",
            code: "alpha_relinked",
            replaced_existing_key: Boolean(existingIdentity?.api_key),
            cloud_user_id: result.cloud_user_id,
            message: "Successfully relinked. Old key revoked by cloud during approval.",
          }),
        );
        break;
      }
      default:
        throw new CLIError(
          `Unknown alpha subcommand: ${sub}`,
          "UNKNOWN_COMMAND",
          "selftune alpha --help",
        );
    }
    break;
  }
  case "telemetry": {
    const { cliMain } = await import("./analytics.js");
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
      throw new CLIError(
        `Unknown hook: ${hookName ?? "(none)"}. Available: ${available}`,
        "UNKNOWN_COMMAND",
        "selftune hook prompt-log",
      );
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
        const { cliMain } = await import(`./adapters/${platform}/hook.js`);
        await cliMain();
        break;
      }
      case "install": {
        const { cliMain } = await import(`./adapters/${platform}/install.js`);
        await cliMain();
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
    throw new CLIError(`Unknown command: ${command}`, "UNKNOWN_COMMAND", "selftune --help");
}
