import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { makeOpenCodeSourceAdapter } from "@selftune/harness-opencode/source-sync";
import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";
import { computeSkillVersionHash } from "@selftune/runtime/utils/skill-discovery";
import { mapLocalSkillSetIntelligence } from "../../apps/local-dashboard/src/project-skill-intelligence.js";
import { SkillSetIntelligencePanels } from "../../packages/dashboard-core/src/screens/projects/SkillSetIntelligencePanels.js";
import {
  TraceCandidatePreparation,
  makeTraceCandidatePreparationLayer,
} from "../../apps/local/src/trace-candidate-service.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let root = "";
let sourceRoot = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-opencode-duckdb-vertical-"));
  sourceRoot = join(root, "opencode");
  _setTestDb(openDb(join(root, "selftune.db")));
  mkdirSync(join(root, ".agents", "skills", "diagnose"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "diagnose", "SKILL.md"), "# Diagnose\n");
});

afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

function writeNativeOpenCodeSource(): void {
  mkdirSync(sourceRoot, { recursive: true });
  const database = new Database(join(sourceRoot, "opencode.db"));
  database.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  database.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  database.run(
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );

  for (const index of [0, 1, 2]) {
    const started = Date.parse(`2026-07-23T10:0${index}:00.000Z`);
    const sessionId = `opencode-desktop-${index}`;
    database.run("INSERT INTO session VALUES (?, ?, ?, ?, ?)", [
      sessionId,
      root,
      "Diagnose deployment",
      started,
      started + 3_000,
    ]);
    database.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
      `${sessionId}-user`,
      sessionId,
      JSON.stringify({ role: "user", time: { created: started } }),
      started,
      started,
    ]);
    database.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
      `${sessionId}-assistant`,
      sessionId,
      JSON.stringify({
        role: "assistant",
        time: { created: started + 1_000, completed: started + 3_000 },
        providerID: "openai",
        modelID: "gpt-5",
        path: { cwd: root },
        tokens: { input: 120, output: 30 },
        ...(index < 2 ? { error: { name: "ToolError" } } : {}),
      }),
      started + 1_000,
      started + 3_000,
    ]);
    database.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
      `${sessionId}-prompt`,
      `${sessionId}-user`,
      sessionId,
      started,
      started,
      JSON.stringify({ type: "text", text: "Diagnose the failing deployment" }),
    ]);
    database.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
      `${sessionId}-skill-read`,
      `${sessionId}-assistant`,
      sessionId,
      started + 1_000,
      started + 2_000,
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: {
            filePath: join(root, ".agents", "skills", "diagnose", "SKILL.md"),
          },
          error: null,
        },
      }),
    ]);
    database.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
      `${sessionId}-test`,
      `${sessionId}-assistant`,
      sessionId,
      started + 2_000,
      started + 3_000,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test" },
          error: null,
        },
      }),
    ]);
  }
  database.close();
}

async function querySignals(analyticalPath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DuckDbAnalyticalStore).querySkillSignals();
    }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)), Effect.scoped),
  );
}

test("ingests current OpenCode SQLite sessions through the real source adapter into Desktop intelligence", async () => {
  writeNativeOpenCodeSource();
  const analyticalPath = join(root, "observability.duckdb");
  const traceLayer = Layer.provide(
    makeLocalTraceImporterLive(getDb()),
    makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
  );
  const adapter = makeOpenCodeSourceAdapter(join(root, "opencode-ingested.json"));
  const request = {
    sourceRoot,
    dryRun: false,
    force: false,
    skillLogPath: join(root, "skill.jsonl"),
  };

  await Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped));
  expect(
    getDb()
      .query("SELECT skill_name, COUNT(*) AS count FROM skill_invocations GROUP BY skill_name")
      .all(),
  ).toEqual([{ skill_name: "diagnose", count: 3 }]);
  expect(await querySignals(analyticalPath)).toEqual([
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
  const skillPath = join(root, ".agents", "skills", "diagnose", "SKILL.md");
  const revision = computeSkillVersionHash(skillPath);
  if (!revision) throw new Error("Expected fixture skill revision.");
  // Source import predates version capture; fixture the exact local revision
  // needed by the review-only candidate resolver.
  getDb().run("UPDATE skill_invocations SET skill_version_hash = ?", [revision]);
  getDb().run(
    "UPDATE skill_invocations SET query = 'Diagnose the failing deployment', triggered = 1",
  );

  const report = loadSkillIntelligence({
    db: getDb(),
    configRoot: root,
    installedSkills: [
      {
        name: "diagnose",
        skill_path: skillPath,
        package_path: join(root, ".agents", "skills", "diagnose"),
        registry_dir: join(root, ".agents", "skills"),
        modified_at: "2026-07-23T00:00:00.000Z",
        skill_scope: "global",
        content: "Diagnose failures.",
        harness: "opencode",
        active: true,
      },
    ],
    sessions: [],
    existingSets: [],
    outcomes: [],
    traceSignals: await querySignals(analyticalPath),
    now: new Date("2026-07-23T12:00:00.000Z"),
  });
  const desktopModel = mapLocalSkillSetIntelligence(report);
  expect(desktopModel.traceSignals).toEqual([
    expect.objectContaining({
      skillName: "diagnose",
      invocationCount: 3,
      traceCount: 3,
      errorTraceCount: 2,
    }),
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
  const desktopHtml = renderToStaticMarkup(
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
  expect(desktopHtml).toContain("diagnose");
  expect(desktopHtml).toContain("2 of 3 traced executions reported errors");
  expect(desktopHtml).toContain("3 invocations · 6 tool calls · 2 errors · 9,000 ms");
  expect(desktopHtml).toContain(
    "Correlation only — this does not show that the skill caused errors.",
  );

  let teacherCalls = 0;
  const pattern = desktopModel.executionPatterns.at(0);
  if (!pattern) throw new Error("Expected the OpenCode fixture to produce a supported pattern.");
  const review = await Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* TraceCandidatePreparation;
      return yield* preparation.prepare({ pattern_id: pattern.id });
    }).pipe(
      Effect.provide(
        Layer.provide(
          makeTraceCandidatePreparationLayer({
            sqlite: getDb(),
            searchDirs: [join(root, ".agents", "skills")],
            teacher: async () => {
              teacherCalls += 1;
              return {
                schema_version: 1,
                proposed_body:
                  "## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| diagnose | Diagnose |",
                rationale: "Keeps the observed diagnosis workflow explicit.",
                confidence: 0.8,
                target_section: "Workflow Routing",
                scope: "section_local",
                mutation_operation: "add",
                principle: "Keep diagnosis scoped.",
                applicability: "Observed diagnose requests.",
                failure_mode: "Repeated execution errors.",
                preserved_constraints: [],
                superseded_guidance: [],
                uncertainty: [],
              };
            },
            evolutionDeps: {
              validateBodyProposal: async (proposal) => ({
                proposal_id: proposal.proposal_id,
                gates_passed: 3,
                gates_total: 3,
                gate_results: [],
                improved: true,
                regressions: [],
              }),
            },
          }),
          makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
        ),
      ),
      Effect.scoped,
    ),
  );
  expect(teacherCalls).toBe(1);
  expect(review).toMatchObject({
    readiness: "review_ready",
    candidate: { diff: { target_section: "Workflow Routing" } },
  });
  expect(getDb().query("SELECT COUNT(*) AS count FROM skill_invocations").get()).toEqual({
    count: 3,
  });

  let staleRevisionCalls = 0;
  const staleReview = await Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* TraceCandidatePreparation;
      return yield* preparation.prepare({ pattern_id: pattern.id });
    }).pipe(
      Effect.provide(
        Layer.provide(
          makeTraceCandidatePreparationLayer({
            sqlite: getDb(),
            searchDirs: [join(root, ".agents", "skills")],
            computeRevision: () => (staleRevisionCalls++ === 0 ? revision : "stale-revision"),
            teacher: async () => {
              throw new Error("A stale target must not call the teacher.");
            },
          }),
          makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
        ),
      ),
      Effect.scoped,
    ),
  );
  expect(staleReview).toMatchObject({
    readiness: "not_ready",
    failure_reason: "The installed skill no longer matches the cohort target revision.",
    candidate: null,
  });

  getDb().run("UPDATE skill_invocations SET query = NULL WHERE skill_invocation_id = ?", [
    "opencode-desktop-2:s:diagnose:0",
  ]);
  const contrastReview = await Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* TraceCandidatePreparation;
      return yield* preparation.prepare({ pattern_id: pattern.id });
    }).pipe(
      Effect.provide(
        Layer.provide(
          makeTraceCandidatePreparationLayer({
            sqlite: getDb(),
            searchDirs: [join(root, ".agents", "skills")],
            teacher: async () => {
              throw new Error("Insufficient contrast must not call the teacher.");
            },
          }),
          makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath),
        ),
      ),
      Effect.scoped,
    ),
  );
  expect(contrastReview).toMatchObject({
    readiness: "not_ready",
    failure_reason:
      "Selected evidence could not be resolved at the exact target revision with both failure and success contrast.",
    candidate: null,
  });

  await expect(
    Effect.runPromise(adapter.sync(request).pipe(Effect.provide(traceLayer), Effect.scoped)),
  ).resolves.toMatchObject({ synced: 0 });
  expect(
    getDb()
      .query("SELECT skill_name, COUNT(*) AS count FROM skill_invocations GROUP BY skill_name")
      .all(),
  ).toEqual([{ skill_name: "diagnose", count: 3 }]);
  expect(await querySignals(analyticalPath)).toEqual([
    expect.objectContaining({
      invocation_count: 3,
      trace_count: 3,
      error_trace_count: 2,
    }),
  ]);
});
