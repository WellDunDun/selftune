import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dashboardActionContextEnv,
  emitDashboardActionProgress,
  setCurrentDashboardActionContext,
} from "../../packages/runtime/dashboard-action-events.js";
import type { DashboardActionEvent } from "../../packages/runtime/dashboard-contract.js";
import { readJsonl } from "../../packages/runtime/utils/jsonl.js";

const tempDirs: string[] = [];

afterEach(() => {
  setCurrentDashboardActionContext(null);
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }

  delete process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SELFTUNE_DASHBOARD_ACTION_")) {
      delete process.env[key];
    }
  }
});

describe("dashboard-action-events", () => {
  it("reads report-package context from env for child-process progress events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-events-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    Object.assign(
      process.env,
      dashboardActionContextEnv({
        eventId: "event-report-1",
        action: "report-package",
        skillName: null,
        skillPath: "/tmp/Taxes/SKILL.md",
      }),
    );

    emitDashboardActionProgress({
      current: 1,
      total: 2,
      status: "started",
      unit: "step",
      phase: "package_report",
      label: "Run package report",
      query: null,
      passed: null,
      evidence: null,
    });

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("report-package");
    expect(events[0]?.stage).toBe("progress");
    expect(events[0]?.skill_path).toBe("/tmp/Taxes/SKILL.md");
    expect(events[0]?.progress?.label).toBe("Run package report");
  });

  it("reads search-run context from env for child-process progress events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-events-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    Object.assign(
      process.env,
      dashboardActionContextEnv({
        eventId: "event-search-1",
        action: "search-run",
        skillName: "Taxes",
        skillPath: "/tmp/Taxes/SKILL.md",
      }),
    );

    emitDashboardActionProgress({
      current: 1,
      total: 3,
      status: "started",
      unit: "step",
      phase: "package_search",
      label: "Evaluate bounded candidates",
      query: null,
      passed: null,
      evidence: null,
    });

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("search-run");
    expect(events[0]?.skill_name).toBe("Taxes");
    expect(events[0]?.progress?.phase).toBe("package_search");
  });
});
