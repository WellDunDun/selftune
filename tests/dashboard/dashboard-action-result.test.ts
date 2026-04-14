import { describe, expect, it } from "bun:test";

import {
  extractDashboardActionSummary,
  resolveDashboardActionOutcome,
} from "../../cli/selftune/dashboard-action-result.js";

describe("dashboard-action-result", () => {
  it("treats validated replay dry-runs as success even when the CLI exits 1", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "replay-dry-run",
      exitCode: 1,
      stderr: "[NOT DEPLOYED] Dry run - proposal validated but not deployed",
      stdout: JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
      }),
    });

    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: null,
    });
  });

  it("keeps real replay failures as failures", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "replay-dry-run",
      exitCode: 1,
      stderr: "validation failed",
      stdout: JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Validation failed",
        improved: false,
      }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("validation failed");
  });

  it("extracts replay dry-run lift details for the live run screen", () => {
    const summary = extractDashboardActionSummary(
      "replay-dry-run",
      JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before_pass_rate: 0.75,
        after_pass_rate: 1,
        net_change: 0.25,
        validation_mode: "judge",
      }),
    );

    expect(summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: 0.75,
      after_pass_rate: 1,
      net_change: 0.25,
      validation_mode: "judge",
    });
  });

  it("supports the current evolve dry-run before/after keys", () => {
    const summary = extractDashboardActionSummary(
      "replay-dry-run",
      JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before: 0.75,
        after: 1,
        net_change: 0.25,
      }),
    );

    expect(summary?.before_pass_rate).toBe(0.75);
    expect(summary?.after_pass_rate).toBe(1);
    expect(summary?.net_change).toBe(0.25);
  });
});
