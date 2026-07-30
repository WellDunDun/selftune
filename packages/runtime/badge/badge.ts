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
import type { BadgeData, BadgeFormat } from "./badge-data.js";
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

export interface BadgeInput {
  skill: string;
  format: BadgeFormat;
  output?: string;
}

export interface BadgeProgramResult {
  output: string;
  outputPath: string | null;
}

export interface BadgeDependencies {
  readonly loadBadgeData: (skill: string) => Promise<BadgeData | null>;
  readonly formatOutput: typeof formatBadgeOutput;
  readonly writeOutput: (path: string, output: string) => void;
  readonly print: (message: string) => void;
}

const loadBadgeData = async (skill: string): Promise<BadgeData | null> => {
  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const skillRecords = querySkillUsageRecords(db) as SkillUsageRecord[];
  const queryRecords = queryQueryLog(db) as QueryLogRecord[];
  const auditEntries = queryEvolutionAudit(db) as EvolutionAuditEntry[];
  const doctorResult = await doctor();
  const result = computeStatus(telemetry, skillRecords, queryRecords, auditEntries, doctorResult);
  return findSkillBadgeData(result, skill);
};

const liveBadgeDependencies: BadgeDependencies = {
  loadBadgeData,
  formatOutput: formatBadgeOutput,
  writeOutput: (path, output) => writeFileSync(path, output, "utf-8"),
  print: (message) => console.log(message),
};

export async function runBadgeProgram(
  input: BadgeInput,
  dependencies: BadgeDependencies = liveBadgeDependencies,
): Promise<BadgeProgramResult> {
  if (!input.skill.trim()) {
    throw new CLIError("--skill is required", "MISSING_FLAG", "selftune badge --skill <name>");
  }

  const badgeData = await dependencies.loadBadgeData(input.skill);
  if (!badgeData) {
    throw new CLIError(
      `Skill not found: ${input.skill}`,
      "MISSING_DATA",
      "selftune status --json  # list available skill names",
    );
  }

  const output = dependencies.formatOutput(badgeData, input.skill, input.format);
  if (input.output) {
    dependencies.writeOutput(input.output, output);
    dependencies.print(`Badge written to ${input.output}`);
    return { output, outputPath: input.output };
  }

  dependencies.print(output);
  return { output, outputPath: null };
}

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
  await runBadgeProgram({
    skill: values.skill,
    format,
    ...(values.output ? { output: values.output } : {}),
  });
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
