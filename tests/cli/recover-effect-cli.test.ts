import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import type {
  MaterializeOptions,
  MaterializeResult,
} from "../../packages/runtime/localdb/materialize.js";
import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  DEFAULT_RECOVER_INPUT,
  runRecover,
  type RecoverDependencies,
  type RecoverInput,
} from "../../packages/runtime/recover.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import { prepareEffectCliArguments } from "../../apps/cli/src/effect-cli/argument-compatibility.js";
import {
  makeRecoverCommand,
  RECOVER_HELP,
  toRecoverCliError,
  type RecoverAction,
} from "../../apps/cli/src/effect-cli/commands/recover.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const SELF_TUNE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];
const EMPTY_RESULT: MaterializeResult = {
  sessions: 0,
  prompts: 0,
  skillInvocations: 0,
  executionFacts: 0,
  sessionTelemetry: 0,
  skillUsage: 0,
  evolutionAudit: 0,
  evolutionEvidence: 0,
  orchestrateRuns: 0,
};

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-recover-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runRecoverCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "recover", ...args], {
    env: {
      ...process.env,
      HOME: home,
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

function runRecoverCommand(args: ReadonlyArray<string>, action: RecoverAction) {
  const run = Command.runWith(makeRecoverCommand(action), { version: "test" });
  return Effect.gen(function* () {
    const prepared = yield* prepareEffectCliArguments(["recover", ...args]);
    yield* run(prepared.slice(1));
  }).pipe(Effect.provide(BunServices.layer));
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("recover core program", () => {
  test("normalizes since and forwards every input path to incremental materialization", () => {
    const db = openDb(":memory:");
    let received: MaterializeOptions | undefined;
    const dependencies: RecoverDependencies = {
      getDatabase: () => db,
      materializeFull: () => EMPTY_RESULT,
      materializeIncremental: (_db, options) => {
        received = options;
        return EMPTY_RESULT;
      },
    };
    const input: RecoverInput = {
      full: false,
      force: true,
      since: "2026-01-01",
      json: true,
      canonicalLog: "/tmp/canonical.jsonl",
      telemetryLog: "/tmp/telemetry.jsonl",
      evolutionAuditLog: "/tmp/audit.jsonl",
      evolutionEvidenceLog: "/tmp/evidence.jsonl",
      orchestrateRunLog: "/tmp/orchestrate.jsonl",
    };

    const summary = runRecover(input, dependencies);

    expect(summary.mode).toBe("incremental");
    expect(summary.since).toBe("2026-01-01T00:00:00.000Z");
    expect(received).toEqual({
      canonicalLogPath: input.canonicalLog,
      telemetryLogPath: input.telemetryLog,
      evolutionAuditPath: input.evolutionAuditLog,
      evolutionEvidencePath: input.evolutionEvidenceLog,
      orchestrateRunLogPath: input.orchestrateRunLog,
      force: true,
      since: "2026-01-01T00:00:00.000Z",
    });
    db.close();
  });

  test("rejects conflicting full/since and invalid dates before opening the database", () => {
    let opened = false;
    const dependencies: RecoverDependencies = {
      getDatabase: () => {
        opened = true;
        return openDb(":memory:");
      },
      materializeFull: () => EMPTY_RESULT,
      materializeIncremental: () => EMPTY_RESULT,
    };

    expect(() =>
      runRecover({ ...DEFAULT_RECOVER_INPUT, full: true, since: "2026-01-01" }, dependencies),
    ).toThrow("Cannot combine --full with --since.");
    expect(() =>
      runRecover({ ...DEFAULT_RECOVER_INPUT, since: "not-a-date" }, dependencies),
    ).toThrow("Invalid --since date: not-a-date");
    expect(opened).toBe(false);
  });
});

describe("recover Effect CLI compatibility", () => {
  test("maps defaults and every explicit flag into one command-local action", async () => {
    const inputs: RecoverInput[] = [];
    const action: RecoverAction = (input) => Effect.sync(() => inputs.push(input));

    await Effect.runPromise(runRecoverCommand([], action));
    await Effect.runPromise(
      runRecoverCommand(
        [
          "--force",
          "--since",
          "2026-01-02",
          "--json",
          "--canonical-log",
          "/tmp/canonical.jsonl",
          "--telemetry-log",
          "/tmp/telemetry.jsonl",
          "--evolution-audit-log",
          "/tmp/audit.jsonl",
          "--evolution-evidence-log",
          "/tmp/evidence.jsonl",
          "--orchestrate-run-log",
          "/tmp/orchestrate.jsonl",
        ],
        action,
      ),
    );
    await Effect.runPromise(runRecoverCommand(["--full", "--force"], action));

    expect(inputs).toEqual([
      { ...DEFAULT_RECOVER_INPUT, since: undefined },
      {
        full: false,
        force: true,
        since: "2026-01-02",
        json: true,
        canonicalLog: "/tmp/canonical.jsonl",
        telemetryLog: "/tmp/telemetry.jsonl",
        evolutionAuditLog: "/tmp/audit.jsonl",
        evolutionEvidenceLog: "/tmp/evidence.jsonl",
        orchestrateRunLog: "/tmp/orchestrate.jsonl",
      },
      { ...DEFAULT_RECOVER_INPUT, full: true, force: true, since: undefined },
    ]);
  });

  test("preserves legacy duplicate, attached, empty, dash, and marker forms", async () => {
    const inputs: RecoverInput[] = [];
    const action: RecoverAction = (input) => Effect.sync(() => inputs.push(input));

    await Effect.runPromise(
      runRecoverCommand(
        [
          "--full",
          "--full",
          "--force",
          "--force",
          "--json",
          "--json",
          "--since=first",
          "--since",
          "second",
          "--canonical-log==leading-equals",
          "--telemetry-log=-dash-value",
          "--evolution-audit-log",
          "",
          "--evolution-evidence-log",
          "-",
          "--orchestrate-run-log=",
        ],
        action,
      ),
    );
    await Effect.runPromise(runRecoverCommand(["--"], action));
    await Effect.runPromise(runRecoverCommand(["--since==leading-equals"], action));

    expect(inputs).toEqual([
      {
        full: true,
        force: true,
        since: "second",
        json: true,
        canonicalLog: "=leading-equals",
        telemetryLog: "-dash-value",
        evolutionAuditLog: "",
        evolutionEvidenceLog: "-",
        orchestrateRunLog: "",
      },
      { ...DEFAULT_RECOVER_INPUT, since: undefined },
      { ...DEFAULT_RECOVER_INPUT, since: "=leading-equals" },
    ]);
  });

  test("rejects the complete legacy-invalid grammar before invoking recovery", async () => {
    const inputs: RecoverInput[] = [];
    const action: RecoverAction = (input) => Effect.sync(() => inputs.push(input));
    const booleanFlags = ["--full", "--force", "--json", "--help"];
    const valueFlags = [
      "--since",
      "--canonical-log",
      "--telemetry-log",
      "--evolution-audit-log",
      "--evolution-evidence-log",
      "--orchestrate-run-log",
    ];
    const malformed: ReadonlyArray<ReadonlyArray<string>> = [
      ...booleanFlags.flatMap((flag) => [
        [`${flag}=true`],
        [`${flag}=false`],
        [`--no-${flag.slice(2)}`],
        [flag, "false"],
      ]),
      ...valueFlags.flatMap((flag) => [[flag], [flag, "-value"]]),
      ["unexpected"],
      ["--", "unexpected"],
      ["--unknown"],
      ["--version"],
      ["--log-level", "info"],
      ["--completions", "bash"],
      ["--help", "--unknown"],
      ["--help", "unexpected"],
      ["--help", "--since"],
      ["-h=true"],
      ["-hf"],
      ["-"],
    ];

    const errors = await Promise.all(
      malformed.map((args) => Effect.runPromise(runRecoverCommand(args, action).pipe(Effect.flip))),
    );
    for (const error of errors) {
      expect(error).toMatchObject({ code: "INVALID_FLAG" });
    }
    expect(inputs).toEqual([]);
  });

  test("preserves typed validation failures and maps unexpected live failures", async () => {
    const validation = new CLIError(
      "Cannot combine --full with --since.",
      "INVALID_FLAG",
      "Choose one recovery mode.",
    );
    const received = await Effect.runPromise(
      runRecoverCommand([], () => Effect.fail(validation)).pipe(Effect.flip),
    );

    expect(received).toBe(validation);
    expect(toRecoverCliError(validation)).toBe(validation);
    expect(toRecoverCliError(new Error("database unavailable"))).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Recovery failed: database unavailable",
      suggestion: "selftune recover --help",
    });
  });

  test("help does not invoke recovery or create local state", async () => {
    const home = makeHome();
    let invoked = false;
    await Effect.runPromise(
      runRecoverCommand(["--help"], () =>
        Effect.sync(() => {
          invoked = true;
        }),
      ),
    );

    expect(invoked).toBe(false);
    const liveHelp = runRecoverCli(home, "--help");
    expect(liveHelp.exitCode, liveHelp.stderr).toBe(0);
    expect(liveHelp.stdout).toBe(`${RECOVER_HELP}\n`);
    expect(liveHelp.stdout).not.toContain("GLOBAL FLAGS");
    expect(liveHelp.stdout).not.toContain("--version");
    expect(existsSync(join(home, ".selftune"))).toBe(false);

    await Effect.runPromise(
      runRecoverCommand(["-hhh", "--help", "--full", "--since", "not-a-date"], () =>
        Effect.sync(() => {
          invoked = true;
        }),
      ),
    );
    expect(invoked).toBe(false);
  });

  test("shared Effect test root fails closed instead of running live recovery", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["recover"]).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live recovery is disabled in the Effect CLI test program.",
    });
  });

  test("owns its lazy live adapter without a global recovery handler", () => {
    const commandSource = readFileSync(
      join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/recover.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/recover")');
    expect(commandSource).not.toContain(
      'import { runRecoverProgram } from "@selftune/runtime/recover"',
    );
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(
      false,
    );
  });

  test("owns the complete command and renders every documented flag in help", () => {
    expect(isEffectCliInvocation("recover", [])).toBe(true);
    expect(isEffectCliInvocation("recover", ["--help"])).toBe(true);

    const result = runRecoverCli(makeHome(), "--help");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${RECOVER_HELP}\n`);
    for (const flag of [
      "--full",
      "--force",
      "--since",
      "--json",
      "--canonical-log",
      "--telemetry-log",
      "--evolution-audit-log",
      "--evolution-evidence-log",
      "--orchestrate-run-log",
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  test("preserves full/since and invalid-date validation with exit code 1", () => {
    const home = makeHome();
    const conflicting = runRecoverCli(home, "--full", "--since", "2026-01-01");
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain("Cannot combine --full with --since.");

    const invalidDate = runRecoverCli(home, "--since", "not-a-date");
    expect(invalidDate.exitCode).toBe(1);
    expect(invalidDate.stderr).toContain("Invalid --since date: not-a-date");
  });

  test("runs all path flags and emits the JSON summary on non-TTY stdout", () => {
    const home = makeHome();
    const paths = {
      canonical: join(home, "canonical.jsonl"),
      telemetry: join(home, "telemetry.jsonl"),
      audit: join(home, "audit.jsonl"),
      evidence: join(home, "evidence.jsonl"),
      orchestrate: join(home, "orchestrate.jsonl"),
    };
    const result = runRecoverCli(
      home,
      "--json",
      "--force",
      "--canonical-log",
      paths.canonical,
      "--telemetry-log",
      paths.telemetry,
      "--evolution-audit-log",
      paths.audit,
      "--evolution-evidence-log",
      paths.evidence,
      "--orchestrate-run-log",
      paths.orchestrate,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "incremental",
      source: "legacy_jsonl_or_export_snapshot",
      since: null,
      force: true,
      result: EMPTY_RESULT,
    });
  });
});
