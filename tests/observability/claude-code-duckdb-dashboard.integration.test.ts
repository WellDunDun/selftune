/* oxlint-disable no-await-in-loop -- source replay order is the behavior under test */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { makeClaudeCodeSourceAdapter } from "@selftune/harness-claude-code/source-sync";
import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { mapLocalSkillSetIntelligence } from "../../apps/local-dashboard/src/project-skill-intelligence.js";
import { SkillSetIntelligencePanels } from "../../packages/dashboard-core/src/screens/projects/SkillSetIntelligencePanels.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-claude-duckdb-vertical-"));
  _setTestDb(openDb(join(root, "selftune.db")));
  mkdirSync(join(root, ".agents", "skills", "diagnose"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "diagnose", "SKILL.md"), "# Diagnose\n");
});

afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

function writeNativeTranscript(index: number, hasError: boolean): void {
  const started = new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 10_000);
  const ended = new Date(started.getTime() + 3_000);
  const path = join(root, "projects", "native-project", `claude-native-${index}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      {
        type: "user",
        timestamp: started.toISOString(),
        message: { role: "user", content: "Diagnose the failing deployment" },
      },
      {
        type: "assistant",
        timestamp: new Date(started.getTime() + 1_000).toISOString(),
        message: {
          role: "assistant",
          model: "claude-native",
          usage: { input_tokens: 120, output_tokens: 30 },
          content: [
            { type: "tool_use", name: "Skill", id: `skill-${index}`, input: { skill: "diagnose" } },
            { type: "tool_use", name: "Bash", id: `bash-${index}`, input: { command: "npm test" } },
          ],
        },
      },
      ...(hasError
        ? [
            {
              type: "tool_result",
              timestamp: new Date(started.getTime() + 2_000).toISOString(),
              is_error: true,
            },
          ]
        : []),
      {
        type: "assistant",
        timestamp: ended.toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8",
  );
}

async function querySignals(analyticalPath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).querySkillSignals();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
}

async function health(analyticalPath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).health();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
}

test("replays native Claude Code transcripts through SQLite, DuckDB, signals, patterns, and Desktop", async () => {
  writeNativeTranscript(0, true);
  writeNativeTranscript(1, true);
  writeNativeTranscript(2, false);
  const analyticalPath = join(root, "observability.duckdb");
  const markerPath = join(root, "claude-ingested.json");
  const traceLayer = Layer.provide(
    makeLocalTraceImporterLive(getDb()),
    makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
  );
  const adapter = makeClaudeCodeSourceAdapter(markerPath);
  const request = {
    sourceRoot: join(root, "projects"),
    dryRun: false,
    force: false,
    skillLogPath: join(root, "skill.jsonl"),
  };
  const sync = () =>
    Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped));

  await expect(sync()).resolves.toMatchObject({ scanned: 3, synced: 3, skipped: 0 });
  expect(getDb().query("SELECT COUNT(*) AS count FROM skill_invocations").get()).toEqual({
    count: 3,
  });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 3 });
  const signals = await querySignals(analyticalPath);
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
  await expect(sync()).resolves.toMatchObject({ synced: 0 });
  await expect(health(analyticalPath)).resolves.toMatchObject({
    span_count: 3,
    metric_count: 15,
    link_count: 3,
  });

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
        harness: "claude_code",
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
  expect(desktopModel.executionPatterns).toEqual([
    expect.objectContaining({
      kind: "repeated_correlated_errors",
      skillId: "diagnose",
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
        refresh() {},
      },
      reviewAction: { access: "available", execute: async () => undefined },
      view: "trace-signals",
      onReview: () => undefined,
      onReviewExpansion: () => undefined,
    }),
  );
  expect(html).toContain("2 of 3 traced executions reported errors");

  writeNativeTranscript(3, true);
  getDb().run(
    `CREATE TRIGGER fail_claude_checkpoint
     BEFORE INSERT ON analytical_import_checkpoints
     WHEN NEW.source_kind = 'claude_code'
     BEGIN SELECT RAISE(ABORT, 'simulated acknowledgement crash'); END`,
  );
  await expect(sync()).rejects.toMatchObject({ operation: "import Claude Code analytical trace" });
  await expect(health(analyticalPath)).resolves.toMatchObject({ span_count: 4 });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 3 });
  getDb().run("DROP TRIGGER fail_claude_checkpoint");
  await expect(sync()).resolves.toMatchObject({ synced: 1 });
  await expect(health(analyticalPath)).resolves.toMatchObject({ span_count: 4 });
  expect(
    getDb().query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
  ).toEqual({ count: 4 });
});
