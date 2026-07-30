import { parseArgs } from "node:util";

import type { WatchProgramInput } from "@selftune/orchestration/watch/programs";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export const WATCH_INTERNAL_HELP_FLAG = "selftune-internal-watch-help";

export const WATCH_HELP = `selftune watch — Monitor post-deploy skill health

Usage:
  selftune watch --skill <name> --skill-path <path> [options]

Options:
  --skill            Skill name (required)
  --skill-path       Path to SKILL.md (required)
  --window           Number of recent sessions to consider (default: 20)
  --threshold        Regression threshold below baseline (default: 0.1)
  --auto-rollback    Automatically rollback on regression detection
  --grade-threshold  Grade regression threshold (default: 0.15)
  --no-grade-watch   Disable grade-based regression watch (enabled by default)
  --sync-first       Refresh source-truth telemetry before reading watch inputs
  --sync-force       Force a full rescan during --sync-first
  --help             Show this help message`;

interface WatchValues {
  readonly skill?: string;
  readonly "skill-path"?: string;
  readonly window?: string;
  readonly threshold?: string;
  readonly "auto-rollback"?: boolean;
  readonly "grade-threshold"?: string;
  readonly "no-grade-watch"?: boolean;
  readonly "sync-first"?: boolean;
  readonly "sync-force"?: boolean;
  readonly help?: boolean;
}

export type PreparedWatchInput = WatchProgramInput;

export class WatchLegacyParseFailure extends Error {
  readonly _tag = "WatchLegacyParseFailure";

  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WatchLegacyParseFailure";
  }
}

export class WatchLegacyRuntimeFailure extends Error {
  readonly _tag = "WatchLegacyRuntimeFailure";

  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WatchLegacyRuntimeFailure";
  }
}

function parseLegacyWatchValues(args: ReadonlyArray<string>): WatchValues {
  try {
    const { values } = parseArgs({
      args,
      options: {
        skill: { type: "string" },
        "skill-path": { type: "string" },
        window: { type: "string", default: "20" },
        threshold: { type: "string", default: "0.1" },
        "auto-rollback": { type: "boolean", default: false },
        "grade-threshold": { type: "string", default: "0.15" },
        "no-grade-watch": { type: "boolean", default: false },
        "sync-first": { type: "boolean", default: false },
        "sync-force": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
    return values;
  } catch (cause) {
    throw new WatchLegacyParseFailure(cause);
  }
}

function requirePositiveInteger(value: string): number {
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed >= 1) return parsed;
  }
  throw new CLIError(
    "--window must be a positive integer >= 1.",
    "INVALID_FLAG",
    "selftune watch --window 20",
  );
}

function requireUnitInterval(value: string, flag: "threshold" | "grade-threshold"): number {
  if (/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Number.parseFloat(value);
    if (parsed >= 0 && parsed <= 1) return parsed;
  }
  throw new CLIError(
    `--${flag} must be a finite number between 0 and 1.`,
    "INVALID_FLAG",
    `selftune watch --${flag} ${flag === "threshold" ? "0.1" : "0.15"}`,
  );
}

export function parseAndValidateLegacyWatchArguments(
  args: ReadonlyArray<string>,
): PreparedWatchInput | undefined {
  const values = parseLegacyWatchValues(args);
  if (values.help) return undefined;

  const skillName = values.skill;
  const skillPath = values["skill-path"];
  if (!skillName || !skillPath) {
    throw new CLIError(
      "--skill and --skill-path are required.",
      "MISSING_FLAG",
      "Usage: selftune watch --skill <name> --skill-path <path>",
    );
  }

  const syncFirst = values["sync-first"] ?? false;
  const syncForce = values["sync-force"] ?? false;
  if (syncForce && !syncFirst) {
    throw new CLIError(
      "--sync-force requires --sync-first.",
      "INVALID_FLAG",
      "Add --sync-first when using --sync-force.",
    );
  }

  return {
    skillName,
    skillPath,
    windowSessions: requirePositiveInteger(values.window ?? "20"),
    regressionThreshold: requireUnitInterval(values.threshold ?? "0.1", "threshold"),
    gradeRegressionThreshold: requireUnitInterval(
      values["grade-threshold"] ?? "0.15",
      "grade-threshold",
    ),
    enableGradeWatch: !(values["no-grade-watch"] ?? false),
    autoRollback: values["auto-rollback"] ?? false,
    syncFirst,
    syncForce,
  };
}

function appendValue(target: string[], flag: string, value: string): void {
  target.push(flag, `:${value}`);
}

function appendBoolean(target: string[], flag: string, enabled: boolean): void {
  if (enabled) target.push(flag);
}

export function decodeWatchInternalValue(value: string): string {
  return value.startsWith(":") ? value.slice(1) : value;
}

export function prepareLegacyWatchArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const input = parseAndValidateLegacyWatchArguments(args);
  if (!input) return [`--${WATCH_INTERNAL_HELP_FLAG}`];

  const normalized: string[] = [];
  appendValue(normalized, "--skill", input.skillName);
  appendValue(normalized, "--skill-path", input.skillPath);
  normalized.push("--window", String(input.windowSessions));
  normalized.push("--threshold", String(input.regressionThreshold));
  normalized.push("--grade-threshold", String(input.gradeRegressionThreshold));
  appendBoolean(normalized, "--auto-rollback", input.autoRollback);
  appendBoolean(normalized, "--no-grade-watch", !input.enableGradeWatch);
  appendBoolean(normalized, "--sync-first", input.syncFirst);
  appendBoolean(normalized, "--sync-force", input.syncForce);
  return normalized;
}
