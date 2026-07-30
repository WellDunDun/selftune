import { parseArgs } from "node:util";

import { CLIError } from "../utils/cli-error.js";
import { DEFAULT_INACTIVE_DAYS, DEFAULT_MIN_SESSIONS } from "./audit.js";
import { SKILLS_HELP } from "./help.js";
import {
  formatSkillsAudit,
  formatSkillsQuarantined,
  formatSkillsReceipt,
  runSkillsAuditProgram,
  runSkillsQuarantinedProgram,
  runSkillsQuarantineProgram,
  runSkillsRestoreProgram,
} from "./programs.js";

function parsePositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CLIError(
      `${flag} must be a positive integer.`,
      "INVALID_FLAG",
      `selftune skills audit ${flag} ${fallback} --json`,
    );
  }
  return Number(value);
}

function emit(value: string): void {
  process.stdout.write(`${value}\n`);
}

function printHelp(): void {
  emit(SKILLS_HELP);
}

export async function cliMain(): Promise<void> {
  const subcommand = process.argv[2];
  const args = process.argv.slice(3);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand === "audit") {
    const { values } = parseArgs({
      args,
      options: {
        "min-sessions": { type: "string" },
        "inactive-days": { type: "string" },
        "search-dir": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    const minSessions = parsePositiveInteger(
      values["min-sessions"],
      "--min-sessions",
      DEFAULT_MIN_SESSIONS,
    );
    const inactiveDays = parsePositiveInteger(
      values["inactive-days"],
      "--inactive-days",
      DEFAULT_INACTIVE_DAYS,
    );
    const result = runSkillsAuditProgram({
      minSessions,
      inactiveDays,
      searchDirs: values["search-dir"],
    });
    emit(formatSkillsAudit(result, values.json));
    return;
  }

  if (subcommand === "quarantined") {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    emit(formatSkillsQuarantined(runSkillsQuarantinedProgram(), values.json));
    return;
  }

  if (subcommand === "quarantine") {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        "skill-path": { type: "string" },
        yes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    const receipt = runSkillsQuarantineProgram({
      skill: values.skill,
      skillPath: values["skill-path"],
      approved: values.yes,
      dryRun: values["dry-run"],
    });
    emit(formatSkillsReceipt(receipt, values.json));
    return;
  }

  if (subcommand === "restore") {
    const { values } = parseArgs({
      args,
      options: {
        id: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      printHelp();
      return;
    }
    const receipt = runSkillsRestoreProgram({
      id: values.id,
      dryRun: values["dry-run"],
    });
    emit(formatSkillsReceipt(receipt, values.json));
    return;
  }

  throw new CLIError(
    `Unknown skills subcommand: ${subcommand}`,
    "UNKNOWN_COMMAND",
    "selftune skills --help",
  );
}
