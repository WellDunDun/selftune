import { describe, expect, test } from "bun:test";

import type { OrchestrateResult } from "../../cli/selftune/orchestrate.js";
import {
  buildOrchestrateJsonOutput,
  parseOrchestrateCliArgs,
  renderOrchestrateHelp,
} from "../../cli/selftune/orchestrate/cli.js";

describe("parseOrchestrateCliArgs", () => {
  test("parses default run options", () => {
    const parsed = parseOrchestrateCliArgs([]);
    expect(parsed.showHelp).toBe(false);
    expect(parsed.loop).toBe(false);
    expect(parsed.loopIntervalSeconds).toBe(3600);
    expect(parsed.runOptions).toEqual({
      dryRun: false,
      approvalMode: "auto",
      maxSkills: 5,
      recentWindowHours: 48,
      syncForce: false,
      maxAutoGrade: 5,
    });
  });

  test("maps review mode and loop flags", () => {
    const parsed = parseOrchestrateCliArgs([
      "--review-required",
      "--skill",
      "writer",
      "--max-skills",
      "2",
      "--recent-window",
      "72",
      "--sync-force",
      "--max-auto-grade",
      "0",
      "--loop",
      "--loop-interval",
      "600",
    ]);

    expect(parsed.showHelp).toBe(false);
    expect(parsed.loop).toBe(true);
    expect(parsed.loopIntervalSeconds).toBe(600);
    expect(parsed.runOptions).toEqual({
      dryRun: false,
      approvalMode: "review",
      skillFilter: "writer",
      maxSkills: 2,
      recentWindowHours: 72,
      syncForce: true,
      maxAutoGrade: 0,
    });
  });

  test("returns help mode without requiring other flags", () => {
    const parsed = parseOrchestrateCliArgs(["--help"]);
    expect(parsed.showHelp).toBe(true);
    expect(renderOrchestrateHelp()).toContain("selftune orchestrate");
  });

  test("rejects invalid max skills", () => {
    expect(() => parseOrchestrateCliArgs(["--max-skills", "0"])).toThrow(
      "--max-skills must be a positive integer",
    );
  });

  test("rejects too-small loop interval only in loop mode", () => {
    expect(() => parseOrchestrateCliArgs(["--loop", "--loop-interval", "30"])).toThrow(
      "--loop-interval must be an integer >= 60 (seconds)",
    );
    expect(parseOrchestrateCliArgs(["--loop-interval", "30"]).loopIntervalSeconds).toBe(30);
  });

  test("emits deprecation warning metadata for auto-approve", () => {
    const parsed = parseOrchestrateCliArgs(["--auto-approve"]);
    expect(parsed.warnings).toEqual([
      "[orchestrate] --auto-approve is deprecated; autonomous mode is now the default.",
    ]);
  });
});

describe("buildOrchestrateJsonOutput", () => {
  test("serializes workflow proposals and per-skill decisions", () => {
    const result: OrchestrateResult = {
      syncResult: {
        since: null,
        dry_run: false,
        sources: {
          claude: { available: true, scanned: 1, synced: 1, skipped: 0 },
          codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
          opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
          openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
          pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
        },
        repair: {
          ran: false,
          repaired_sessions: 0,
          repaired_records: 0,
          codex_repaired_records: 0,
        },
        creator_contributions: {
          ran: false,
          eligible_skills: 0,
          built_signals: 0,
          staged_signals: 0,
        },
        timings: [],
        total_elapsed_ms: 0,
      },
      statusResult: {
        skills: [],
        unmatchedQueries: 0,
        pendingProposals: 0,
        lastSession: null,
        system: { healthy: true, pass: 1, fail: 0, warn: 0 },
      },
      candidates: [
        {
          skill: "writer",
          action: "evolve",
          reason: "status=WARNING",
          evolveResult: {
            proposal: null,
            validation: {
              proposal_id: "p1",
              before_pass_rate: 0.4,
              after_pass_rate: 0.8,
              improved: true,
              regressions: [],
              new_passes: [],
              net_change: 0.4,
            },
            deployed: true,
            auditEntries: [],
            reason: "deployed",
            llmCallCount: 2,
            elapsedMs: 10,
          },
          watchResult: {
            snapshot: {
              timestamp: new Date().toISOString(),
              skill_name: "writer",
              window_sessions: 10,
              skill_checks: 10,
              pass_rate: 0.8,
              false_negative_rate: 0.1,
              by_invocation_type: {
                explicit: { passed: 4, total: 5 },
                implicit: { passed: 4, total: 5 },
                contextual: { passed: 0, total: 0 },
                negative: { passed: 0, total: 0 },
              },
              regression_detected: false,
              baseline_pass_rate: 0.7,
            },
            alert: null,
            rolledBack: false,
            recommendation: "stable",
          },
        },
      ],
      workflowProposals: [
        {
          proposal_id: "wf1",
          source_skill_name: "writer",
          workflow: {
            workflow_id: "flow-1",
            skills: ["writer", "editor"],
            occurrence_count: 3,
            avg_errors: 0,
            avg_errors_individual: 0,
            synergy_score: 0.7,
            representative_query: "write then edit content",
            sequence_consistency: 0.8,
            completion_rate: 0.9,
            first_seen: "2026-03-14T12:00:00Z",
            last_seen: "2026-03-14T12:00:00Z",
            session_ids: ["sess-1", "sess-2", "sess-3"],
          },
          draft: {
            title: "Writer Editor",
            skill_name: "writer-editor",
            output_dir: "/tmp",
            skill_dir: "/tmp/writer-editor",
            skill_path: "/tmp/writer-editor/SKILL.md",
            description: "workflow skill",
            content: "# Writer Editor",
            source_workflow: {
              workflow_id: "flow-1",
              skills: ["writer", "editor"],
              occurrence_count: 3,
              synergy_score: 0.7,
              representative_query: "write then edit content",
            },
          },
          summary: "workflow proposal",
          current_value: "No dedicated workflow skill exists for writer -> editor.",
          proposed_value: "Create writer-editor at /tmp/writer-editor/SKILL.md",
          rationale: "frequent pairing",
          confidence: 0.82,
        },
      ],
      summary: {
        totalSkills: 1,
        evaluated: 1,
        evolved: 1,
        deployed: 1,
        watched: 1,
        skipped: 0,
        autoGraded: 0,
        freshlyWatchedSkills: ["writer"],
        dryRun: false,
        approvalMode: "auto",
        elapsedMs: 100,
      },
    };

    expect(buildOrchestrateJsonOutput(result)).toEqual({
      totalSkills: 1,
      evaluated: 1,
      evolved: 1,
      deployed: 1,
      watched: 1,
      skipped: 0,
      autoGraded: 0,
      freshlyWatchedSkills: ["writer"],
      dryRun: false,
      approvalMode: "auto",
      elapsedMs: 100,
      workflow_proposals: [
        {
          proposal_id: "wf1",
          source_skill_name: "writer",
          workflow_id: "flow-1",
          generated_skill_name: "writer-editor",
          output_path: "/tmp/writer-editor/SKILL.md",
          confidence: 0.82,
          reason: "frequent pairing",
        },
      ],
      decisions: [
        {
          skill: "writer",
          action: "evolve",
          reason: "status=WARNING",
          deployed: true,
          evolveReason: "deployed",
          validation: {
            before: 0.4,
            after: 0.8,
            improved: true,
          },
          alert: null,
          rolledBack: false,
          passRate: 0.8,
          recommendation: "stable",
        },
      ],
    });
  });
});
