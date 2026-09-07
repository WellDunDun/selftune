import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { runScenario } from "../src/scenario-runner";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

test("matrix recovery preserves valid results, replaces one target, and skips malformed neighbors", async () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-matrix-boundary-"));
  try {
    const previous = {
      target: "previous",
      scenario: "library",
      source: "fixture.ts",
      timestamp: "2026-09-06T00:00:00Z",
      duration_ms: 0,
      run_directory: "/fixture/previous",
      status: "passed",
      observable_outcome: {
        installed_hash: "original",
        receipt_status: "applied",
        extension: [1, 2],
      },
    };
    writeFileSync(
      join(root, "matrix.json"),
      JSON.stringify({ results: [null, [], { target: "broken" }, previous] }),
    );
    const options = {
      target: "current",
      scenario: "library",
      source: import.meta.filename,
      runsRoot: root,
      layer: Layer.empty,
    };
    await runScenario({
      ...options,
      program: Effect.succeed({ installed_hash: "first", receipt_status: "applied" }),
    });
    await runScenario({
      ...options,
      program: Effect.succeed({ installed_hash: "latest", receipt_status: 42 }),
    });
    expect(decodeJson(readFileSync(join(root, "matrix.json"), "utf8"))).toMatchObject({
      results: [
        previous,
        {
          target: "current",
          status: "passed",
          observable_outcome: { installed_hash: "latest", receipt_status: 42 },
        },
      ],
      parity: [
        {
          target: "previous",
          scenario: "library",
          status: "passed",
          installed_hash: "original",
          receipt_status: "applied",
        },
        { target: "current", scenario: "library", status: "passed", installed_hash: "latest" },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("void outcomes and malformed matrix JSON still produce a valid run record", async () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-matrix-empty-"));
  try {
    writeFileSync(join(root, "matrix.json"), "not JSON");
    const result = await runScenario({
      target: "fixture",
      scenario: "void",
      source: import.meta.filename,
      runsRoot: root,
      layer: () => Layer.empty,
      program: Effect.void,
    });
    expect(result.status).toBe("passed");
    expect(decodeJson(readFileSync(join(root, "matrix.json"), "utf8"))).toMatchObject({
      results: [{ target: "fixture", status: "passed" }],
      parity: [{ target: "fixture", scenario: "void", status: "passed" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
