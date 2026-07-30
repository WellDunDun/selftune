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
  const calls: Array<unknown> = [];
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
