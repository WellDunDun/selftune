import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscoveredWorkflow, WorkflowDiscoveryReport } from "../../cli/selftune/types.js";
import { openDb } from "../../cli/selftune/localdb/db.js";
import {
  writeSkillCheckToDb,
  writeSessionTelemetryToDb,
} from "../../cli/selftune/localdb/direct-write.js";
import {
  buildWorkflowSkillDraft,
  formatWorkflowSkillDraft,
} from "../../cli/selftune/workflows/skill-scaffold.js";
import { cliMain, formatWorkflows } from "../../cli/selftune/workflows/workflows.js";

// ---------------------------------------------------------------------------
// Helper to build minimal DiscoveredWorkflow fixtures
// ---------------------------------------------------------------------------
function makeWorkflow(overrides: Partial<DiscoveredWorkflow> = {}): DiscoveredWorkflow {
  return {
    workflow_id: "A\u2192B",
    skills: ["A", "B"],
    occurrence_count: 5,
    avg_errors: 1.0,
    avg_errors_individual: 2.0,
    synergy_score: 0.5,
    representative_query: "do the thing",
    sequence_consistency: 0.8,
    completion_rate: 0.75,
    first_seen: "2025-01-01T00:00:00Z",
    last_seen: "2025-06-01T00:00:00Z",
    session_ids: ["s1", "s2", "s3"],
    ...overrides,
  };
}

function makeReport(workflows: DiscoveredWorkflow[], totalSessions = 100): WorkflowDiscoveryReport {
  return {
    workflows,
    total_sessions_analyzed: totalSessions,
    generated_at: "2025-06-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// formatWorkflows
// ---------------------------------------------------------------------------
describe("formatWorkflows", () => {
  it("shows 'No workflows discovered.' for empty report", () => {
    const report = makeReport([]);
    const output = formatWorkflows(report);
    expect(output).toBe("No workflows discovered.");
  });

  it("shows header with session count for non-empty report", () => {
    const report = makeReport([makeWorkflow()], 42);
    const output = formatWorkflows(report);
    expect(output).toContain("Discovered Workflows (from 42 sessions):");
  });

  it("formats a single workflow correctly", () => {
    const wf = makeWorkflow({
      skills: ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      occurrence_count: 12,
      synergy_score: 0.72,
      sequence_consistency: 0.83,
      completion_rate: 0.83,
      representative_query: "write and publish a blog post",
    });
    const report = makeReport([wf], 50);
    const output = formatWorkflows(report);

    expect(output).toContain("1. Copywriting \u2192 MarketingAutomation \u2192 SelfTuneBlog");
    expect(output).toContain("Occurrences: 12");
    expect(output).toContain("Synergy: 0.72");
    expect(output).toContain("Consistency: 83%");
    expect(output).toContain("Completion: 83%");
    expect(output).toContain('Common trigger: "write and publish a blog post"');
  });

  it("formats multiple workflows with numbered list", () => {
    const wf1 = makeWorkflow({
      skills: ["A", "B"],
      occurrence_count: 10,
      synergy_score: 0.5,
      sequence_consistency: 1.0,
      completion_rate: 1.0,
      representative_query: "query one",
    });
    const wf2 = makeWorkflow({
      workflow_id: "C\u2192D",
      skills: ["C", "D"],
      occurrence_count: 8,
      synergy_score: 0.3,
      sequence_consistency: 0.75,
      completion_rate: 0.5,
      representative_query: "query two",
    });
    const report = makeReport([wf1, wf2], 200);
    const output = formatWorkflows(report);

    expect(output).toContain("1. A \u2192 B");
    expect(output).toContain("2. C \u2192 D");
    expect(output).toContain('Common trigger: "query one"');
    expect(output).toContain('Common trigger: "query two"');
  });

  it("formats synergy score with two decimals", () => {
    const wf = makeWorkflow({ synergy_score: 0.123456 });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain("Synergy: 0.12");
  });

  it("formats negative synergy score", () => {
    const wf = makeWorkflow({ synergy_score: -0.45 });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain("Synergy: -0.45");
  });

  it("rounds consistency and completion to percentages", () => {
    const wf = makeWorkflow({
      sequence_consistency: 0.666,
      completion_rate: 0.333,
    });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain("Consistency: 67%");
    expect(output).toContain("Completion: 33%");
  });

  it("handles 100% consistency and completion", () => {
    const wf = makeWorkflow({
      sequence_consistency: 1.0,
      completion_rate: 1.0,
    });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain("Consistency: 100%");
    expect(output).toContain("Completion: 100%");
  });

  it("handles 0% consistency and completion", () => {
    const wf = makeWorkflow({
      sequence_consistency: 0,
      completion_rate: 0,
    });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain("Consistency: 0%");
    expect(output).toContain("Completion: 0%");
  });

  it("omits common trigger line when representative_query is empty", () => {
    const wf = makeWorkflow({ representative_query: "" });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).not.toContain("Common trigger:");
  });

  it("shows representative query in quotes", () => {
    const wf = makeWorkflow({ representative_query: "research and write about topic" });
    const output = formatWorkflows(makeReport([wf]));
    expect(output).toContain('"research and write about topic"');
  });

  it("formats a workflow skill draft preview", () => {
    const draft = buildWorkflowSkillDraft(
      makeWorkflow({
        skills: ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
        representative_query: "write and publish a blog post",
        workflow_id: "Copywriting→MarketingAutomation→SelfTuneBlog",
      }),
      { outputDir: "/tmp/repo/.agents/skills" },
    );

    const output = formatWorkflowSkillDraft(draft);
    expect(output).toContain("Draft workflow skill:");
    expect(output).toContain(
      "Output path: /tmp/repo/.agents/skills/write-publish-blog-post/SKILL.md",
    );
    expect(output).toContain("=== references/overview.md ===");
  });
});

describe("workflows scaffold --write", () => {
  let db: ReturnType<typeof openDb>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a fresh workflow scaffold without requiring --force", async () => {
    for (let index = 0; index < 3; index++) {
      const sessionId = `workflow-session-${index}`;
      const baseMinute = index * 10;

      writeSessionTelemetryToDb(
        {
          timestamp: `2026-04-14T12:${String(baseMinute).padStart(2, "0")}:00Z`,
          session_id: sessionId,
          cwd: `/tmp/project-${index}`,
          transcript_path: `/tmp/project-${index}/transcript.jsonl`,
          tool_calls: {},
          total_tool_calls: 0,
          bash_commands: [],
          skills_triggered: ["Copywriting", "MarketingAutomation"],
          skills_invoked: ["Copywriting", "MarketingAutomation"],
          assistant_turns: 2,
          errors_encountered: 0,
          transcript_chars: 200,
          last_user_query: "write and publish a launch post",
          source: "test",
        },
        db,
      );

      writeSkillCheckToDb(
        {
          skill_invocation_id: `${sessionId}-copywriting`,
          occurred_at: `2026-04-14T12:${String(baseMinute).padStart(2, "0")}:01Z`,
          session_id: sessionId,
          skill_name: "Copywriting",
          invocation_mode: "implicit",
          skill_path: "/tmp/skills/copywriting/SKILL.md",
          confidence: 0.9,
          skill_scope: "global",
          query: "write and publish a launch post",
          triggered: true,
          platform: "codex",
          agent_type: "codex",
          source: "test",
        },
        db,
      );
      writeSkillCheckToDb(
        {
          skill_invocation_id: `${sessionId}-marketing-automation`,
          occurred_at: `2026-04-14T12:${String(baseMinute + 1).padStart(2, "0")}:02Z`,
          session_id: sessionId,
          skill_name: "MarketingAutomation",
          invocation_mode: "implicit",
          skill_path: "/tmp/skills/marketing-automation/SKILL.md",
          confidence: 0.9,
          skill_scope: "global",
          query: "write and publish a launch post",
          triggered: true,
          platform: "codex",
          agent_type: "codex",
          source: "test",
        },
        db,
      );
    }

    const outputDir = mkdtempSync(join(tmpdir(), "selftune-workflow-scaffold-"));
    tempDirs.push(outputDir);
    const logs: string[] = [];

    await cliMain({
      args: ["scaffold", "1", "--output-dir", outputDir, "--write", "--json"],
      db,
      log: (value) => logs.push(String(value ?? "")),
    });

    expect(existsSync(join(outputDir, "write-publish-launch-post", "SKILL.md"))).toBe(true);
    expect(logs.some((line) => line.includes('"written": true'))).toBe(true);
  });
});
