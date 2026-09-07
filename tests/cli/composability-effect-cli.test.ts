import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import { TELEMETRY_LOG } from "../../packages/runtime/constants.js";
import {
  runComposabilityProgram,
  type ComposabilityDependencies,
  type ComposabilityInput,
} from "../../packages/runtime/eval/composability-program.js";
import type { ComposabilityReport, SessionTelemetryRecord } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const LIFECYCLE_SOURCE = fileURLToPath(
  new URL("../../apps/cli/src/commands/lifecycle.ts", import.meta.url),
);
const temporaryHomes: string[] = [];
const REPORT: ComposabilityReport = {
  pairs: [],
  total_sessions_analyzed: 1,
  conflict_count: 0,
  generated_at: "2026-07-17T00:00:00.000Z",
};
const SESSION: SessionTelemetryRecord = {
  timestamp: "2026-07-17T00:00:00.000Z",
  session_id: "session-1",
  cwd: "/tmp/project",
  transcript_path: "/tmp/transcript.jsonl",
  tool_calls: {},
  total_tool_calls: 0,
  bash_commands: [],
  skills_triggered: ["research"],
  assistant_turns: 1,
  errors_encountered: 0,
  transcript_chars: 100,
  last_user_query: "Research this",
};

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-composability-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runComposabilityCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", CLI_ENTRYPOINT, "eval", "composability", ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function runCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, ...args], {
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

function makeDependencies(
  overrides: Partial<ComposabilityDependencies> = {},
): ComposabilityDependencies {
  return {
    loadDatabaseTelemetry: () => [SESSION],
    loadJsonlTelemetry: () => [SESSION],
    analyze: () => REPORT,
    print: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("composability core program", () => {
  test("rejects missing skill and invalid windows before loading telemetry", async () => {
    let loadCount = 0;
    const dependencies = makeDependencies({
      loadDatabaseTelemetry: () => {
        loadCount += 1;
        return [SESSION];
      },
    });

    await expect(Effect.runPromise(runComposabilityProgram({}, dependencies))).rejects.toThrow(
      "--skill <name> is required",
    );
    await Promise.all(
      ["0", "1.5", "abc", "9007199254740992", "9".repeat(400)].map((window) =>
        expect(
          Effect.runPromise(runComposabilityProgram({ skill: "research", window }, dependencies)),
        ).rejects.toThrow("positive integer number of sessions"),
      ),
    );
    expect(loadCount).toBe(0);
  });

  test("uses SQLite telemetry when the canonical source is available", async () => {
    let jsonlLoaded = false;
    const result = await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research" },
        makeDependencies({
          loadJsonlTelemetry: () => {
            jsonlLoaded = true;
            return [];
          },
        }),
      ),
    );

    expect(result).toEqual(REPORT);
    expect(jsonlLoaded).toBe(false);
  });

  test("falls back to canonical JSONL when SQLite is unavailable", async () => {
    const loadedPaths: string[] = [];
    await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research" },
        makeDependencies({
          loadDatabaseTelemetry: () => {
            throw new Error("database unavailable");
          },
          loadJsonlTelemetry: (path) => {
            loadedPaths.push(path);
            return [SESSION];
          },
        }),
      ),
    );

    expect(loadedPaths).toEqual([TELEMETRY_LOG]);
  });

  test("custom telemetry paths bypass SQLite and preserve report output", async () => {
    const printed: string[] = [];
    const analyses: Array<{ skill: string; window?: number; telemetry: SessionTelemetryRecord[] }> =
      [];
    const result = await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research", window: "30", telemetryLog: "/tmp/custom.jsonl" },
        makeDependencies({
          loadDatabaseTelemetry: () => {
            throw new Error("unexpected database load");
          },
          analyze: (skill, telemetry, window) => {
            analyses.push({ skill, telemetry, window });
            return REPORT;
          },
          print: (output) => printed.push(output),
        }),
      ),
    );

    expect(result).toEqual(REPORT);
    expect(analyses).toEqual([{ skill: "research", telemetry: [SESSION], window: 30 }]);
    expect(printed).toEqual([JSON.stringify(REPORT, null, 2)]);
  });

  test("non-Error database failures still fall back to JSONL", async () => {
    const result = await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research" },
        makeDependencies({
          loadDatabaseTelemetry: () => {
            throw "database unavailable";
          },
        }),
      ),
    );
    expect(result).toEqual(REPORT);
  });

  test("a failed fallback exposes a typed error and does not analyze or print", async () => {
    const operations: string[] = [];
    const failure = await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research" },
        makeDependencies({
          loadDatabaseTelemetry: () => {
            throw new Error("database unavailable");
          },
          loadJsonlTelemetry: () => {
            throw "telemetry unreadable";
          },
          analyze: () => {
            operations.push("analyze");
            return REPORT;
          },
          print: () => operations.push("print"),
        }),
      ).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure.code).toBe("OPERATION_FAILED");
    expect(failure.message).toBe("telemetry unreadable");
    expect(failure.suggestion).toBe("selftune eval composability --help");
    expect(operations).toEqual([]);
  });

  test("preserves an existing analysis error and its recovery instructions", async () => {
    const original = new CLIError("no sessions", "MISSING_DATA", "selftune ingest", 4);
    const failure = await Effect.runPromise(
      runComposabilityProgram(
        { skill: "research" },
        makeDependencies({
          analyze: () => {
            throw original;
          },
        }),
      ).pipe(Effect.flip),
    );
    expect(failure).toBe(original);
  });
});

describe("composability Effect CLI compatibility", () => {
  test("keeps every eval argument shape in the Effect tree", () => {
    for (const args of [
      [],
      ["--help"],
      ["generate"],
      ["unit-test"],
      ["import"],
      ["composability"],
      ["family-overlap"],
      ["unknown"],
    ]) {
      expect(isEffectCliInvocation("eval", args)).toBe(true);
    }
  });

  test("parses typed flags into the Effect handler", async () => {
    const inputs: ComposabilityInput[] = [];
    await Effect.runPromise(
      makeEffectCliTestProgram(
        [
          "eval",
          "composability",
          "--skill",
          "research",
          "--window",
          "30",
          "--telemetry-log",
          "/tmp/sessions.jsonl",
        ],
        {
          evalAction: (request) =>
            Effect.sync(() => {
              if (request.action !== "composability") throw new Error("unexpected eval action");
              inputs.push(request.input);
            }),
        },
      ).pipe(Effect.provide(BunServices.layer)),
    );

    expect(inputs).toEqual([
      { skill: "research", window: "30", telemetryLog: "/tmp/sessions.jsonl" },
    ]);
  });

  test("documents session-based windows and every supported flag", () => {
    const result = runComposabilityCli(makeHome(), "--help");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("--skill");
    expect(result.stdout).toContain("--window");
    expect(result.stdout).toContain("sessions");
    expect(result.stdout).toContain("--telemetry-log");
  });

  test("analyzes an explicit JSONL source and prints the report as JSON", () => {
    const home = makeHome();
    const telemetryLog = join(home, "sessions.jsonl");
    writeFileSync(telemetryLog, `${JSON.stringify(SESSION)}\n`);

    const result = runComposabilityCli(
      home,
      "--skill",
      "research",
      "--window",
      "1",
      "--telemetry-log",
      telemetryLog,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pairs: [],
      total_sessions_analyzed: 1,
      conflict_count: 0,
    });
  });

  test("preserves actionable validation errors", () => {
    const home = makeHome();
    const missingSkill = runComposabilityCli(home);
    expect(missingSkill.exitCode).toBe(1);
    expect(missingSkill.stderr).toContain("--skill <name> is required");

    const invalidWindow = runComposabilityCli(home, "--skill", "research", "--window", "0");
    expect(invalidWindow.exitCode).toBe(1);
    expect(invalidWindow.stderr).toContain("positive integer number of sessions");

    const overflowWindow = runComposabilityCli(
      home,
      "--skill",
      "research",
      "--window",
      "9007199254740992",
    );
    expect(overflowWindow.exitCode).toBe(1);
    expect(overflowWindow.stderr).toContain("safe integer range");
  });

  test("rejects unknown flags, missing flag values, and extra operands", () => {
    const home = makeHome();
    for (const args of [
      ["--skill", "research", "--unknown"],
      ["--skill"],
      ["extra", "--skill", "research"],
    ]) {
      const result = runComposabilityCli(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
    }
  });

  test("keeps the eval parent and every action out of the legacy router", () => {
    const help = runCli(makeHome(), "eval", "--help");
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain("selftune eval <subcommand>");
    expect(help.stdout).toContain("family-overlap");
    expect(readFileSync(LIFECYCLE_SOURCE, "utf8")).not.toContain('case "eval"');
  });
});
