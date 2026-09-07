import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setTestDb, getDb, openDb } from "@selftune/local-store";
import {
  DuckDbAnalyticalStore,
  DuckDbAnalyticalStoreFailure,
  type DuckDbAnalyticalStoreService,
} from "@selftune/observability/duckdb-store";
import {
  loadFailSoftTraceSignalsEffect,
  loadSkillIntelligenceWithCatalogEffect,
  type LoadSkillIntelligenceWithCatalogOptions,
} from "@selftune/runtime/skill-intelligence/catalog-expansions";
import type {
  SkillIntelligenceInstalledSkill,
  SkillTraceSignal,
} from "@selftune/skill-intelligence";
import { Effect, Layer } from "effect";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-catalog-duckdb-"));
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(root, { recursive: true, force: true });
});

function installedSkill(name: string): SkillIntelligenceInstalledSkill {
  return {
    name,
    skill_path: join(root, "skills", name, "SKILL.md"),
    package_path: join(root, "skills", name),
    registry_dir: join(root, "skills"),
    modified_at: "2026-07-23T00:00:00.000Z",
    skill_scope: "global",
    content: `Use ${name} for this workflow.`,
    harness: "codex",
    active: true,
  };
}

function options(): LoadSkillIntelligenceWithCatalogOptions {
  return {
    db: getDb(),
    configRoot: root,
    installedSkills: [installedSkill("diagnose")],
    sessions: [],
    observations: [],
    existingSets: [],
    outcomes: [],
    now: new Date("2026-07-23T12:00:00.000Z"),
  };
}

function storeWithQuery(querySkillSignals: DuckDbAnalyticalStoreService["querySkillSignals"]) {
  return Layer.succeed(
    DuckDbAnalyticalStore,
    DuckDbAnalyticalStore.of({
      hasExactBatchReceipt: () => Effect.succeed(false),
      ingest: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({ operation: "test ingest", message: "unused" }),
        ),
      querySkillSignals,
      queryEvidenceCohortCandidates: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({
            operation: "test query evidence cohorts",
            message: "unused",
          }),
        ),
      queryHistoricalSkillTaskReferences: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({
            operation: "test query historical skill tasks",
            message: "unused",
          }),
        ),
      queryHistoricalMetricRollups: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({
            operation: "test query historical metric rollups",
            message: "unused",
          }),
        ),
      health: () =>
        Effect.fail(
          DuckDbAnalyticalStoreFailure.make({ operation: "test health", message: "unused" }),
        ),
    }),
  );
}

test("returns the product report when the optional DuckDB signal query fails", async () => {
  const report = await Effect.runPromise(
    Effect.scoped(
      loadSkillIntelligenceWithCatalogEffect(options()).pipe(
        Effect.provide(
          storeWithQuery(() =>
            Effect.fail(
              DuckDbAnalyticalStoreFailure.make({
                operation: "test query signals",
                message: "writer owns DuckDB",
              }),
            ),
          ),
        ),
      ),
    ),
  );

  expect(report.installed_skills).toBe(1);
  expect(report.trace_signals).toEqual([]);
});

test("runs discovery and report preparation once when the analytical query fails", async () => {
  const skillsRoot = join(root, "skills");
  const skillPath = join(skillsRoot, "diagnose", "SKILL.md");
  mkdirSync(join(skillsRoot, "diagnose"), { recursive: true });
  writeFileSync(skillPath, "---\nname: diagnose\ndescription: Diagnose failures.\n---\n");

  let contentReads = 0;
  let catalogSearches = 0;
  const report = await Effect.runPromise(
    Effect.scoped(
      loadSkillIntelligenceWithCatalogEffect({
        db: getDb(),
        configRoot: root,
        searchDirs: [skillsRoot],
        quarantineRoot: join(root, "quarantine"),
        sessions: [
          {
            timestamp: "2026-07-23T12:00:00.000Z",
            session_id: "catalog-failsoft",
            cwd: root,
            errors_encountered: 0,
            last_user_query: "Build the Cloudflare React frontend",
          },
        ],
        observations: [],
        existingSets: [],
        outcomes: [],
        now: new Date("2026-07-23T12:00:00.000Z"),
        contentLoader: () => {
          contentReads += 1;
          return "---\nname: diagnose\ndescription: Diagnose failures.\n---\n";
        },
        catalogSearch: () => {
          catalogSearches += 1;
          return Effect.succeed([]);
        },
      }).pipe(
        Effect.provide(
          storeWithQuery(() =>
            Effect.fail(
              DuckDbAnalyticalStoreFailure.make({ operation: "test query", message: "locked" }),
            ),
          ),
        ),
      ),
    ),
  );

  expect(report.trace_signals).toEqual([]);
  expect(contentReads).toBe(1);
  expect(catalogSearches).toBe(4);
});

test("falls back when acquiring the analytical Layer fails before a query", async () => {
  const skillsRoot = join(root, "skills");
  mkdirSync(join(skillsRoot, "diagnose"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "diagnose", "SKILL.md"),
    "---\nname: diagnose\ndescription: Diagnose failures.\n---\n",
  );

  let contentReads = 0;
  let catalogSearches = 0;
  const resolvedTraceSignals = loadFailSoftTraceSignalsEffect(
    Layer.effect(
      DuckDbAnalyticalStore,
      Effect.fail(
        DuckDbAnalyticalStoreFailure.make({
          operation: "open analytical database",
          message: "writer owns DuckDB",
        }),
      ),
    ),
  );
  const report = await Effect.runPromise(
    resolvedTraceSignals.pipe(
      Effect.flatMap((traceSignalSnapshot) =>
        loadSkillIntelligenceWithCatalogEffect({
          db: getDb(),
          configRoot: root,
          searchDirs: [skillsRoot],
          quarantineRoot: join(root, "quarantine"),
          sessions: [
            {
              timestamp: "2026-07-23T12:00:00.000Z",
              session_id: "layer-acquisition-failsoft",
              cwd: root,
              errors_encountered: 0,
              last_user_query: "Build the Flutter mobile app with Dart and Serve Sim",
            },
          ],
          observations: [],
          existingSets: [],
          outcomes: [],
          now: new Date("2026-07-23T12:00:00.000Z"),
          contentLoader: () => {
            contentReads += 1;
            return "---\nname: diagnose\ndescription: Diagnose failures.\n---\n";
          },
          catalogSearch: () => {
            catalogSearches += 1;
            return Effect.succeed([]);
          },
          traceSignals: traceSignalSnapshot,
        }),
      ),
    ),
  );

  expect(report.trace_signals).toEqual([]);
  expect(report.installed_skills).toBe(1);
  expect(contentReads).toBe(1);
  expect(catalogSearches).toBe(3);
});

test("uses a caller-supplied trace snapshot without querying DuckDB", async () => {
  const traceSignals: ReadonlyArray<SkillTraceSignal> = [
    {
      skill_name: "diagnose",
      invocation_count: 1,
      trace_count: 1,
      error_trace_count: 0,
      duration_ms: 10,
      input_tokens: 2,
      output_tokens: 1,
      error_count: 0,
      tool_call_count: 1,
    },
  ];
  let analyticalQueries = 0;

  const report = await Effect.runPromise(
    Effect.scoped(
      loadSkillIntelligenceWithCatalogEffect({ ...options(), traceSignals }).pipe(
        Effect.provide(
          storeWithQuery(() => {
            analyticalQueries += 1;
            return Effect.succeed([]);
          }),
        ),
      ),
    ),
  );

  expect(analyticalQueries).toBe(0);
  expect(report.trace_signals).toEqual([...traceSignals]);
});
