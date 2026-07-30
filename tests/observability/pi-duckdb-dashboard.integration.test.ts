import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePiSourceAdapter } from "@selftune/harness-pi/source-sync";
import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mapLocalSkillSetIntelligence } from "../../apps/local-dashboard/src/project-skill-intelligence.js";
import { SkillSetIntelligencePanels } from "../../packages/dashboard-core/src/screens/projects/SkillSetIntelligencePanels.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-pi-duckdb-vertical-"));
  _setTestDb(openDb(join(root, "selftune.db")));
  mkdirSync(join(root, ".agents", "skills", "diagnose"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "diagnose", "SKILL.md"), "# Diagnose\n");
});

afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

function writeSession(index: number, hasError: boolean): void {
  const second = String(index * 5).padStart(2, "0");
  const completedSecond = String(index * 5 + 3).padStart(2, "0");
  const sessionPath = join(
    root,
    "sessions",
    "--workspace--",
    `2026-07-23T10-00-${second}_pi-vertical-${index}.jsonl`,
  );
  mkdirSync(join(sessionPath, ".."), { recursive: true });
  writeFileSync(
    sessionPath,
    [
      {
        type: "session",
        version: 3,
        id: `pi-duckdb-vertical-${index}`,
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        cwd: root,
      },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        message: { role: "user", content: "Diagnose the failing deployment" },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp: `2026-07-23T10:00:${String(index * 5 + 1).padStart(2, "0")}.000Z`,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5",
          usage: { input: 120, output: 30 },
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: join(root, ".agents", "skills", "diagnose", "SKILL.md") },
            },
            { type: "toolCall", name: "Bash", arguments: { command: "npm test" } },
          ],
        },
      },
      {
        type: "message",
        id: "result",
        parentId: "assistant",
        timestamp: `2026-07-23T10:00:${completedSecond}.000Z`,
        message: {
          role: "toolResult",
          content: hasError ? [{ type: "text", isError: true }] : [{ type: "text", text: "ok" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8",
  );
}

test("imports Pi source sessions through SQLite, DuckDB, and the Desktop projection without replay inflation", async () => {
  writeSession(0, true);
  writeSession(1, true);
  writeSession(2, false);
  const analyticalPath = join(root, "observability.duckdb");
  const traceLayer = Layer.provide(
    makeLocalTraceImporterLive(getDb()),
    makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
  );
  const adapter = makePiSourceAdapter(join(root, "pi-ingested.json"));
  const request = {
    sourceRoot: join(root, "sessions"),
    dryRun: false,
    force: false,
    skillLogPath: join(root, "skill.jsonl"),
  };

  await Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped));
  expect(getDb().query("SELECT COUNT(*) AS count FROM skill_invocations").get()).toEqual({
    count: 3,
  });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 3 });

  const signals = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).querySkillSignals();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
  expect(signals).toEqual([
    {
      skill_name: "diagnose",
      invocation_count: 3,
      trace_count: 3,
      error_trace_count: 2,
      duration_ms: 9_000,
      input_tokens: 360,
      output_tokens: 90,
      error_count: 2,
      tool_call_count: 6,
    },
  ]);

  await Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped));
  expect(getDb().query("SELECT COUNT(*) AS count FROM skill_invocations").get()).toEqual({
    count: 3,
  });
  const replaySignals = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).querySkillSignals();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
  expect(replaySignals).toEqual(signals);

  writeSession(3, true);
  getDb().run(
    `CREATE TRIGGER fail_pi_checkpoint
     BEFORE INSERT ON analytical_import_checkpoints
     WHEN NEW.source_kind = 'pi'
     BEGIN SELECT RAISE(ABORT, 'simulated acknowledgement crash'); END`,
  );
  await expect(
    Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped)),
  ).rejects.toMatchObject({ operation: "import Pi analytical trace" });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 3 });
  getDb().run("DROP TRIGGER fail_pi_checkpoint");
  await Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped));
  const recovered = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).health();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
  expect(recovered).toMatchObject({ span_count: 4, metric_count: 20, link_count: 4 });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 4 });

  const report = loadSkillIntelligence({
    db: getDb(),
    configRoot: root,
    installedSkills: [
      {
        name: "diagnose",
        skill_path: join(root, ".agents", "skills", "diagnose", "SKILL.md"),
        package_path: join(root, ".agents", "skills", "diagnose"),
        registry_dir: join(root, ".agents", "skills"),
        modified_at: "2026-07-23T00:00:00.000Z",
        skill_scope: "global",
        content: "Diagnose failures.",
        harness: "pi",
        active: true,
      },
    ],
    sessions: [],
    existingSets: [],
    outcomes: [],
    traceSignals: signals,
    now: new Date("2026-07-23T12:00:00.000Z"),
  });
  const desktopModel = mapLocalSkillSetIntelligence(report);

  expect(desktopModel.traceSignals).toEqual([
    {
      skillName: "diagnose",
      invocationCount: 3,
      traceCount: 3,
      errorTraceCount: 2,
      durationMs: 9_000,
      inputTokens: 360,
      outputTokens: 90,
      errorCount: 2,
      toolCallCount: 6,
    },
  ]);
  expect(desktopModel.executionPatterns).toEqual([
    expect.objectContaining({
      kind: "repeated_correlated_errors",
      skillId: "diagnose",
      skillName: "diagnose",
      traceCount: 3,
      matchingTraceCount: 2,
      ratio: 0.667,
      causalClaim: false,
    }),
  ]);
  const html = renderToStaticMarkup(
    createElement(SkillSetIntelligencePanels, {
      intelligence: {
        access: "available",
        data: desktopModel,
        isLoading: false,
        error: null,
        refresh: async () => undefined,
      },
      reviewAction: { access: "available", execute: async () => undefined },
      view: "trace-signals",
      onReview: () => undefined,
      onReviewExpansion: () => undefined,
    }),
  );
  expect(html).toContain("diagnose");
  expect(html).toContain("2 of 3 traced executions reported errors");
  expect(html).toContain("3 invocations · 6 tool calls · 2 errors · 9,000 ms");
  expect(html).toContain("Correlation only — this does not show that the skill caused errors.");
});
