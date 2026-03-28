#!/usr/bin/env bun
/**
 * selftune badge -- Generate skill health badges for READMEs.
 *
 * Usage:
 *   selftune badge --skill <name> [--format svg|markdown|url] [--output <path>]
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { getDb } from "../localdb/db.js";
import {
  queryEvolutionAudit,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "../localdb/queries.js";
import { doctor } from "../observability.js";
import { computeStatus } from "../status.js";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
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
    throw new CLIError("--skill is required", "MISSING_FLAG", "selftune badge --skill <name>");
  }

  if (values.format && !VALID_FORMATS.has(values.format as BadgeFormat)) {
    throw new CLIError(
      `Invalid format '${values.format}'. Must be one of: svg, markdown, url`,
      "INVALID_FLAG",
      "selftune badge --skill <name> --format svg",
    );
  }

  const format: BadgeFormat =
    values.format && VALID_FORMATS.has(values.format as BadgeFormat)
      ? (values.format as BadgeFormat)
      : "svg";

  // Read log files from SQLite
  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
  const queryRecords = queryQueryLog(db) as QueryLogRecord[];
  const auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];

  // Run doctor for system health
  const doctorResult = await doctor();

  // Compute status
  const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);

  // Find skill badge data
  const badgeData = findSkillBadgeData(result, values.skill);
  if (!badgeData) {
    throw new CLIError(
      `Skill not found: ${values.skill}`,
      "MISSING_DATA",
      "selftune status --json  # list available skill names",
    );
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
  cliMain().catch(handleCLIError);
}
