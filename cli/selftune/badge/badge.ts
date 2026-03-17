#!/usr/bin/env bun
/**
 * selftune badge -- Generate skill health badges for READMEs.
 *
 * Usage:
 *   selftune badge --skill <name> [--format svg|markdown|url] [--output <path>]
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDb } from "../localdb/db.js";
import { queryEvolutionAudit, queryQueryLog, querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import { doctor } from "../observability.js";
import { computeStatus } from "../status.js";
import type { EvolutionAuditEntry, QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "../types.js";
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

export async function cliMain(): Promise<void> {
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

  // Read log files from SQLite
  const db = openDb();
  let telemetry: SessionTelemetryRecord[];
  let skillRecords: SkillUsageRecord[];
  let queryRecords: QueryLogRecord[];
  let auditEntries: EvolutionAuditEntry[];
  try {
    telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
    skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
    queryRecords = queryQueryLog(db) as QueryLogRecord[];
    auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
  } finally {
    db.close();
  }

  // Run doctor for system health
  const doctorResult = await doctor();

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
