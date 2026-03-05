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
 *   selftune ingest-openclaw [options] — Ingest OpenClaw sessions
 *   selftune wrap-codex [options]     — Wrap codex exec with telemetry
 *   selftune replay [options]         — Replay Claude Code transcripts into logs
 *   selftune contribute [options]     — Export anonymized skill data for community
 *   selftune evolve [options]         — Evolve a skill description via failure patterns
 *   selftune evolve-body [options]    — Evolve a skill body or routing table
 *   selftune rollback [options]       — Rollback a skill to its pre-evolution state
 *   selftune watch [options]          — Monitor post-deploy skill health
 *   selftune doctor                   — Run health checks
 *   selftune status                   — Show skill health summary
 *   selftune last                     — Show last session details
 *   selftune dashboard [options]      — Open visual data dashboard
 *   selftune cron [options]           — Manage OpenClaw cron jobs (setup, list, remove)
 *   selftune baseline [options]      — Measure skill value vs. no-skill baseline
 *   selftune composability [options]  — Analyze skill co-occurrence conflicts
 *   selftune unit-test [options]     — Run or generate skill unit tests
 *   selftune import-skillsbench [options] — Import SkillsBench task corpus as eval entries
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
  ingest-openclaw    Ingest OpenClaw sessions
  wrap-codex         Wrap codex exec with telemetry
  replay             Replay Claude Code transcripts into logs
  contribute         Export anonymized skill data for community
  evolve             Evolve a skill description via failure patterns
  evolve-body        Evolve a skill body or routing table
  rollback           Rollback a skill to its pre-evolution state
  watch              Monitor post-deploy skill health
  doctor             Run health checks
  status             Show skill health summary
  last               Show last session details
  dashboard          Open visual data dashboard
  cron               Manage OpenClaw cron jobs (setup, list, remove)
  baseline           Measure skill value vs. no-skill baseline
  composability      Analyze skill co-occurrence conflicts
  unit-test          Run or generate skill unit tests
  import-skillsbench Import SkillsBench task corpus as eval entries

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
  case "ingest-openclaw": {
    const { cliMain } = await import("./ingestors/openclaw-ingest.js");
    cliMain();
    break;
  }
  case "wrap-codex": {
    const { cliMain } = await import("./ingestors/codex-wrapper.js");
    await cliMain();
    break;
  }
  case "replay": {
    const { cliMain } = await import("./ingestors/claude-replay.js");
    cliMain();
    break;
  }
  case "contribute": {
    const { cliMain } = await import("./contribute/contribute.js");
    cliMain();
    break;
  }
  case "evolve": {
    const { cliMain } = await import("./evolution/evolve.js");
    await cliMain();
    break;
  }
  case "evolve-body": {
    const { cliMain } = await import("./evolution/evolve-body.js");
    await cliMain();
    break;
  }
  case "baseline": {
    const { cliMain } = await import("./eval/baseline.js");
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
  case "cron": {
    const { cliMain } = await import("./cron/setup.js");
    await cliMain();
    break;
  }
  case "unit-test": {
    const { cliMain } = await import("./eval/unit-test-cli.js");
    await cliMain();
    break;
  }
  case "import-skillsbench": {
    const { cliMain } = await import("./eval/import-skillsbench.js");
    cliMain();
    break;
  }
  case "composability": {
    const { cliMain } = await import("./eval/composability-cli.js");
    cliMain();
    break;
  }
  default:
    console.error(`Unknown command: ${command}\nRun 'selftune --help' for available commands.`);
    process.exit(1);
}
