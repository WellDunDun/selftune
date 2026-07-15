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

interface RecoverSummary {
  mode: "incremental" | "full";
  source: "legacy_jsonl_or_export_snapshot";
  since: string | null;
  force: boolean;
  result: MaterializeResult;
}

function buildMaterializeOptions(values: Record<string, unknown>): MaterializeOptions {
  return {
    canonicalLogPath: (values["canonical-log"] as string | undefined) ?? CANONICAL_LOG,
    telemetryLogPath: (values["telemetry-log"] as string | undefined) ?? TELEMETRY_LOG,
    evolutionAuditPath:
      (values["evolution-audit-log"] as string | undefined) ?? EVOLUTION_AUDIT_LOG,
    evolutionEvidencePath:
      (values["evolution-evidence-log"] as string | undefined) ?? EVOLUTION_EVIDENCE_LOG,
    orchestrateRunLogPath:
      (values["orchestrate-run-log"] as string | undefined) ?? ORCHESTRATE_RUN_LOG,
    force: (values.force as boolean | undefined) ?? false,
  };
}

function printHumanSummary(summary: RecoverSummary): void {
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

  if (values.full && values.since) {
    throw new CLIError(
      "Cannot combine --full with --since.",
      "INVALID_FLAG",
      "Use either `selftune recover --full` or `selftune recover --since 2026-01-01`.",
    );
  }

  let sinceIso: string | null = null;
  if (values.since) {
    const parsed = new Date(values.since as string);
    if (Number.isNaN(parsed.getTime())) {
      throw new CLIError(
        `Invalid --since date: ${values.since}`,
        "INVALID_FLAG",
        "selftune recover --since 2026-01-01",
      );
    }
    sinceIso = parsed.toISOString();
  }

  const db = getDb();
  const materializeOptions = buildMaterializeOptions(values);
  if (!values.full) materializeOptions.since = sinceIso;

  const result = values.full
    ? materializeFull(db, materializeOptions)
    : materializeIncremental(db, materializeOptions);

  const summary: RecoverSummary = {
    mode: values.full ? "full" : "incremental",
    source: "legacy_jsonl_or_export_snapshot",
    since: sinceIso,
    force: (values.force as boolean | undefined) ?? false,
    result,
  };

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);
}

if (import.meta.main) {
  try {
    cliMain();
  } catch (error) {
    handleCLIError(error);
  }
}
