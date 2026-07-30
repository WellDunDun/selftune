import { parseArgs } from "node:util";

import {
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_MIN_SESSIONS,
} from "@selftune/runtime/skill-portfolio/audit";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export const SKILLS_INTERNAL_PARENT_HELP_FLAG = "selftune-internal-skills-parent-help";
export const SKILLS_INTERNAL_AUDIT_HELP_FLAG = "selftune-internal-skills-audit-help";
export const SKILLS_INTERNAL_QUARANTINED_HELP_FLAG = "selftune-internal-skills-quarantined-help";
export const SKILLS_INTERNAL_QUARANTINE_HELP_FLAG = "selftune-internal-skills-quarantine-help";
export const SKILLS_INTERNAL_RESTORE_HELP_FLAG = "selftune-internal-skills-restore-help";
export const SKILLS_INTERNAL_CONSOLIDATE_HELP_FLAG = "selftune-internal-skills-consolidate-help";
export const SKILLS_INTERNAL_CONSOLIDATION_ROLLBACK_HELP_FLAG =
  "selftune-internal-skills-consolidation-rollback-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

function validatePositiveInteger(
  value: string | undefined,
  flag: string,
  fallback: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CLIError(
      `${flag} must be a positive integer.`,
      "INVALID_FLAG",
      `selftune skills audit ${flag} ${fallback} --json`,
    );
  }
  return value;
}

function finish(
  subcommand: string,
  help: boolean,
  helpFlag: string,
  normalized: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return help ? [subcommand, `--${helpFlag}`] : [subcommand, ...normalized];
}

export function decodeSkillsInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

function prepareAudit(args: ReadonlyArray<string>): ReadonlyArray<string> {
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
  if (values.help) return ["audit", `--${SKILLS_INTERNAL_AUDIT_HELP_FLAG}`];
  const normalized: string[] = [];
  appendValue(
    normalized,
    "--min-sessions",
    validatePositiveInteger(values["min-sessions"], "--min-sessions", DEFAULT_MIN_SESSIONS),
  );
  appendValue(
    normalized,
    "--inactive-days",
    validatePositiveInteger(values["inactive-days"], "--inactive-days", DEFAULT_INACTIVE_DAYS),
  );
  for (const searchDir of values["search-dir"] ?? []) {
    appendValue(normalized, "--search-dir", searchDir);
  }
  if (values.json) normalized.push("--json");
  return ["audit", ...normalized];
}

function prepareQuarantined(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  if (values.json) normalized.push("--json");
  return finish("quarantined", values.help, SKILLS_INTERNAL_QUARANTINED_HELP_FLAG, normalized);
}

function prepareQuarantine(args: ReadonlyArray<string>): ReadonlyArray<string> {
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
  const normalized: string[] = [];
  appendValue(normalized, "--skill", values.skill);
  appendValue(normalized, "--skill-path", values["skill-path"]);
  if (values.yes) normalized.push("--yes");
  if (values["dry-run"]) normalized.push("--dry-run");
  if (values.json) normalized.push("--json");
  return finish("quarantine", values.help, SKILLS_INTERNAL_QUARANTINE_HELP_FLAG, normalized);
}

function prepareRestore(args: ReadonlyArray<string>): ReadonlyArray<string> {
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
  const normalized: string[] = [];
  appendValue(normalized, "--id", values.id);
  if (values["dry-run"]) normalized.push("--dry-run");
  if (values.json) normalized.push("--json");
  return finish("restore", values.help, SKILLS_INTERNAL_RESTORE_HELP_FLAG, normalized);
}

function prepareConsolidate(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      skill: { type: "string" },
      "all-safe": { type: "boolean", default: false },
      "search-dir": { type: "string", multiple: true },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--skill", values.skill);
  for (const searchDir of values["search-dir"] ?? []) {
    appendValue(normalized, "--search-dir", searchDir);
  }
  if (values["all-safe"]) normalized.push("--all-safe");
  if (values.yes) normalized.push("--yes");
  if (values["dry-run"]) normalized.push("--dry-run");
  if (values.json) normalized.push("--json");
  return finish("consolidate", values.help, SKILLS_INTERNAL_CONSOLIDATE_HELP_FLAG, normalized);
}

function prepareConsolidationRollback(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const normalized: string[] = [];
  appendValue(normalized, "--id", values.id);
  if (values.yes) normalized.push("--yes");
  if (values["dry-run"]) normalized.push("--dry-run");
  if (values.json) normalized.push("--json");
  return finish(
    "consolidation-rollback",
    values.help,
    SKILLS_INTERNAL_CONSOLIDATION_ROLLBACK_HELP_FLAG,
    normalized,
  );
}

function prepareLeaf(subcommand: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  switch (subcommand) {
    case "audit":
      return prepareAudit(args);
    case "quarantined":
      return prepareQuarantined(args);
    case "quarantine":
      return prepareQuarantine(args);
    case "restore":
      return prepareRestore(args);
    case "consolidate":
      return prepareConsolidate(args);
    case "consolidation-rollback":
      return prepareConsolidationRollback(args);
    default:
      throw new CLIError(
        `Unknown skills subcommand: ${subcommand}`,
        "UNKNOWN_COMMAND",
        "selftune skills --help",
      );
  }
}

export function prepareLegacySkillsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const [subcommand, ...leafArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return [`--${SKILLS_INTERNAL_PARENT_HELP_FLAG}`];
  }
  try {
    return prepareLeaf(subcommand, leafArgs);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      `selftune skills ${subcommand} --help`,
    );
  }
}
