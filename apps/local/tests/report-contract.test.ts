import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { emptyLibrarySnapshot, CandidateSnapshot } from "@selftune/control-plane";
import { analyzeSkillIntelligence } from "@selftune/skill-intelligence";
import { buildPortfolioAudit } from "@selftune/runtime/skill-portfolio";
import { decodeReportOutput, ReportComputeError } from "../src/report-contract";
import {
  computeReportInSubprocess,
  computeReportInWorker,
  resolveReportComputeOptions,
} from "../src/report-compute";
import { makeMaterializedCache } from "../src/operation-cache";

const directories = new Set<string>();
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "selftune-report-contract-"));
  directories.add(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories.clear();
});

const installed = {
  name: "testing",
  skill_path: "/workspace/testing/SKILL.md",
  package_path: "/workspace/testing",
  registry_dir: "/workspace",
  modified_at: "2026-09-01T00:00:00Z",
  skill_scope: "project",
  content: "Test software",
  harness: "codex",
} satisfies Parameters<typeof analyzeSkillIntelligence>[0]["installedSkills"][number];
const portfolio = buildPortfolioAudit([installed], [], [], {
  now: new Date("2026-09-06T00:00:00Z"),
});
const intelligence = analyzeSkillIntelligence({
  installedSkills: [installed],
  sessions: [],
  traceSignals: [
    {
      skill_name: "testing",
      invocation_count: 4,
      trace_count: 4,
      error_trace_count: 3,
      duration_ms: 10,
      input_tokens: 100,
      output_tokens: 10,
      error_count: 3,
      tool_call_count: 4,
    },
  ],
  now: new Date("2026-09-06T00:00:00Z"),
});

describe("report payload contracts", () => {
  test("round-trips portfolio and intelligence evidence from the real producers", () => {
    expect(decodeReportOutput("portfolio-audit", JSON.stringify(portfolio))).toEqual(portfolio);
    expect(intelligence.classifications).toHaveLength(1);
    expect(intelligence.execution_patterns).toHaveLength(1);
    expect(decodeReportOutput("skill-intelligence", JSON.stringify(intelligence))).toEqual(
      intelligence,
    );
  });
  test("reuses the library and synthesis contracts and preserves local extensions", () => {
    const insights = {
      snapshot: CandidateSnapshot.make({
        snapshotId: "test",
        evidenceVersion: 1,
        generatedAt: "2026-09-06",
        candidates: [],
      }),
      portfolio_reviews: portfolio.skills,
      counts: {
        pending: 0,
        accepted: 0,
        drafted: 0,
        snoozed: 0,
        completed: 0,
        stale_reviews: 0,
        routing_reviews: 0,
      },
    };
    expect(decodeReportOutput("insights", JSON.stringify(insights))).toEqual(insights);
    expect(decodeReportOutput("library", JSON.stringify(emptyLibrarySnapshot))).toEqual(
      emptyLibrarySnapshot,
    );
    const extended = {
      ...intelligence,
      future_metadata: { measured: false },
      classifications: intelligence.classifications.map((row) => ({
        ...row,
        future_metadata: { measured: false },
      })),
    };
    expect(decodeReportOutput("skill-intelligence", JSON.stringify(extended))).toEqual(extended);
  });
  test("rejects invalid nested evidence instead of reporting it as measured", () => {
    const invalid = {
      ...intelligence,
      execution_patterns: intelligence.execution_patterns.map((row) => ({
        ...row,
        causal_claim: true,
      })),
    };
    expect(() => decodeReportOutput("skill-intelligence", JSON.stringify(invalid))).toThrow();
    expect(() =>
      decodeReportOutput(
        "portfolio-audit",
        JSON.stringify({ ...portfolio, skills: [{ ...portfolio.skills[0], evidence: null }] }),
      ),
    ).toThrow();
  });
  test.each(["portfolio-audit", "skill-intelligence", "insights", "library"] as const)(
    "rejects malformed %s envelopes",
    (report) => {
      for (const text of ["{", "null", "[]", "{}", '{"generated_at":123}'])
        expect(() => decodeReportOutput(report, text)).toThrow();
    },
  );
});

describe("report subprocess transport", () => {
  const fixture = join(import.meta.dir, "fixtures", "report-worker.ts");
  test("decodes real subprocess output and removes the temporary artifact", async () => {
    const dir = temporaryDirectory();
    const report = await Effect.runPromise(
      computeReportInWorker("portfolio-audit", { configRoot: dir, searchDirs: [] }, dir, {
        command: [process.execPath, fixture, "valid"],
      }),
    );
    expect(report.installed_count).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
  test.each(["invalid-json", "invalid-report"])(
    "rejects %s output and still cleans up",
    async (mode) => {
      const dir = temporaryDirectory();
      await expect(
        Effect.runPromise(
          computeReportInWorker("portfolio-audit", { configRoot: dir }, dir, {
            command: [process.execPath, fixture, mode],
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ReportComputeError", report: "portfolio-audit" });
      expect(readdirSync(dir)).toEqual([]);
    },
  );
  test("retains exit code and bounded stderr in the typed failure", async () => {
    const dir = temporaryDirectory();
    const result = await Effect.runPromise(
      Effect.result(
        computeReportInSubprocess(
          "portfolio-audit",
          { configRoot: dir },
          join(dir, "output.json"),
          { command: [process.execPath, fixture, "exit"] },
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected worker failure");
    expect(result.failure).toBeInstanceOf(ReportComputeError);
    expect(result.failure.exitCode).toBe(7);
    expect(result.failure.message).toContain("x".repeat(500));
    expect(result.failure.message.length).toBeLessThan(600);
  });
  test("kills an overdue worker and removes its partial output", async () => {
    const dir = temporaryDirectory();
    await expect(
      Effect.runPromise(
        computeReportInWorker("portfolio-audit", { configRoot: dir }, dir, {
          command: [process.execPath, fixture, "timeout"],
          timeoutMs: 500,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ReportComputeError" });
    expect(readdirSync(dir)).toEqual([]);
  });
  test("validates the actual report worker arguments before creating files", () => {
    const dir = temporaryDirectory();
    const worker = join(import.meta.dir, "../src/report-worker.ts");
    const out = join(dir, "output.json");
    for (const [report, options] of [
      ["unknown-report", resolveReportComputeOptions({ configRoot: dir })],
      ["portfolio-audit", {}],
      [
        "portfolio-audit",
        { storagePaths: { configRoot: dir, localDatabasePath: 3, localAnalyticsPath: "x" } },
      ],
    ]) {
      const result = Bun.spawnSync(
        [process.execPath, worker, String(report), JSON.stringify(options), out],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(out)).toBe(false);
    }
  });
  test("computes and decodes a real portfolio report through the worker", async () => {
    const dir = temporaryDirectory();
    const report = await Effect.runPromise(
      computeReportInWorker("portfolio-audit", { configRoot: dir, searchDirs: [] }, dir),
    );
    expect(report.installed_count).toBe(0);
    expect(report.skills).toEqual([]);
  });
});

describe("persisted report cache decoding", () => {
  test.each([
    "{",
    "null",
    '{"schema_version":2,"generated_at":"today","data":1}',
    '{"schema_version":1,"generated_at":"today","data":"not a number"}',
  ])("recomputes a malformed artifact: %s", async (text) => {
    const dir = temporaryDirectory();
    const artifactPath = join(dir, "report.json");
    writeFileSync(artifactPath, text);
    let calls = 0;
    const value = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeMaterializedCache(
            Effect.sync(() => {
              calls += 1;
              return 42;
            }),
            { artifactPath, schema: Schema.Number, readVersion: () => "v1" },
          );
          return yield* cache.read;
        }),
      ),
    );
    expect(value).toBe(42);
    expect(calls).toBe(1);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ data: Schema.Number })))(
        readFileSync(artifactPath, "utf8"),
      ).data,
    ).toBe(42);
  });
});
