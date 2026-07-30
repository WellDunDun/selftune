/* oxlint-disable no-await-in-loop -- crash, receipt, acknowledgement, and replay order is the behavior under test */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { openDb } from "@selftune/local-store";
import {
  DuckDbAnalyticalStore,
  type DuckDbAnalyticalStoreService,
  LocalTelemetryBatch,
  LocalTelemetrySkillLink,
  LocalTelemetrySpan,
  LocalTraceImporter,
  LocalTraceImportRequest,
} from "@selftune/observability";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import { makeLocalTraceImporterLive } from "@selftune/orchestration/sync/local-trace-importer";
import { loadSkillIntelligence } from "@selftune/runtime/skill-intelligence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { mapLocalSkillSetIntelligence } from "../../apps/local-dashboard/src/project-skill-intelligence.js";
import { SkillSetIntelligencePanels } from "../../packages/dashboard-core/src/screens/projects/SkillSetIntelligencePanels.js";

const sources = [
  {
    platform: "claude_code",
    captureMode: "transcript",
    boundary: "session",
    skillName: "claude-diagnose",
  },
  {
    platform: "codex",
    captureMode: "rollout",
    boundary: "actionable_turn",
    skillName: "codex-diagnose",
  },
  {
    platform: "opencode",
    captureMode: "session",
    boundary: "session",
    skillName: "opencode-diagnose",
  },
  {
    platform: "pi",
    captureMode: "session",
    boundary: "session",
    skillName: "pi-diagnose",
  },
] as const;

type Source = (typeof sources)[number];

function requestFor(source: Source, sourceIndex: number, traceIndex: number) {
  const identity = sourceIndex * 100 + traceIndex + 1;
  const traceId = identity.toString(16).padStart(32, "0");
  const spanId = identity.toString(16).padStart(16, "0");
  const invocationId = `${source.platform}-invocation-${traceIndex}`;
  return LocalTraceImportRequest.make({
    source_kind: source.platform,
    source_revision: `revision-${traceIndex}`,
    normalizer_version: "2026.07.23",
    batch: LocalTelemetryBatch.make({
      schema_version: "1.0.0",
      semantic_convention_version: "1.0.0",
      batch_id: `${source.platform}-batch-${traceIndex}`,
      spans: [
        LocalTelemetrySpan.make({
          trace_id: traceId,
          span_id: spanId,
          name: `invoke_agent ${source.platform}`,
          started_at: `2026-07-23T10:00:0${traceIndex}.000Z`,
          ended_at: `2026-07-23T10:00:0${traceIndex + 1}.000Z`,
          platform: source.platform,
          capture_mode: source.captureMode,
          source_authority: "source_truth",
          trace_boundary: source.boundary,
          operation_name: "invoke_agent",
          source_id: `${source.platform}-source-${traceIndex}`,
          input_tokens: 100 + traceIndex,
          output_tokens: 10,
          error_count: traceIndex < 2 ? 1 : 0,
          tool_call_count: traceIndex + 1,
        }),
      ],
      links: [
        LocalTelemetrySkillLink.make({
          link_id: (identity + 1_000).toString(16).padStart(32, "0"),
          trace_id: traceId,
          span_id: spanId,
          skill_invocation_id: invocationId,
        }),
      ],
    }),
  });
}

test(
  "shared importer recovers and derives metadata-only batches for every supported source kind",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-big-four-traces-"));
    const database = openDb(join(root, "selftune.db"));
    const analyticalPath = join(root, "observability.duckdb");
    const storeLayer = makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath);
    const importerLayer = Layer.provide(makeLocalTraceImporterLive(database), storeLayer);
    const importTrace = (request: LocalTraceImportRequest) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* LocalTraceImporter).importTrace(request);
        }).pipe(Effect.provide(importerLayer), Effect.scoped),
      );
    const queryStore = <A>(
      query: (store: DuckDbAnalyticalStoreService) => Effect.Effect<A, unknown>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* query(yield* DuckDbAnalyticalStore);
        }).pipe(
          Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(analyticalPath)),
          Effect.scoped,
        ),
      );

    try {
      for (const [sourceIndex, source] of sources.entries()) {
        const skillDir = join(root, ".agents", "skills", source.skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `# ${source.skillName}\n`, "utf8");
        for (let traceIndex = 0; traceIndex < 3; traceIndex += 1) {
          const sessionId = `${source.platform}-session-${traceIndex}`;
          database
            .query("INSERT INTO sessions (session_id, platform, capture_mode) VALUES (?, ?, ?)")
            .run(sessionId, source.platform, source.captureMode);
          database
            .query(
              "INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name) VALUES (?, ?, ?)",
            )
            .run(`${source.platform}-invocation-${traceIndex}`, sessionId, source.skillName);
        }

        const crashRequest = requestFor(source, sourceIndex, 0);
        database.run(
          `CREATE TRIGGER fail_${source.platform}_checkpoint
         BEFORE INSERT ON analytical_import_checkpoints
         WHEN NEW.source_kind = '${source.platform}'
         BEGIN
           SELECT RAISE(ABORT, 'simulated acknowledgement crash');
         END`,
        );
        await expect(importTrace(crashRequest)).rejects.toBeDefined();
        const afterCrash = await queryStore((store) => store.health());
        expect(afterCrash.span_count).toBe(sourceIndex * 3 + 1);

        database.run(`DROP TRIGGER fail_${source.platform}_checkpoint`);
        await importTrace(crashRequest);
        await importTrace(crashRequest);
        const afterReplay = await queryStore((store) => store.health());
        expect(afterReplay.span_count).toBe(sourceIndex * 3 + 1);

        await importTrace(requestFor(source, sourceIndex, 1));
        await importTrace(requestFor(source, sourceIndex, 2));
      }

      const result = await queryStore((store) =>
        Effect.all({
          health: store.health(),
          signals: store.querySkillSignals(),
        }),
      );
      expect(result.health).toMatchObject({
        span_count: 12,
        metric_count: 60,
        link_count: 12,
      });
      expect(result.signals).toHaveLength(4);
      for (const source of sources) {
        expect(result.signals).toContainEqual(
          expect.objectContaining({
            skill_name: source.skillName,
            invocation_count: 3,
            trace_count: 3,
            error_trace_count: 2,
            error_count: 2,
            tool_call_count: 6,
          }),
        );
      }
      expect(
        database.query("SELECT COUNT(*) AS count FROM analytical_import_checkpoints").get(),
      ).toEqual({ count: 12 });

      const installedSkills = sources.map((source) => ({
        name: source.skillName,
        skill_path: join(root, ".agents", "skills", source.skillName, "SKILL.md"),
        package_path: join(root, ".agents", "skills", source.skillName),
        registry_dir: join(root, ".agents", "skills"),
        modified_at: "2026-07-23T00:00:00.000Z",
        skill_scope: "project" as const,
        content: `Diagnose ${source.platform} failures.`,
        harness: source.platform,
        active: true,
      }));
      const report = loadSkillIntelligence({
        db: database,
        configRoot: root,
        installedSkills,
        sessions: [],
        existingSets: [],
        outcomes: [],
        traceSignals: result.signals,
        now: new Date("2026-07-23T12:00:00.000Z"),
      });
      const desktopModel = mapLocalSkillSetIntelligence(report);

      expect(desktopModel.traceSignals).toHaveLength(4);
      expect(desktopModel.executionPatterns).toHaveLength(4);
      for (const source of sources) {
        expect(desktopModel.executionPatterns).toContainEqual(
          expect.objectContaining({
            kind: "repeated_correlated_errors",
            skillId: source.skillName,
            skillName: source.skillName,
            traceCount: 3,
            matchingTraceCount: 2,
            ratio: 0.667,
            causalClaim: false,
          }),
        );
      }

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
      for (const source of sources) expect(html).toContain(source.skillName);
      expect(html).toContain("2 of 3 traced executions reported errors");
      expect(html).toContain("Correlation only");
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 15_000 },
);
