import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { makeCodexSourceAdapter } from "@selftune/harness-codex/source-sync";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";
import { mapLocalSkillSetIntelligence } from "../../apps/local-dashboard/src/project-skill-intelligence.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-codex-duckdb-vertical-"));
  _setTestDb(openDb(join(root, "selftune.db")));
  mkdirSync(join(root, ".agents", "skills", "diagnose"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "diagnose", "SKILL.md"), "# Diagnose\n");
});

afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

function writeRollout(index: number, hasError: boolean): string {
  const second = String(index * 3).padStart(2, "0");
  const completedSecond = String(index * 3 + 2).padStart(2, "0");
  const path = join(root, "sessions", "2026", "07", "23", `rollout-${index}.jsonl`);
  mkdirSync(join(root, "sessions", "2026", "07", "23"), { recursive: true });
  writeFileSync(
    path,
    [
      {
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        type: "session_meta",
        payload: {
          id: `codex-duckdb-vertical-${index}`,
          cwd: root,
          model_provider: "openai",
          model: "gpt-5",
          originator: "codex-cli",
        },
      },
      {
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        type: "turn_context",
        payload: {
          approval_policy: "on-request",
          sandbox_policy: "workspace-write",
        },
      },
      {
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Diagnose the failing deployment",
        },
      },
      {
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        type: "item.completed",
        item: {
          item_type: "command_execution",
          command: "cat .agents/skills/diagnose/SKILL.md",
          exit_code: 0,
        },
      },
      {
        timestamp: `2026-07-23T10:00:${second}.000Z`,
        type: "response_item",
        payload: { type: "function_call", name: "bash", arguments: "npm test" },
      },
      {
        timestamp: `2026-07-23T10:00:${completedSecond}.000Z`,
        type: "event_msg",
        payload: {
          type: "usage",
          token_count: { input_tokens: 120, output_tokens: 30 },
        },
      },
      ...(hasError
        ? [
            {
              timestamp: `2026-07-23T10:00:${completedSecond}.000Z`,
              type: "turn.failed",
              error: { message: "deployment command failed" },
            },
          ]
        : []),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
    "utf8",
  );
  return path;
}

test("ingests Codex rollouts through the shared source-sync and LocalTraceImporter path", async () => {
  writeRollout(0, true);
  writeRollout(1, true);
  writeRollout(2, false);
  const traceLayer = Layer.provide(
    makeLocalTraceImporterLive(getDb()),
    makeDuckDbNodeApiAnalyticalStoreLive(join(root, "observability.duckdb")),
  );
  const adapter = makeCodexSourceAdapter(join(root, "codex-ingested.json"));

  await Effect.runPromise(
    adapter
      .sync({
        sourceRoot: root,
        dryRun: false,
        force: false,
        skillLogPath: join(root, "skill.jsonl"),
      })
      .pipe(Effect.provide(traceLayer), Effect.scoped),
  );

  expect(getDb().query("SELECT COUNT(*) AS count FROM skill_invocations").get()).toEqual({
    count: 3,
  });
  const signals = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).querySkillSignals();
    }).pipe(
      Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(join(root, "observability.duckdb"))),
      Effect.scoped,
    ),
  );
  expect(signals).toEqual([
    {
      skill_name: "diagnose",
      invocation_count: 3,
      trace_count: 3,
      error_trace_count: 2,
      duration_ms: 6_000,
      input_tokens: 360,
      output_tokens: 90,
      error_count: 2,
      tool_call_count: 6,
    },
  ]);

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
        harness: "codex",
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
      durationMs: 6_000,
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
});
