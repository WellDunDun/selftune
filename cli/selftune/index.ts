#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune init [options]           — Initialize agent identity and config
 *   selftune evals [options]          — Generate eval sets from hook logs
 *   selftune grade [options]          — Grade a skill session
 *   selftune ingest-codex [options]   — Ingest Codex rollout logs
 *   selftune ingest-opencode [options] — Ingest OpenCode sessions
 *   selftune wrap-codex [options]     — Wrap codex exec with telemetry
 *   selftune evolve [options]         — Evolve a skill description via failure patterns
 *   selftune rollback [options]       — Rollback a skill to its pre-evolution state
 *   selftune watch [options]          — Monitor post-deploy skill health
 *   selftune doctor                   — Run health checks
 *   selftune status                   — Show skill health summary
 *   selftune last                     — Show last session details
 *   selftune dashboard [options]      — Open visual data dashboard
 */

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
  console.log(`selftune — Skill observability and continuous improvement

Usage:
  selftune <command> [options]

Commands:
  init               Initialize agent identity and config
  evals              Generate eval sets from hook logs
  grade              Grade a skill session
  ingest-codex       Ingest Codex rollout logs
  ingest-opencode    Ingest OpenCode sessions
  wrap-codex         Wrap codex exec with telemetry
  evolve             Evolve a skill description via failure patterns
  rollback           Rollback a skill to its pre-evolution state
  watch              Monitor post-deploy skill health
  doctor             Run health checks
  status             Show skill health summary
  last               Show last session details
  dashboard          Open visual data dashboard

Run 'selftune <command> --help' for command-specific options.`);
  process.exit(0);
}

// Route to the appropriate subcommand module.
// We use dynamic imports so only the needed module is loaded.
// Each module exports a cliMain() function that the router calls explicitly,
// since import.meta.main is false for dynamically imported modules.
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

switch (command) {
  case "init": {
    const { cliMain } = await import("./init.js");
    await cliMain();
    break;
  }
  case "evals": {
    const { cliMain } = await import("./eval/hooks-to-evals.js");
    cliMain();
    break;
  }
  case "grade": {
    const { cliMain } = await import("./grading/grade-session.js");
    await cliMain();
    break;
  }
  case "ingest-codex": {
    const { cliMain } = await import("./ingestors/codex-rollout.js");
    cliMain();
    break;
  }
  case "ingest-opencode": {
    const { cliMain } = await import("./ingestors/opencode-ingest.js");
    cliMain();
    break;
  }
  case "wrap-codex": {
    const { cliMain } = await import("./ingestors/codex-wrapper.js");
    await cliMain();
    break;
  }
  case "evolve": {
    const { cliMain } = await import("./evolution/evolve.js");
    await cliMain();
    break;
  }
  case "rollback": {
    const { cliMain } = await import("./evolution/rollback.js");
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
  default:
    console.error(`Unknown command: ${command}\nRun 'selftune --help' for available commands.`);
    process.exit(1);
}
