import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { _setTestDb, openDb } from "@selftune/local-store";
import {
  LocalTraceImportFailure,
  LocalTraceImportResult,
  LocalTraceImporter,
} from "@selftune/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

let root = "";
let markerPath = "";
let sourceRoot = "";
let sync: (typeof import("@selftune/harness-opencode/source-sync"))["openCodeSourceAdapter"]["sync"];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "selftune-opencode-source-sync-"));
  markerPath = join(root, "marker.json");
  sourceRoot = join(root, "opencode");
  const { makeOpenCodeSourceAdapter } = await import("@selftune/harness-opencode/source-sync");
  sync = makeOpenCodeSourceAdapter(markerPath).sync;
});

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(markerPath, { force: true });
});

afterEach(() => _setTestDb(null));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeSource(additionalMessage = false): void {
  const created = Date.parse("2026-07-23T10:00:00.000Z");
  if (additionalMessage) {
    const database = new Database(join(sourceRoot, "opencode.db"));
    database.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
      "assistant-2",
      "source-session",
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "private command" },
        },
      ]),
      created + 2_000,
    ]);
    database.close();
    return;
  }
  mkdirSync(sourceRoot, { recursive: true });
  const database = new Database(join(sourceRoot, "opencode.db"));
  database.run("CREATE TABLE session (id TEXT PRIMARY KEY, created INTEGER)");
  database.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created INTEGER)",
  );
  database.run("INSERT INTO session VALUES (?, ?)", ["source-session", created]);
  database.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "user",
    "source-session",
    "user",
    JSON.stringify([{ type: "text", text: "private prompt" }]),
    created,
  ]);
  database.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "assistant",
    "source-session",
    "assistant",
    JSON.stringify([
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/skills/diagnose/SKILL.md" },
      },
    ]),
    created + 1_000,
  ]);
  database.close();
}

function run(layer: Layer.Layer<LocalTraceImporter>, dryRun = false) {
  return Effect.runPromise(
    sync({
      sourceRoot,
      dryRun,
      force: false,
      skillLogPath: join(root, "skill.jsonl"),
    }).pipe(Effect.provide(layer)),
  );
}

test("retries importer failures, advances only after receipt, and replays changed sessions", async () => {
  writeSource();
  let calls = 0;
  const successful = Layer.succeed(
    LocalTraceImporter,
    LocalTraceImporter.of({
      importTrace: () =>
        Effect.sync(() => {
          calls += 1;
          return LocalTraceImportResult.make({ skill_failure_signals: [] });
        }),
    }),
  );
  const failing = Layer.succeed(
    LocalTraceImporter,
    LocalTraceImporter.of({
      importTrace: () =>
        Effect.fail(
          LocalTraceImportFailure.make({
            operation: "fixture",
            message: "unavailable",
          }),
        ),
    }),
  );

  await expect(run(successful, true)).resolves.toMatchObject({ synced: 1 });
  expect(calls).toBe(0);
  await expect(run(failing)).rejects.toMatchObject({
    _tag: "HarnessSourceSyncFailure",
    operation: "import OpenCode analytical trace",
  });
  expect(() => readFileSync(markerPath, "utf8")).toThrow();

  await expect(run(successful)).resolves.toMatchObject({
    scanned: 1,
    synced: 1,
  });
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
    marker_version: 6,
    scanned_sessions: 1,
  });
  await expect(run(successful)).resolves.toMatchObject({ synced: 0 });
  expect(calls).toBe(1);

  writeSource(true);
  await expect(run(successful)).resolves.toMatchObject({ synced: 1 });
  expect(calls).toBe(2);
});
