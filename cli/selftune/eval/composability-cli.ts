/**
 * CLI entrypoint for skill composability analysis.
 *
 * Usage:
 *   selftune composability --skill <name> [--window <n>] [--telemetry-log <path>]
 */

import { parseArgs } from "node:util";
import { TELEMETRY_LOG } from "../constants.js";
import { readJsonl } from "../utils/jsonl.js";
import { analyzeComposability } from "./composability.js";

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      skill: { type: "string" },
      window: { type: "string" },
      "telemetry-log": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune composability — Analyze skill co-occurrence conflicts

Usage:
  selftune composability --skill <name> [options]

Options:
  --skill            Skill name (required)
  --window           Only consider the last N sessions
  --telemetry-log    Path to telemetry log (default: ~/.claude/telemetry.jsonl)
  --help             Show this help message`);
    process.exit(0);
  }

  if (!values.skill) {
    console.error("[ERROR] --skill <name> is required.");
    process.exit(1);
  }

  const logPath = values["telemetry-log"] ?? TELEMETRY_LOG;
  const telemetry = readJsonl(logPath);
  const windowSize = values.window ? Number.parseInt(values.window, 10) : undefined;
  const report = analyzeComposability(values.skill, telemetry, windowSize);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  cliMain();
}
