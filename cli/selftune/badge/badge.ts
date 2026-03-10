#!/usr/bin/env bun
/**
 * selftune badge -- Generate skill health badges for READMEs.
 *
 * Usage:
 *   selftune badge --skill <name> [--format svg|markdown|url] [--output <path>]
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG, TELEMETRY_LOG } from "../constants.js";
import { doctor } from "../observability.js";
import { computeStatus } from "../status.js";
import type { EvolutionAuditEntry, QueryLogRecord, SessionTelemetryRecord } from "../types.js";
import { readJsonl } from "../utils/jsonl.js";
import { readEffectiveSkillUsageRecords } from "../utils/skill-log.js";
import type { BadgeFormat } from "./badge-data.js";
import { findSkillBadgeData } from "./badge-data.js";
import { formatBadgeOutput } from "./badge-svg.js";

const HELP = `selftune badge \u2014 Generate skill health badges

Usage: selftune badge --skill <name> [options]

Options:
  --skill <name>    Skill name (required)
  --format <type>   Output format: svg, markdown, url (default: svg)
  --output <path>   Write to file instead of stdout
  --help            Show this help`;

const VALID_FORMATS = new Set<BadgeFormat>(["svg", "markdown", "url"]);

export function cliMain(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      skill: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (!values.skill) {
    console.error("Error: --skill is required\n");
    console.error(HELP);
    process.exit(1);
  }

  if (values.format && !VALID_FORMATS.has(values.format as BadgeFormat)) {
    console.error(`Error: invalid format '${values.format}'. Must be one of: svg, markdown, url\n`);
    console.error(HELP);
    process.exit(1);
  }

  const format: BadgeFormat =
    values.format && VALID_FORMATS.has(values.format as BadgeFormat)
      ? (values.format as BadgeFormat)
      : "svg";

  // Read log files
  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skillRecords = readEffectiveSkillUsageRecords();
  const queryRecords = readJsonl<QueryLogRecord>(QUERY_LOG);
  const auditEntries = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);

  // Run doctor for system health
  const doctorResult = doctor();

  // Compute status
  const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);

  // Find skill badge data
  const badgeData = findSkillBadgeData(result, values.skill);
  if (!badgeData) {
    console.error(`Skill not found: ${values.skill}`);
    process.exit(1);
  }

  // Generate output
  const output = formatBadgeOutput(badgeData, values.skill, format);

  if (values.output) {
    writeFileSync(values.output, output, "utf-8");
    console.log(`Badge written to ${values.output}`);
  } else {
    console.log(output);
  }
}

if (import.meta.main) {
  cliMain();
}
