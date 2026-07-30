import { parseArgs } from "node:util";

import * as Effect from "effect/Effect";

import {
  ingestSingleSourceLive,
  type SingleSourceIngestRequest,
  type SingleSourceIngestSource,
} from "@selftune/orchestration/single-source-ingest";
import { CLIError } from "@selftune/runtime/utils/cli-error";

const sourceNames = ["claude", "codex", "opencode", "pi"] as const;
type IngestCommandSource = (typeof sourceNames)[number];

const sourceForCommand: Record<IngestCommandSource, SingleSourceIngestSource> = {
  claude: "claude_code",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
};

const rootFlagForSource: Record<IngestCommandSource, string> = {
  claude: "projects-dir",
  codex: "codex-home",
  opencode: "data-dir",
  pi: "sessions-dir",
};

export interface IngestActionDependencies {
  readonly run: (
    source: SingleSourceIngestSource,
    request: SingleSourceIngestRequest,
    onProgress: (message: string) => void,
  ) => Effect.Effect<
    {
      readonly available: boolean;
      readonly scanned: number;
      readonly synced: number;
      readonly skipped: number;
    },
    unknown
  >;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

const liveDependencies: IngestActionDependencies = {
  run: (source, request, onProgress) => ingestSingleSourceLive(source, request, onProgress),
  writeStdout: (message) => process.stdout.write(`${message}\n`),
  writeStderr: (message) => process.stderr.write(`${message}\n`),
};

function help(source?: IngestCommandSource): string {
  const target = source ? ` ${source}` : " <agent>";
  return `selftune ingest${target} — Import one agent source through source-sync

Usage:
  selftune ingest${target} [options]

Options:
  --source-root <path>       Override the selected source root
  --${source ? rootFlagForSource[source] : "projects-dir|codex-home|data-dir|sessions-dir"} <path>  Source-specific alias for --source-root
  --since <date>             Only import files from this date onward
  --dry-run                  Preview without writing
  --force                    Re-import already marked files
  --skill-log <path>         Write skill records to this JSONL file
  --verbose, -v              Show source-sync progress

Supported agents: claude, codex, opencode, pi.
OpenClaw and wrap-codex retain their dedicated ingest paths.`;
}

function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const since = new Date(value);
  if (Number.isNaN(since.getTime())) {
    throw new CLIError(
      `Invalid --since date: ${value}`,
      "INVALID_FLAG",
      "selftune ingest <agent> --since 2026-01-01",
    );
  }
  return since;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function runSingleSourceIngestCommand(
  source: IngestCommandSource,
  args: ReadonlyArray<string>,
  dependencies: IngestActionDependencies = liveDependencies,
) {
  return Effect.fn("selftune.cli.ingest.singleSource")(function* () {
    if (args.includes("--help") || args.includes("-h")) {
      yield* Effect.sync(() => dependencies.writeStdout(help(source)));
      return;
    }
    const rootFlag = rootFlagForSource[source];
    const values = yield* Effect.try({
      try: () =>
        parseArgs({
          args,
          options: {
            "source-root": { type: "string" },
            [rootFlag]: { type: "string" },
            since: { type: "string" },
            "dry-run": { type: "boolean", default: false },
            force: { type: "boolean", default: false },
            "skill-log": { type: "string" },
            verbose: { type: "boolean", short: "v", default: false },
          },
          strict: true,
        }).values,
      catch: (cause) =>
        new CLIError(
          `Invalid ingest arguments: ${cause instanceof Error ? cause.message : String(cause)}`,
          "INVALID_FLAG",
          `selftune ingest ${source} --help`,
        ),
    });
    const since = yield* Effect.try({
      try: () => parseSince(values.since),
      catch: (cause) =>
        cause instanceof CLIError
          ? cause
          : new CLIError(
              `Invalid ingest arguments: ${cause instanceof Error ? cause.message : String(cause)}`,
              "INVALID_FLAG",
              `selftune ingest ${source} --help`,
            ),
    });
    const request: SingleSourceIngestRequest = {
      sourceRoot: optionalString(values["source-root"]) ?? optionalString(values[rootFlag]),
      since,
      dryRun: values["dry-run"],
      force: values.force,
      skillLogPath: values["skill-log"],
    };
    const progress = values.verbose ? dependencies.writeStderr : () => {};
    const result = yield* dependencies.run(sourceForCommand[source], request, progress);
    yield* Effect.sync(() =>
      dependencies.writeStdout(
        `${source}: ${result.available ? `scanned ${result.scanned}, synced ${result.synced}, skipped ${result.skipped}` : "not available"}`,
      ),
    );
  })();
}

export function isSingleSourceIngestCommand(source: string): source is IngestCommandSource {
  return sourceNames.some((candidate) => candidate === source);
}

export function ingestHelp(): string {
  return help();
}
