import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OrchestrateRunReport } from "./orchestration";

const report: OrchestrateRunReport = {
  run_id: "run",
  timestamp: "2026-09-05T00:00:00Z",
  elapsed_ms: 100,
  dry_run: true,
  approval_mode: "review",
  total_skills: 1,
  evaluated: 1,
  evolved: 0,
  deployed: 0,
  watched: 0,
  skipped: 0,
  skill_actions: [{ skill: "marketing", action: "package-search", reason: "compare variants" }],
};

describe("shared orchestration report contract", () => {
  it("recognizes package search with optional measured counters", () => {
    const measured = { ...report, package_searched: 1, package_improved: 0, auto_graded: 0 };
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrateRunReport))(
        JSON.stringify(measured),
      ),
    ).toEqual(measured);
  });

  it("preserves reports created before optional counters were recorded", () => {
    expect(Schema.decodeUnknownSync(OrchestrateRunReport)(report)).toEqual(report);
  });

  it("rejects unknown action names and string counters", () => {
    expect(Schema.is(OrchestrateRunReport)({ ...report, package_searched: "1" })).toBe(false);
    expect(
      Schema.is(OrchestrateRunReport)({
        ...report,
        skill_actions: [{ skill: "marketing", action: "unknown", reason: "invalid" }],
      }),
    ).toBe(false);
  });
});
