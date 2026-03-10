#!/usr/bin/env bun
/**
 * selftune CLI entry point.
 *
 * Usage:
 *   selftune init [options]           — Initialize agent identity and config
 *   selftune evals [options]          — Generate eval sets from hook logs
 *   selftune grade [options]          — Grade a skill session
 *   selftune auto-grade [options]     — Auto-find session, derive expectations, and grade
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
 *   selftune workflows [options]    — Discover multi-skill workflow patterns
 *   selftune unit-test [options]     — Run or generate skill unit tests
 *   selftune import-skillsbench [options] — Import SkillsBench task corpus as eval entries
 *   selftune quickstart                — Guided onboarding: init, replay, status, and suggestions
 *   selftune repair-skill-usage [options] — Rebuild trustworthy skill usage from transcripts
 *   selftune hook <name>               — Run a hook by name (portable hook dispatch)
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
  auto-grade         Auto-find session, derive expectations, and grade
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
  badge              Generate skill health badges for READMEs
  baseline           Measure skill value vs. no-skill baseline
  composability      Analyze skill co-occurrence conflicts
  workflows          Discover and manage multi-skill workflows
  unit-test          Run or generate skill unit tests
  import-skillsbench Import SkillsBench task corpus as eval entries
  quickstart         Guided onboarding: init, replay, status, and suggestions
  repair-skill-usage Rebuild trustworthy skill usage from transcripts
  hook <name>        Run a hook by name (prompt-log, session-stop, etc.)

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
  case "auto-grade": {
    const { cliMain } = await import("./grading/auto-grade.js");
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
    await cliMain();
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
  case "badge": {
    const { cliMain } = await import("./badge/badge.js");
    cliMain();
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
    const { parseArgs } = await import("node:util");
    const { readJsonl } = await import("./utils/jsonl.js");
    const { TELEMETRY_LOG } = await import("./constants.js");
    const { analyzeComposability } = await import("./eval/composability.js");
    const { readEffectiveSkillUsageRecords } = await import("./utils/skill-log.js");
    const { values } = parseArgs({
      options: {
        skill: { type: "string" },
        window: { type: "string" },
        "telemetry-log": { type: "string" },
        "min-occurrences": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    });
    if (!values.skill) {
      console.error("[ERROR] --skill <name> is required.");
      process.exit(1);
    }
    const logPath = values["telemetry-log"] ?? TELEMETRY_LOG;
    const telemetry = readJsonl<import("./types.js").SessionTelemetryRecord>(logPath);
    const windowSize = values.window ? Number.parseInt(values.window, 10) : undefined;
    if (windowSize !== undefined && (Number.isNaN(windowSize) || windowSize < 0)) {
      console.error("[ERROR] --window must be a non-negative integer.");
      process.exit(1);
    }
    const minOccurrences = values["min-occurrences"]
      ? Number.parseInt(values["min-occurrences"], 10)
      : undefined;
    if (minOccurrences !== undefined && (Number.isNaN(minOccurrences) || minOccurrences < 0)) {
      console.error("[ERROR] --min-occurrences must be a non-negative integer.");
      process.exit(1);
    }

    // Use v2 if skill usage log exists and has data
    const usageRecords = readEffectiveSkillUsageRecords();

    if (usageRecords.length > 0) {
      const { analyzeComposabilityV2 } = await import("./eval/composability-v2.js");
      const report = analyzeComposabilityV2(values.skill, telemetry, usageRecords, {
        window: windowSize,
        minOccurrences,
      });

      // JSON output: non-TTY or --json flag
      if (values.json || !process.stdout.isTTY) {
        console.log(JSON.stringify(report, null, 2));
        break;
      }

      // Human-readable formatted output
      const windowLabel = windowSize ? `${windowSize}` : "all";
      console.log(`Composability Report: ${values.skill}`);
      console.log(`Analyzed: ${report.total_sessions_analyzed} sessions | Window: ${windowLabel}`);

      // Co-occurring Skills
      if (report.pairs.length > 0) {
        console.log("\nCo-occurring Skills:");
        for (const p of report.pairs) {
          const sign = p.synergy_score >= 0 ? "+" : "";
          const synergy = `${sign}${p.synergy_score.toFixed(2)}`;
          let icon = "";
          if (p.workflow_candidate) icon = "  \u2713 workflow candidate";
          else if (p.conflict_detected) icon = "  \u26A0 conflict";
          console.log(
            `  ${p.skill_a} + ${p.skill_b}     (${p.co_occurrence_count} sessions)  synergy: ${synergy}${icon}`,
          );
        }
      }

      // Detected Sequences
      if (report.sequences.length > 0) {
        console.log("\nDetected Sequences:");
        for (let i = 0; i < report.sequences.length; i++) {
          const seq = report.sequences[i];
          const chain = seq.skills.join(" \u2192 ");
          const consistency = Math.round(seq.sequence_consistency * 100);
          console.log(
            `  ${i + 1}. ${chain}  (${seq.occurrence_count}x, ${consistency}% consistent)`,
          );
        }
      }

      // Workflow Candidates
      if (report.workflow_candidates.length > 0) {
        console.log("\nWorkflow Candidates:");
        for (const wf of report.workflow_candidates) {
          const pct = Math.round(wf.synergy_score * 100);
          const workflowId = `${wf.skill_a}→${wf.skill_b}`;
          console.log(
            `  \u2022 "${wf.skill_a} + ${wf.skill_b}" \u2014 used together ${wf.co_occurrence_count} times with ${pct}% fewer errors`,
          );
          console.log(`    \u2192 Run \`selftune workflows save "${workflowId}"\` to codify`);
        }
      }

      // Conflicts
      const conflicts = report.pairs.filter((p) => p.conflict_detected);
      if (conflicts.length > 0) {
        console.log("\nConflicts:");
        for (const c of conflicts) {
          const pct = Math.round(Math.abs(c.synergy_score) * 100);
          console.log(
            `  \u2022 "${c.skill_a} + ${c.skill_b}" \u2014 ${pct}% more errors together (${c.co_occurrence_count} sessions)`,
          );
        }
      }
    } else {
      // Fallback to v1
      const report = analyzeComposability(values.skill, telemetry, windowSize);
      console.log(JSON.stringify(report, null, 2));
    }
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
  case "hook": {
    // Dispatch to the appropriate hook file by name.
    // Usage: selftune hook <hook-name>
    // This enables portable hook commands (npx selftune hook prompt-log)
    // instead of hardcoded absolute paths in settings.json.
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
    // Spawn the hook as a subprocess so import.meta.main is true
    // and the hook's stdin-reading logic executes correctly.
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
