import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { EXPORT_TABLE_NAMES, type ExportInput } from "@selftune/runtime/export-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { EXPORT_INTERNAL_HELP_FLAG } from "../compatibility/export.js";

export type ExportAction = (input: ExportInput) => Effect.Effect<void, CLIError>;

export const EXPORT_HELP = `selftune export — Export SQLite data to JSONL snapshots

Usage:
  selftune export [tables...] [options]

Use this for portability, debugging, contribute flows, or explicit recovery
snapshots. Normal runtime reads and writes stay in SQLite.

Tables (default: all):
  telemetry    Session telemetry records
  skills       Skill usage records
  queries      Query log entries
  audit        Evolution audit trail
  evidence     Evolution evidence trail
  signals      Improvement signals
  orchestrate  Orchestrate run log

Options:
  -o, --output <dir>   Output directory (default: current directory)
  --since <date>       Only export records after this date (ISO 8601)
  -h, --help           Show this help`;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function exportImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load export support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toExportCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(`Export failed: ${failureMessage(cause)}`, "OPERATION_FAILED", "selftune sync");
}

export const runExportAction = Effect.fn("selftune.cli.export")(function* (input: ExportInput) {
  const exporter = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/export"),
    catch: exportImportFailure,
  });
  yield* Effect.try({
    try: () => exporter.runExportProgram(input),
    catch: toExportCliError,
  });
});

function decodeInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

export function makeExportCommand(action: ExportAction = runExportAction) {
  return Command.make(
    "export",
    {
      internalHelp: Flag.boolean(EXPORT_INTERNAL_HELP_FLAG),
      tables: Argument.choice("table", EXPORT_TABLE_NAMES).pipe(
        Argument.withDescription(
          `SQLite table snapshot to export (${EXPORT_TABLE_NAMES.join(", ")})`,
        ),
        Argument.variadic(),
      ),
      outputDirs: Flag.string("output").pipe(
        Flag.withAlias("o"),
        Flag.withDescription("Output directory (default: current directory)"),
        Flag.atMost(Number.MAX_SAFE_INTEGER),
      ),
      sinceValues: Flag.string("since").pipe(
        Flag.withDescription("Only export records after this ISO 8601 date"),
        Flag.atMost(Number.MAX_SAFE_INTEGER),
      ),
    },
    (input) => {
      if (input.internalHelp) return Console.log(EXPORT_HELP);
      return action({
        outputDir: decodeInternalValue(input.outputDirs.at(-1)),
        since: decodeInternalValue(input.sinceValues.at(-1)),
        tables: input.tables,
      });
    },
  ).pipe(
    Command.withDescription("Export SQLite data to portable JSONL snapshots"),
    Command.withExamples([
      { command: "selftune export", description: "Export every supported table" },
      {
        command: "selftune export telemetry skills --output ./snapshot",
        description: "Export selected tables to a directory",
      },
      {
        command: "selftune export --since 2026-01-01",
        description: "Export records on or after a date",
      },
    ]),
  );
}
