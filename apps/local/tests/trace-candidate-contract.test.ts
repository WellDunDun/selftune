import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { TraceCandidateRequest } from "../src/trace-candidate-contract.js";
import {
  HostHistoricalTaskCalibration,
  makeHostHistoricalTaskCalibrationLayer,
} from "../src/historical-skill-replay-executor.js";

describe("trace candidate input contract", () => {
  const decode = Schema.decodeUnknownSync(TraceCandidateRequest);

  test.each([
    { input: null },
    { input: [] },
    { input: {} },
    { input: { pattern_id: "" } },
    { input: { pattern_id: 42 } },
    { input: { pattern_id: "pattern", candidate_count: 1 } },
    { input: { pattern_id: "pattern", candidate_count: 9 } },
    { input: { pattern_id: "pattern", candidate_count: 2.5 } },
    { input: { pattern_id: "pattern", candidate_count: "3" } },
    { input: { pattern_id: "pattern", calibration_repetitions: 0 } },
    { input: { pattern_id: "pattern", calibration_repetitions: 6 } },
    { input: { pattern_id: "pattern", calibration_repetitions: 1.5 } },
  ])("rejects malformed requests: %j", ({ input }) => {
    expect(() => decode(input)).toThrow();
  });

  test("retains omitted defaults and both inclusive limits", () => {
    expect(decode({ pattern_id: "pattern" })).toEqual({ pattern_id: "pattern" });
    for (const input of [
      { pattern_id: "pattern", candidate_count: 2, calibration_repetitions: 1 },
      { pattern_id: "pattern", candidate_count: 8, calibration_repetitions: 5 },
    ]) {
      expect(decode(input)).toEqual(input);
    }
  });

  test("the calibration layer rejects an unsupported harness before replay", async () => {
    const calibrate = await Effect.runPromise(
      HostHistoricalTaskCalibration.pipe(
        Effect.provide(
          makeHostHistoricalTaskCalibrationLayer({
            agent: "claude",
            model: "configured-default",
          }),
        ),
      ),
    );
    await expect(
      calibrate({
        task: "Create release issues",
        body: "Draft issues from the plan.",
        skillName: "to-issues",
        skillPath: "/nonexistent/selftune-test/SKILL.md",
      }),
    ).rejects.toThrow("Historical task calibration currently requires the Codex harness.");
  });
});
