#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune evals [options]          — Generate eval sets from hook logs
 *   selftune grade [options]          — Grade a skill session
 *   selftune ingest-codex [options]   — Ingest Codex rollout logs
 *   selftune ingest-opencode [options] — Ingest OpenCode sessions
 *   selftune wrap-codex [options]     — Wrap codex exec with telemetry
 *   selftune evolve [options]         — Evolve a skill description via failure patterns
 *   selftune rollback [options]       — Rollback a skill to its pre-evolution state
 *   selftune watch [options]          — Monitor post-deploy skill health
 *   selftune doctor                   — Run health checks
 */

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
  console.log(`selftune — Skill observability and continuous improvement

Usage:
  selftune <command> [options]

Commands:
  evals              Generate eval sets from hook logs
  grade              Grade a skill session
  ingest-codex       Ingest Codex rollout logs
  ingest-opencode    Ingest OpenCode sessions
  wrap-codex         Wrap codex exec with telemetry
  evolve             Evolve a skill description via failure patterns
  rollback           Rollback a skill to its pre-evolution state
  watch              Monitor post-deploy skill health
  doctor             Run health checks

Run 'selftune <command> --help' for command-specific options.`);
  process.exit(0);
}

// Route to the appropriate subcommand module.
// We use dynamic imports so only the needed module is loaded.
switch (command) {
  case "evals": {
    // Strip "evals" from argv so parseArgs in the module sees the right args
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./eval/hooks-to-evals.js");
    break;
  }
  case "grade": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./grading/grade-session.js");
    break;
  }
  case "ingest-codex": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./ingestors/codex-rollout.js");
    break;
  }
  case "ingest-opencode": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./ingestors/opencode-ingest.js");
    break;
  }
  case "wrap-codex": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./ingestors/codex-wrapper.js");
    break;
  }
  case "evolve": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./evolution/evolve.js");
    break;
  }
  case "rollback": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./evolution/rollback.js");
    break;
  }
  case "watch": {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./monitoring/watch.js");
    break;
  }
  case "doctor": {
    const { doctor } = await import("./observability.js");
    const result = doctor();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.healthy ? 0 : 1);
    break;
  }
  default:
    console.error(`Unknown command: ${command}\nRun 'selftune --help' for available commands.`);
    process.exit(1);
}
