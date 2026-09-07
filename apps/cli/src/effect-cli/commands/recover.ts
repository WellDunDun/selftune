import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  CANONICAL_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import type { RecoverInput } from "@selftune/runtime/recover";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { RECOVER_INTERNAL_HELP_FLAG } from "../compatibility/recover.js";

export type RecoverAction = (input: RecoverInput) => Effect.Effect<void, CLIError>;

export const RECOVER_HELP = `selftune recover — Recover SQLite from legacy/exported JSONL

Usage:
  selftune recover [options]

Use this only for legacy backfill or explicit export-based recovery. Normal
operation should use \`selftune sync\`, which replays native source data into
SQLite while retaining local history.

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
  -h, --help                       Show this help`;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function recoverImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load recover support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toRecoverCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Recovery failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune recover --help",
      );
}

export const runRecoverAction = Effect.fn("selftune.cli.recover")(function* (input: RecoverInput) {
  const recover = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/recover"),
    catch: recoverImportFailure,
  });
  yield* Effect.try({
    try: () => recover.runRecoverProgram(input),
    catch: toRecoverCliError,
  });
});

export function makeRecoverCommand(action: RecoverAction = runRecoverAction) {
  return Command.make(
    "recover",
    {
      internalHelp: Flag.boolean(RECOVER_INTERNAL_HELP_FLAG),
      full: Flag.boolean("full").pipe(Flag.withDescription("Rebuild SQLite tables from scratch")),
      force: Flag.boolean("force").pipe(
        Flag.withDescription("Skip the preflight guard for SQLite-only rows"),
      ),
      since: Flag.string("since").pipe(
        Flag.withDescription("Incrementally materialize records on or after this date"),
        Flag.optional,
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Output a JSON summary")),
      canonicalLog: Flag.string("canonical-log").pipe(
        Flag.withDescription("Canonical JSONL path"),
        Flag.withDefault(CANONICAL_LOG),
      ),
      telemetryLog: Flag.string("telemetry-log").pipe(
        Flag.withDescription("Session telemetry JSONL path"),
        Flag.withDefault(TELEMETRY_LOG),
      ),
      evolutionAuditLog: Flag.string("evolution-audit-log").pipe(
        Flag.withDescription("Evolution audit JSONL path"),
        Flag.withDefault(EVOLUTION_AUDIT_LOG),
      ),
      evolutionEvidenceLog: Flag.string("evolution-evidence-log").pipe(
        Flag.withDescription("Evolution evidence JSONL path"),
        Flag.withDefault(EVOLUTION_EVIDENCE_LOG),
      ),
      orchestrateRunLog: Flag.string("orchestrate-run-log").pipe(
        Flag.withDescription("Orchestrate runs JSONL path"),
        Flag.withDefault(ORCHESTRATE_RUN_LOG),
      ),
    },
    (input) => {
      if (input.internalHelp) return Console.log(RECOVER_HELP);
      return action({
        full: input.full,
        force: input.force,
        since: Option.getOrUndefined(input.since),
        json: input.json,
        canonicalLog: input.canonicalLog,
        telemetryLog: input.telemetryLog,
        evolutionAuditLog: input.evolutionAuditLog,
        evolutionEvidenceLog: input.evolutionEvidenceLog,
        orchestrateRunLog: input.orchestrateRunLog,
      });
    },
  ).pipe(
    Command.withDescription(
      "Recover SQLite from legacy or explicitly exported JSONL. Normal operation should use selftune sync.",
    ),
    Command.withExamples([
      { command: "selftune recover", description: "Incrementally recover all JSONL records" },
      {
        command: "selftune recover --since 2026-01-01",
        description: "Incrementally recover records on or after a date",
      },
      {
        command: "selftune recover --full --force",
        description: "Rebuild from scratch after acknowledging the preflight risk",
      },
    ]),
  );
}
