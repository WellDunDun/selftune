#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune ingest <agent>     — Ingest agent sessions (claude, codex, opencode, openclaw, pi, wrap-codex)
 *   selftune grade [mode]       — Grade skill sessions (auto, baseline)
 *   selftune evolve [target]    — Evolve skill descriptions (body, rollback)
 *   selftune improve            — Simplified alias for evolve / evolve body / search-run
 *   selftune search-run         — Run bounded package search over routing/body variants
 *   selftune eval <action>      — Evaluation tools (generate, unit-test, import, composability, family-overlap)
 *   selftune create <sub>       — Draft full skill packages
 *   selftune verify             — Verify a draft skill package
 *   selftune publish            — Publish a verified draft package
 *   selftune sync               — Sync source-truth telemetry across supported agents
 *   selftune orchestrate        — Run autonomous core loop (sync → status → evolve → watch)
 *   selftune run                — Simplified alias for orchestrate
 *   selftune init               — Initialize agent identity and config
 *   selftune uninstall          — Clean removal of all selftune data and config
 *   selftune status             — Show skill health summary
 *   selftune sets <sub>         — Build and materialize reusable project Skill Sets
 *   selftune watch              — Monitor post-deploy skill health
 *   selftune doctor             — Run health checks
 *   selftune dashboard          — Open visual data dashboard
 *   selftune daemon <sub>       — Run and inspect the local service
 *   selftune service <sub>      — Manage the OS-supervised background service
 *   selftune mcp serve          — Serve local skills over MCP stdio
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
 *   selftune registry <sub>    — Team skill distribution (push, suggest, install, sync, status, rollback, history, list)
 *   selftune team <sub>        — Authoritative Team Skill Set automation
 *   selftune alpha <subcommand> — Alpha program management (upload)
 *   selftune hook <name>        — Run a hook by name (prompt-log, session-stop, etc.)
 *   selftune codex <subcommand> — Codex platform hooks (hook, install)
 *   selftune opencode <sub>     — OpenCode platform hooks (hook, install)
 *   selftune cline <subcommand> — Cline platform hooks (hook, install)
 *   selftune pi <subcommand>    — Pi platform hooks (hook, install)
 */

import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";
import {
  INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND,
  INTERNAL_PACKAGE_COLLECTOR_COMMAND,
} from "@selftune/runtime/remote-library/package-bundle-collector-command";
import packageJson from "../../../package.json" with { type: "json" };

import { isEffectCliInvocation } from "./effect-cli/selection.js";

process.on("uncaughtException", handleCLIError);
process.on("unhandledRejection", handleCLIError);

const originalArgv = process.argv.slice(2);
const command = process.argv[2];
const isSkillSearch =
  command === "skills" &&
  ["search", "load", "activate", "active", "deactivate"].includes(process.argv[3] ?? "");
const internalCommand =
  command === INTERNAL_PACKAGE_COLLECTOR_COMMAND ||
  command === INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND;

if (command === INTERNAL_PACKAGE_COLLECTOR_COMMAND) {
  const { runEmbeddedPackageBundleCollector } =
    await import("@selftune/runtime/remote-library/package-bundle-collector-entry");
  runEmbeddedPackageBundleCollector();
} else if (command === INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND) {
  const packagePath = process.argv[3];
  if (!packagePath) throw new CLIError("Internal package path is required.", "MISSING_FLAG");
  const { encodePackageBundle } = await import("@selftune/runtime/remote-library/package-bundle");
  const bytes = encodePackageBundle(packagePath);
  process.stdout.write(`${JSON.stringify({ encoded_bytes: bytes.byteLength })}\n`);
}

if (!internalCommand && command === "--version") {
  console.log(packageJson.version);
  process.exit(0);
}

if (!internalCommand && (command === "--help" || command === "-h")) {
  console.log(`selftune — Skill observability and continuous improvement

Usage:
  selftune <command> [options]

Primary Lifecycle:
  status             Show skill health summary
  skills <sub>       Search, audit, consolidate, archive, and restore skills
  library            Reconcile all installed, cached, draft, and archived skills
  sets <sub>         Build and materialize reusable project Skill Sets
  verify             Verify a draft skill package
  publish            Publish a verified draft package
  improve            Improve skills with measured evidence
  run                Run autonomous improvement loop
  create <sub>       Draft full skill packages
  dashboard          Open visual data dashboard
  daemon <sub>       Run and inspect the local SelfTune service
  service <sub>      Manage the OS-supervised background service
  mcp serve          Serve the local skill registry over MCP stdio

Advanced / Stage Commands:
  evolve [target]    Evolve skill descriptions (body, rollback)
  search-run         Run bounded package search over routing/body variants
  eval <action>      Evaluation tools (generate, unit-test, import, composability, family-overlap)
  grade [mode]       Grade skill sessions (auto, baseline)
  watch              Monitor post-deploy skill health
  sync               Sync source-truth telemetry across supported agents
  orchestrate        Run autonomous core loop (sync → status → evolve → watch)
  ingest <agent>     Ingest agent sessions (claude, codex, opencode, openclaw, pi, wrap-codex)
  init               Initialize agent identity and config
  uninstall          Clean removal of all selftune data and config
  doctor             Run health checks
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
  registry <sub>    Team skill distribution (push, suggest, install, sync, status, rollback, history, list)
  team <sub>        Authoritative Team Skill Set automation
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
const FAST_COMMANDS: ReadonlySet<string> = new Set([
  "hook",
  "codex",
  "opencode",
  "cline",
  "pi",
  "daemon",
  "service",
  "mcp",
]);

// Track command usage (lazy import — skip for hooks and --help to avoid loading crypto/os)
if (
  !internalCommand &&
  !isSkillSearch &&
  command &&
  !FAST_COMMANDS.has(command) &&
  command !== "--help" &&
  command !== "-h"
) {
  import("@selftune/runtime/analytics")
    .then(({ trackEvent }) => trackEvent("command_run", { command }))
    .catch(() => {});
}

// Advisory update check (skip for hooks and platform hook commands — they must be fast — and --help)
if (
  !internalCommand &&
  !isSkillSearch &&
  command &&
  !FAST_COMMANDS.has(command) &&
  command !== "--help" &&
  command !== "-h"
) {
  const { checkForUpdates } = await import("@selftune/runtime/auto-update");
  await checkForUpdates();
}

if (!internalCommand && !command) {
  // Show status by default — same as `selftune status`
  const { runEffectCliMain } = await import("./effect-cli/runtime.js");
  runEffectCliMain("status", []);
} else if (!internalCommand) {
  if (command === "mcp") {
    const subcommand = process.argv[3];
    if (subcommand !== "serve") {
      throw new CLIError("Usage: selftune mcp serve", "INVALID_ARGUMENT");
    }
    const { runSkillRegistryStdio } = await import("@selftune/runtime/mcp/skill-registry");
    await runSkillRegistryStdio();
    process.exit(0);
  }
  if (!isSkillSearch) {
    const { startDashboardActionStream } =
      await import("@selftune/runtime/dashboard-action-stream");
    startDashboardActionStream(originalArgv);
  }

  // Route to the appropriate subcommand module.
  // We use dynamic imports so only the needed module is loaded.
  // Each module exports a cliMain() function that the router calls explicitly,
  // since import.meta.main is false for dynamically imported modules.
  process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

  if (isEffectCliInvocation(command, process.argv.slice(2))) {
    const { runEffectCliMain } = await import("./effect-cli/runtime.js");
    runEffectCliMain(command, process.argv.slice(2));
  } else {
    const { routeLegacyCommand } = await import("./commands/router.js");
    const handled = await routeLegacyCommand(command);

    if (!handled) {
      throw new CLIError(`Unknown command: ${command}`, "UNKNOWN_COMMAND", "selftune --help");
    }
  }
}
