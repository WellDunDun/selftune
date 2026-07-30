#!/usr/bin/env bun

import { parseArgs } from "node:util";

import {
  CANONICAL_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  TELEMETRY_LOG,
} from "./constants.js";
import { getDb } from "./localdb/db.js";
import {
  materializeFull,
  materializeIncremental,
  type MaterializeOptions,
  type MaterializeResult,
} from "./localdb/materialize.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";

export interface RecoverInput {
  full: boolean;
  force: boolean;
  since?: string;
  json: boolean;
  canonicalLog: string;
  telemetryLog: string;
  evolutionAuditLog: string;
  evolutionEvidenceLog: string;
  orchestrateRunLog: string;
}

export interface RecoverSummary {
  mode: "incremental" | "full";
  source: "legacy_jsonl_or_export_snapshot";
  since: string | null;
  force: boolean;
  result: MaterializeResult;
}

export interface RecoverDependencies {
  readonly getDatabase: typeof getDb;
  readonly materializeFull: typeof materializeFull;
  readonly materializeIncremental: typeof materializeIncremental;
}

const liveRecoverDependencies: RecoverDependencies = {
  getDatabase: getDb,
  materializeFull,
  materializeIncremental,
};

export const DEFAULT_RECOVER_INPUT: RecoverInput = {
  full: false,
  force: false,
  json: false,
  canonicalLog: CANONICAL_LOG,
  telemetryLog: TELEMETRY_LOG,
  evolutionAuditLog: EVOLUTION_AUDIT_LOG,
  evolutionEvidenceLog: EVOLUTION_EVIDENCE_LOG,
  orchestrateRunLog: ORCHESTRATE_RUN_LOG,
};

function buildMaterializeOptions(input: RecoverInput): MaterializeOptions {
  return {
    canonicalLogPath: input.canonicalLog,
    telemetryLogPath: input.telemetryLog,
    evolutionAuditPath: input.evolutionAuditLog,
    evolutionEvidencePath: input.evolutionEvidenceLog,
    orchestrateRunLogPath: input.orchestrateRunLog,
    force: input.force,
  };
}

export function printHumanSummary(summary: RecoverSummary): void {
  const rows = [
    `mode: ${summary.mode}`,
    "source: legacy JSONL or explicit export snapshot",
    `sessions: ${summary.result.sessions}`,
    `prompts: ${summary.result.prompts}`,
    `skill invocations: ${summary.result.skillInvocations}`,
    `execution facts: ${summary.result.executionFacts}`,
    `session telemetry: ${summary.result.sessionTelemetry}`,
    `legacy skill usage: ${summary.result.skillUsage}`,
    `evolution audit: ${summary.result.evolutionAudit}`,
    `evolution evidence: ${summary.result.evolutionEvidence}`,
    `orchestrate runs: ${summary.result.orchestrateRuns}`,
  ];
  console.log(`selftune recover\n${rows.map((row) => `  ${row}`).join("\n")}`);
}

export function runRecover(
  input: RecoverInput,
  dependencies: RecoverDependencies = liveRecoverDependencies,
): RecoverSummary {
  if (input.full && input.since) {
    throw new CLIError(
      "Cannot combine --full with --since.",
      "INVALID_FLAG",
      "Use either `selftune recover --full` or `selftune recover --since 2026-01-01`.",
    );
  }

  let sinceIso: string | null = null;
  if (input.since) {
    const parsed = new Date(input.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new CLIError(
        `Invalid --since date: ${input.since}`,
        "INVALID_FLAG",
        "selftune recover --since 2026-01-01",
      );
    }
    sinceIso = parsed.toISOString();
  }

  const db = dependencies.getDatabase();
  const materializeOptions = buildMaterializeOptions(input);
  if (!input.full) materializeOptions.since = sinceIso;

  const result = input.full
    ? dependencies.materializeFull(db, materializeOptions)
    : dependencies.materializeIncremental(db, materializeOptions);

  return {
    mode: input.full ? "full" : "incremental",
    source: "legacy_jsonl_or_export_snapshot",
    since: sinceIso,
    force: input.force,
    result,
  };
}

export function runRecoverProgram(
  input: RecoverInput,
  options: {
    readonly dependencies?: RecoverDependencies;
    readonly stdoutIsTTY?: boolean;
  } = {},
): RecoverSummary {
  const summary = runRecover(input, options.dependencies);
  if (input.json || !(options.stdoutIsTTY ?? process.stdout.isTTY)) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }
  return summary;
}

export function cliMain(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      full: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      since: { type: "string" },
      json: { type: "boolean", default: false },
      "canonical-log": { type: "string", default: CANONICAL_LOG },
      "telemetry-log": { type: "string", default: TELEMETRY_LOG },
      "evolution-audit-log": { type: "string", default: EVOLUTION_AUDIT_LOG },
      "evolution-evidence-log": { type: "string", default: EVOLUTION_EVIDENCE_LOG },
      "orchestrate-run-log": { type: "string", default: ORCHESTRATE_RUN_LOG },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune recover — Recover SQLite from legacy/exported JSONL

Usage:
  selftune recover [options]

Use this only for legacy backfill or explicit export-based recovery. Normal
operation should use \`selftune sync\`, which replays native source data into
SQLite and preserves alpha-upload compatibility.

Options:
  --full                           Rebuild SQLite tables from scratch
  --force                          Skip preflight rebuild guard for SQLite-only rows
  --since <date>                   Incrementally materialize records on/after date
  --canonical-log <path>           Canonical JSONL path
  --telemetry-log <path>           Session telemetry JSONL path
  --evolution-audit-log <path>     Evolution audit JSONL path
  --evolution-evidence-log <path>  Evolution evidence JSONL path
  --orchestrate-run-log <path>     Orchestrate runs JSONL path
  --json                           Output JSON summary
  -h, --help                       Show this help`);
    process.exit(0);
  }

  runRecoverProgram({
    full: values.full ?? false,
    force: values.force ?? false,
    since: values.since,
    json: values.json ?? false,
    canonicalLog: values["canonical-log"] ?? CANONICAL_LOG,
    telemetryLog: values["telemetry-log"] ?? TELEMETRY_LOG,
    evolutionAuditLog: values["evolution-audit-log"] ?? EVOLUTION_AUDIT_LOG,
    evolutionEvidenceLog: values["evolution-evidence-log"] ?? EVOLUTION_EVIDENCE_LOG,
    orchestrateRunLog: values["orchestrate-run-log"] ?? ORCHESTRATE_RUN_LOG,
  });
}

if (import.meta.main) {
  try {
    cliMain();
  } catch (error) {
    handleCLIError(error);
  }
}
