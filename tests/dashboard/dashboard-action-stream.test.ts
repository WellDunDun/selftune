import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDashboardLlmObserver,
  emitDashboardStepProgress,
} from "../../cli/selftune/dashboard-action-instrumentation.js";
import {
  emitDashboardActionMetrics,
  emitDashboardActionProgress,
} from "../../cli/selftune/dashboard-action-events.js";
import type { DashboardActionEvent } from "../../cli/selftune/dashboard-contract.js";
import { startDashboardActionStream } from "../../cli/selftune/dashboard-action-stream.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  delete process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
  delete process.env.SELFTUNE_DASHBOARD_STREAM_DISABLE;
});

describe("dashboard-action-stream", () => {
  it("records stdout and finish events for terminal-run creator loop commands", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "eval",
      "generate",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write("building eval set\n");
    process.stderr.write("warming judge\n");
    session?.finish(0);

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events.map((event) => event.stage)).toEqual(["started", "stdout", "stderr", "finished"]);
    expect(events[0]?.action).toBe("generate-evals");
    expect(events[0]?.skill_name).toBe("Taxes");
    expect(events[1]?.chunk).toContain("building eval set");
    expect(events[3]?.success).toBe(true);
  });

  it("skips logging when dashboard streaming is explicitly disabled", () => {
    process.env.SELFTUNE_DASHBOARD_STREAM_DISABLE = "1";
    const session = startDashboardActionStream(["watch", "--skill", "Taxes"]);
    expect(session).toBeNull();
  });

  it("marks validated replay dry-runs as success even with exit code 1", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    expect(session).not.toBeNull();
    process.stdout.write(
      `${JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before_pass_rate: 0.75,
        after_pass_rate: 1,
        net_change: 0.25,
        validation_mode: "judge",
      })}\n`,
    );
    process.stderr.write("[NOT DEPLOYED] Dry run - proposal validated but not deployed\n");
    session?.finish(1);

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events.at(-1)?.stage).toBe("finished");
    expect(events.at(-1)?.success).toBe(true);
    expect(events.at(-1)?.exit_code).toBe(1);
    expect(events.at(-1)?.error).toBeNull();
    expect(events.at(-1)?.summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: 0.75,
      after_pass_rate: 1,
      net_change: 0.25,
      validation_mode: "judge",
    });
  });

  it("appends metrics events under the active dashboard action context", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    emitDashboardActionMetrics({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "runtime-session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 24,
      total_cost_usd: 0.09,
      duration_ms: 1500,
      num_turns: 1,
    });
    session?.finish(0);

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events.map((event) => event.stage)).toEqual(["started", "metrics", "finished"]);
    expect(events[1]?.metrics).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "runtime-session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 24,
      total_cost_usd: 0.09,
      duration_ms: 1500,
      num_turns: 1,
    });
  });

  it("appends progress events under the active dashboard action context", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "evolve",
      "--skill",
      "Taxes",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
      "--dry-run",
    ]);

    emitDashboardActionProgress({
      current: 1,
      total: 4,
      status: "started",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: null,
      evidence: null,
    });
    emitDashboardActionProgress({
      current: 1,
      total: 4,
      status: "finished",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: true,
      evidence: "selected target skill",
    });
    session?.finish(0);

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events.map((event) => event.stage)).toEqual([
      "started",
      "progress",
      "progress",
      "finished",
    ]);
    expect(events[1]?.progress).toEqual({
      current: 1,
      total: 4,
      status: "started",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: null,
      evidence: null,
    });
    expect(events[2]?.progress).toEqual({
      current: 1,
      total: 4,
      status: "finished",
      unit: "eval",
      phase: "validate",
      label: "Validate routing",
      query: "create a board deck for the monday review",
      passed: true,
      evidence: "selected target skill",
    });
  });

  it("emits provider-normalized LLM progress and metrics for non-replay actions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "selftune-action-stream-"));
    tempDirs.push(tempDir);
    const actionLogPath = join(tempDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;

    const session = startDashboardActionStream([
      "eval",
      "unit-test",
      "--skill",
      "Taxes",
      "--generate",
      "--skill-path",
      "/tmp/Taxes/SKILL.md",
    ]);

    emitDashboardStepProgress({
      current: 1,
      total: 3,
      status: "started",
      phase: "load_generation_inputs",
      label: "Load skill and failure context",
    });
    emitDashboardStepProgress({
      current: 1,
      total: 3,
      status: "finished",
      phase: "load_generation_inputs",
      label: "Load skill and failure context",
      passed: true,
      evidence: "4 eval failures",
    });

    const observer = createDashboardLlmObserver({
      current: 2,
      total: 3,
      phase: "generate_tests",
      label: "Generate unit tests",
    });
    observer.onStart?.({
      agent: "claude",
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      durationMs: null,
      success: null,
      error: null,
    });
    observer.onFinish?.({
      agent: "claude",
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      durationMs: 2200,
      success: true,
      error: null,
    });
    session?.finish(0);

    const events = readJsonl<DashboardActionEvent>(actionLogPath);
    expect(events.map((event) => event.stage)).toEqual([
      "started",
      "progress",
      "progress",
      "metrics",
      "progress",
      "metrics",
      "progress",
      "finished",
    ]);
    expect(events[4]?.progress).toEqual({
      current: 2,
      total: 3,
      status: "started",
      unit: "llm_call",
      phase: "generate_tests",
      label: "Generate unit tests",
      query: null,
      passed: null,
      evidence: "claude_code · claude-haiku-4-5-20251001",
    });
    expect(events[6]?.progress).toEqual({
      current: 2,
      total: 3,
      status: "finished",
      unit: "llm_call",
      phase: "generate_tests",
      label: "Generate unit tests",
      query: null,
      passed: true,
      evidence: "claude_code · claude-haiku-4-5-20251001 · 2.2s",
    });
    expect(events[5]?.metrics).toEqual({
      platform: "claude_code",
      model: "claude-haiku-4-5-20251001",
      session_id: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: 2200,
      num_turns: null,
    });
  });
});
