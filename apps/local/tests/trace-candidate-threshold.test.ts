import { describe, expect, test } from "bun:test";

import {
  boundedHistoricalTask,
  supportsContrastiveRepeatedErrorPattern,
} from "../src/trace-candidate-service.js";

describe("historical trace pattern threshold", () => {
  test("retains repeated failures when a mature skill has many successful traces", () => {
    expect(
      supportsContrastiveRepeatedErrorPattern({ uniqueTraceCount: 98, errorTraceCount: 4 }),
    ).toBe(true);
  });

  test("requires repeated failures and a successful counterexample", () => {
    expect(
      supportsContrastiveRepeatedErrorPattern({ uniqueTraceCount: 3, errorTraceCount: 1 }),
    ).toBe(false);
    expect(
      supportsContrastiveRepeatedErrorPattern({ uniqueTraceCount: 3, errorTraceCount: 3 }),
    ).toBe(false);
    expect(
      supportsContrastiveRepeatedErrorPattern({ uniqueTraceCount: 3, errorTraceCount: 2 }),
    ).toBe(true);
  });
});

describe("historical task boundary", () => {
  test("rejects evaluator wrappers and bounds redacted user tasks by bytes", () => {
    expect(
      boundedHistoricalTask(
        "The following is the Codex agent history whose request action you are assessing. transcript",
      ),
    ).toBeNull();
    expect(boundedHistoricalTask("# AGENTS.md instructions for /Users/daniel/project")).toBeNull();

    const task = boundedHistoricalTask(
      `create issues /to-issues token=super-secret /Users/daniel/project ${"x".repeat(1_000)}`,
    );
    expect(task).not.toContain("super-secret");
    expect(task).not.toContain("/Users/daniel");
    expect(new TextEncoder().encode(task ?? "").byteLength).toBeLessThanOrEqual(512);
  });

  test("removes an explicit skill invocation without treating it as a local path", () => {
    expect(boundedHistoricalTask("create all of them as issues /to-issues", "to-issues")).toBe(
      "create all of them as issues",
    );
  });
});
