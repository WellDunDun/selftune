import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import {
  runSingleSourceIngestCommand,
  type IngestActionDependencies,
} from "../../apps/cli/src/commands/ingest.js";
import { createSingleSourceIngestOptions } from "../../packages/orchestration/src/single-source-ingest.js";

test("single-source ingest options enable exactly the explicit source without repair", () => {
  const options = createSingleSourceIngestOptions("codex", {
    sourceRoot: "/tmp/codex",
    since: new Date("2026-07-23"),
    dryRun: true,
    force: true,
    skillLogPath: "/tmp/skills.jsonl",
  });

  expect(options).toMatchObject({
    codexHome: "/tmp/codex",
    skillLogPath: "/tmp/skills.jsonl",
    dryRun: true,
    force: true,
    syncClaude: false,
    syncCodex: true,
    syncOpenCode: false,
    syncOpenClaw: false,
    syncPi: false,
    rebuildSkillUsage: false,
  });
});

test("ingest routes source-specific roots and common flags through one runner", async () => {
  const calls: Array<{
    source: Parameters<IngestActionDependencies["run"]>[0];
    request: Parameters<IngestActionDependencies["run"]>[1];
  }> = [];
  const stdout: string[] = [];
  const dependencies: IngestActionDependencies = {
    run: (source, request) =>
      Effect.sync(() => {
        calls.push({ source, request });
        return { available: true, scanned: 4, synced: 3, skipped: 1 };
      }),
    writeStdout: (message) => stdout.push(message),
    writeStderr: () => {},
  };

  await Effect.runPromise(
    runSingleSourceIngestCommand(
      "opencode",
      ["--data-dir", "/tmp/opencode", "--since", "2026-07-01", "--dry-run", "--force"],
      dependencies,
    ),
  );

  expect(calls).toEqual([
    {
      source: "opencode",
      request: {
        sourceRoot: "/tmp/opencode",
        since: new Date("2026-07-01"),
        dryRun: true,
        force: true,
        skillLogPath: undefined,
      },
    },
  ]);
  expect(stdout).toEqual(["opencode: scanned 4, synced 3, skipped 1"]);
});

test.each([
  ["claude", "projects-dir", "claude_code"],
  ["codex", "codex-home", "codex"],
  ["opencode", "data-dir", "opencode"],
  ["pi", "sessions-dir", "pi"],
] as const)(
  "%s preserves its source-root alias and trace",
  async (command, flag, expectedSource) => {
    const calls: string[] = [];
    const dependencies: IngestActionDependencies = {
      run: (source, request) =>
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan;
          calls.push(source, request.sourceRoot ?? "missing", span.name);
          return { available: true, scanned: 0, synced: 0, skipped: 0 };
        }),
      writeStdout: () => {},
      writeStderr: () => {},
    };
    const effect = runSingleSourceIngestCommand(
      command,
      [`--${flag}`, "/tmp/fixture-source", "--dry-run"],
      dependencies,
    );
    expect(calls).toEqual([]);
    await Effect.runPromise(effect);
    expect(calls).toEqual([
      expectedSource,
      "/tmp/fixture-source",
      "selftune.cli.ingest.singleSource",
    ]);
  },
);

test("help and invalid dates never invoke the source importer", async () => {
  let calls = 0;
  const output: string[] = [];
  const dependencies: IngestActionDependencies = {
    run: () =>
      Effect.sync(() => {
        calls++;
        return { available: true, scanned: 0, synced: 0, skipped: 0 };
      }),
    writeStdout: (value) => {
      output.push(value);
    },
    writeStderr: () => {},
  };
  await Effect.runPromise(runSingleSourceIngestCommand("codex", ["--help"], dependencies));
  expect(output[0]).toContain("--codex-home");
  const failure = await Effect.runPromise(
    runSingleSourceIngestCommand("codex", ["--since", "not-a-date"], dependencies).pipe(
      Effect.flip,
    ),
  );
  expect(failure).toMatchObject({ code: "INVALID_FLAG" });
  expect(calls).toBe(0);
});
