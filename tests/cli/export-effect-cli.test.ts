import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import type { ExportInput } from "../../packages/runtime/export-contract.js";
import { runExportProgram, type ExportDependencies } from "../../packages/runtime/export.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import { prepareEffectCliArguments } from "../../apps/cli/src/effect-cli/argument-compatibility.js";
import {
  EXPORT_HELP,
  makeExportCommand,
  toExportCliError,
  type ExportAction,
} from "../../apps/cli/src/effect-cli/commands/export.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-export-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runExportCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "export", ...args], {
    cwd: selftuneRoot,
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function runExportCommand(args: ReadonlyArray<string>, action: ExportAction) {
  const run = Command.runWith(makeExportCommand(action), { version: "test" });
  return Effect.gen(function* () {
    const prepared = yield* prepareEffectCliArguments(["export", ...args]);
    yield* run(prepared.slice(1));
  }).pipe(Effect.provide(BunServices.layer));
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("export core program", () => {
  test("uses the current directory by default and prints every generated file", () => {
    const received: Array<{
      outputDir?: string;
      since?: string;
      tables?: ReadonlyArray<string>;
    }> = [];
    const printed: string[] = [];
    const dependencies: ExportDependencies = {
      exportData: (options) => {
        received.push(options);
        return { records: 3, files: ["/work/a.jsonl", "/work/b.jsonl"] };
      },
      getCurrentDirectory: () => "/work",
      print: (message) => printed.push(message),
    };

    const result = runExportProgram({ tables: [] }, dependencies);

    expect(result).toEqual({ records: 3, files: ["/work/a.jsonl", "/work/b.jsonl"] });
    expect(received).toEqual([{ outputDir: "/work", since: undefined, tables: undefined }]);
    expect(printed).toEqual([
      "Exported 3 records to 2 files in /work",
      "  /work/a.jsonl",
      "  /work/b.jsonl",
    ]);
  });
});

describe("export Effect CLI compatibility", () => {
  test("owns the full command and parses tables, output aliases, and since", async () => {
    expect(isEffectCliInvocation("export", [])).toBe(true);
    expect(isEffectCliInvocation("export", ["--unknown"])).toBe(true);

    const exports: ExportInput[] = [];
    const action: ExportAction = (input) => Effect.sync(() => exports.push(input));
    await Effect.runPromise(
      Effect.all(
        [
          [],
          ["telemetry", "skills", "--output", "/tmp/snapshot", "--since", "2026-01-01"],
          ["queries", "-o", "/tmp/short"],
          ["signals", "--since", "-"],
          [
            "audit",
            "--output",
            "/tmp/first",
            "-o",
            "/tmp/last",
            "--since",
            "2025-01-01",
            "--since",
            "2026-01-01",
          ],
        ].map((args) => runExportCommand(args, action)),
        { concurrency: 1, discard: true },
      ),
    );

    expect(exports).toEqual([
      { outputDir: undefined, since: undefined, tables: [] },
      {
        outputDir: "/tmp/snapshot",
        since: "2026-01-01",
        tables: ["telemetry", "skills"],
      },
      { outputDir: "/tmp/short", since: undefined, tables: ["queries"] },
      { outputDir: undefined, since: "-", tables: ["signals"] },
      { outputDir: "/tmp/last", since: "2026-01-01", tables: ["audit"] },
    ]);
  });

  test("preserves legacy empty, attached, dash, duplicate, and marker forms", async () => {
    const exports: ExportInput[] = [];
    const action: ExportAction = (input) => Effect.sync(() => exports.push(input));
    await Effect.runPromise(
      Effect.all(
        [
          ["--output=", "--since="],
          ["--output=a=b=c", "--since=x=y=z"],
          ["--output=-a=b", "--since=-x=y"],
          ["-o", "separate"],
          ["-oattached"],
          ["-o=equals"],
          ["-o-a=b"],
          [
            "telemetry",
            "--output",
            "first",
            "-osecond=last",
            "--since",
            "one",
            "--since=two=last",
            "--",
            "skills",
          ],
          ["--", "telemetry", "telemetry"],
        ].map((args) => runExportCommand(args, action)),
        { concurrency: 1, discard: true },
      ),
    );

    expect(exports).toEqual([
      { outputDir: "", since: "", tables: [] },
      { outputDir: "a=b=c", since: "x=y=z", tables: [] },
      { outputDir: "-a=b", since: "-x=y", tables: [] },
      { outputDir: "separate", since: undefined, tables: [] },
      { outputDir: "attached", since: undefined, tables: [] },
      { outputDir: "=equals", since: undefined, tables: [] },
      { outputDir: "-a=b", since: undefined, tables: [] },
      {
        outputDir: "second=last",
        since: "two=last",
        tables: ["telemetry", "skills"],
      },
      { outputDir: undefined, since: undefined, tables: ["telemetry", "telemetry"] },
    ]);
  });

  test("preserves typed failures and maps unexpected live failures", async () => {
    const validation = new CLIError(
      "Invalid export request.",
      "INVALID_FLAG",
      "selftune export --help",
    );
    const received = await Effect.runPromise(
      runExportCommand([], () => Effect.fail(validation)).pipe(Effect.flip),
    );

    expect(received).toBe(validation);
    expect(toExportCliError(validation)).toBe(validation);
    expect(toExportCliError(new Error("filesystem unavailable"))).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Export failed: filesystem unavailable",
      suggestion: "selftune sync",
    });
  });

  test("legacy-valid help forms ignore positionals without invoking export", async () => {
    let invoked = false;
    await Effect.runPromise(
      Effect.all(
        [
          ["--help"],
          ["-h", "not-a-table"],
          ["--help", "--", "--unknown"],
          ["--help", "--since=a=b"],
          ["-hoops"],
        ].map((args) =>
          runExportCommand(args, () =>
            Effect.sync(() => {
              invoked = true;
            }),
          ),
        ),
        { concurrency: 1, discard: true },
      ),
    );

    expect(invoked).toBe(false);
  });

  test("rejects the complete legacy-invalid grammar before invoking export", async () => {
    const exports: ExportInput[] = [];
    const action: ExportAction = (input) => Effect.sync(() => exports.push(input));
    const malformed: ReadonlyArray<ReadonlyArray<string>> = [
      ["--unknown"],
      ["--output"],
      ["-o"],
      ["--since"],
      ["-o", "--since", "value"],
      ["--since", "--output", "value"],
      ["--help", "--unknown"],
      ["--help", "--output"],
      ["--help=true"],
      ["-h=true"],
      ["-hfoo"],
      ["--version"],
      ["--version", "unexpected"],
      ["--log-level", "info"],
      ["--completions", "bash"],
    ];

    const errors = await Effect.runPromise(
      Effect.all(
        malformed.map((args) => runExportCommand(args, action).pipe(Effect.flip)),
        { concurrency: 1 },
      ),
    );
    for (const error of errors) {
      expect(error).toMatchObject({ code: "INVALID_FLAG" });
    }
    expect(exports).toEqual([]);
  });

  test("rejects unknown and marker-hidden tables before invoking the export action", async () => {
    let invoked = false;
    const errors = await Effect.runPromise(
      Effect.all(
        [
          ["not-a-table"],
          ["--", "--output", "/tmp/export"],
          ["--", "-o", "/tmp/export"],
          ["--", "-o/tmp/export"],
          ["--", "--since", "2026-01-01"],
          ["--", "--help"],
          ["--", "--version"],
        ].map((args) =>
          runExportCommand(args, () =>
            Effect.sync(() => {
              invoked = true;
            }),
          ).pipe(Effect.flip),
        ),
        { concurrency: 1 },
      ),
    );

    for (const error of errors) {
      expect(error).toMatchObject({ code: "INVALID_FLAG" });
    }
    expect(invoked).toBe(false);
  });

  test("marker-hidden flags cannot create export state", () => {
    for (const args of [
      ["--output", "marker-output"],
      ["-o", "marker-output"],
      ["-omarker-output"],
      ["--since", "2026-01-01"],
      ["--help"],
      ["--version"],
    ]) {
      const home = makeHome();
      const outputDir = join(home, "marker-output");
      const markerArguments = args.map((argument) =>
        argument === "marker-output"
          ? outputDir
          : argument === "-omarker-output"
            ? `-o${outputDir}`
            : argument,
      );
      const result = runExportCli(home, "--", ...markerArguments);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid value for argument <table>");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
      expect(existsSync(outputDir)).toBe(false);
    }
  });

  test("shared Effect test root fails closed instead of exporting live data", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["export"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live export is disabled in the Effect CLI test program.",
    });
  });

  test("owns its lazy live adapter without a global export handler", () => {
    const commandSource = readFileSync(
      join(selftuneRoot, "apps/cli/src/effect-cli/commands/export.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/export")');
    expect(commandSource).not.toContain(
      'import { runExportProgram } from "@selftune/runtime/export"',
    );
    expect(existsSync(join(selftuneRoot, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(selftuneRoot, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(false);
  });

  test("exact legacy help and parser failures do not open SQLite", () => {
    for (const args of [
      ["--help"],
      ["--help", "not-a-table"],
      ["-h", "--", "--unknown"],
      ["--unknown"],
      ["not-a-table"],
    ]) {
      const home = makeHome();
      const result = runExportCli(home, ...args);
      const isHelp = args[0] === "--help" || args[0] === "-h";
      expect(result.exitCode).toBe(isHelp ? 0 : 1);
      if (isHelp) {
        expect(result.stdout).toBe(`${EXPORT_HELP}\n`);
        expect(result.stdout).not.toContain("GLOBAL FLAGS");
        expect(result.stdout).not.toContain("--version");
      } else if (args[0] === "--unknown") {
        expect(result.stderr).toContain("Unknown option");
      } else {
        expect(result.stderr).toContain("Invalid value for argument <table>");
        expect(result.stderr).toContain("not-a-table");
      }
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("missing flag values fail before opening SQLite or writing snapshots", () => {
    for (const args of [
      ["--output"],
      ["-o"],
      ["--since"],
      ["telemetry", "--since"],
      ["--output", "--since", "2026-01-01"],
    ]) {
      const home = makeHome();
      const result = runExportCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("argument");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
      expect(existsSync(join(home, "snapshot"))).toBe(false);
    }
  });

  test("preserves attached short output values", () => {
    const home = makeHome();
    const outputDir = join(home, "attached");
    const result = runExportCli(home, "telemetry", `-o${outputDir}`);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`in ${outputDir}`);
    expect(existsSync(join(outputDir, "session_telemetry_log.jsonl"))).toBe(true);
  });

  test("exports selected SQLite tables to JSONL", () => {
    const home = makeHome();
    const outputDir = join(home, "snapshot");
    const result = runExportCli(home, "telemetry", "skills", "-o", outputDir);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Exported 0 records to 2 files in ${outputDir}`);
    expect(readFileSync(join(outputDir, "session_telemetry_log.jsonl"), "utf8")).toBe("");
    expect(readFileSync(join(outputDir, "skill_usage_log.jsonl"), "utf8")).toBe("");
  });

  test("exports all tables by default", () => {
    const home = makeHome();
    const outputDir = join(home, "all");
    const result = runExportCli(home, "--output", outputDir);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Exported 0 records to 7 files in ${outputDir}`);
    for (const fileName of [
      "session_telemetry_log.jsonl",
      "skill_usage_log.jsonl",
      "all_queries_log.jsonl",
      "evolution_audit_log.jsonl",
      "evolution_evidence_log.jsonl",
      "signal_log.jsonl",
      "orchestrate_run_log.jsonl",
    ]) {
      expect(readFileSync(join(outputDir, fileName), "utf8")).toBe("");
    }
  });

  test("maps filesystem failures without losing export guidance", () => {
    const home = makeHome();
    const blockingFile = join(home, "not-a-directory");
    writeFileSync(blockingFile, "blocked", "utf8");

    const result = runExportCli(home, "telemetry", "--output", blockingFile);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Export failed:");
    expect(result.stderr).toContain("selftune sync");
  });
});
