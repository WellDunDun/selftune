// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillReportResponse, SkillTestingReadiness } from "@/types";
import { SkillReport } from "./SkillReport";

interface ReportFixture extends SkillReportResponse {
  testing_readiness: SkillTestingReadiness;
}
let mockSkillReportData: ReportFixture;
let mockSearchParams = new URLSearchParams();
let client: QueryClient;

function renderReport() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["skill-report", "test-skill"], mockSkillReportData);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/skills/test-skill?${mockSearchParams}`]}>
        <Routes>
          <Route path="/skills/:name" element={<SkillReport />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  client?.clear();
});
beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockSkillReportData = {
    skill_name: "selftune",
    usage: { total_checks: 125, triggered_count: 105, pass_rate: 0.84 },
    recent_invocations: [],
    watch_trust_score: null,
    token_usage: { total_input_tokens: 0, total_output_tokens: 0 },
    duration_stats: {
      avg_duration_ms: 0,
      total_duration_ms: 0,
      execution_count: 0,
      missed_triggers: 6,
    },
    selftune_stats: { total_llm_calls: 0, total_elapsed_ms: 0, avg_elapsed_ms: 0, run_count: 0 },
    prompt_samples: [
      {
        prompt_text: "test query",
        prompt_kind: "meta",
        is_actionable: true,
        occurred_at: "2026-03-31T00:00:00Z",
        session_id: "sess-1",
      },
    ],
    sessions_with_skill: 98,
    evidence: [],
    evolution: [
      {
        proposal_id: "p1",
        action: "validated",
        timestamp: "2026-03-31T00:00:00Z",
        details: "Replay passed",
      },
    ],
    pending_proposals: [],
    canonical_invocations: [
      {
        session_id: "sess-1",
        skill_name: "selftune",
        timestamp: "2026-03-31T00:00:00Z",
        query: "test query",
        triggered: true,
        invocation_mode: "implicit",
        confidence: 0.7,
        tool_name: null,
        agent_type: null,
        observation_kind: "canonical",
      },
    ],
    session_metadata: [
      {
        session_id: "sess-1",
        started_at: "2026-03-31T00:00:00Z",
        model: "claude",
        agent_cli: "codex",
        platform: "codex",
        branch: null,
        workspace_path: "/workspace",
        ended_at: null,
        completion_status: null,
      },
    ],
    trust: {
      state: "validated",
      summary: "Validated with evidence but not yet deployed.",
    },
    coverage: {
      checks: 125,
      sessions: 98,
      workspaces: 14,
      last_seen: "2026-03-31T00:00:00Z",
      first_seen: "2026-03-01T00:00:00Z",
    },
    evidence_quality: {
      prompt_link_rate: 0.84,
      inline_query_rate: 0.16,
      user_prompt_rate: 0.4,
      meta_prompt_rate: 0.4,
      internal_prompt_rate: 0.08,
      no_prompt_rate: 0.2,
      system_like_rate: 0.06,
      invocation_mode_coverage: 0.9,
      confidence_coverage: 0.9,
      source_coverage: 0.4,
      scope_coverage: 0.2,
    },
    routing_quality: {
      missed_triggers: 6,
      miss_rate: 0.05,
      avg_confidence: 0.71,
      confidence_coverage: 0.9,
      low_confidence_rate: 0.1,
    },
    evolution_state: {
      has_evidence: true,
      has_pending_proposals: false,
      latest_action: "validated",
      latest_timestamp: "2026-03-31T00:00:00Z",
      evidence_rows: 81,
      evolution_rows: 82,
    },
    data_hygiene: {
      naming_variants: ["selftune"],
      source_breakdown: [{ source: "claude", count: 10 }],
      prompt_kind_breakdown: [{ kind: "meta", count: 10 }],
      observation_breakdown: [{ kind: "canonical", count: 10 }],
      raw_checks: 125,
      operational_checks: 118,
      internal_prompt_rows: 7,
      internal_prompt_rate: 0.06,
      legacy_rows: 3,
      legacy_rate: 0.02,
      repaired_rows: 6,
      repaired_rate: 0.05,
    },
    examples: {
      good: [
        {
          timestamp: "2026-03-31T00:00:00Z",
          session_id: "sess-1",
          query_text: "good query",
          triggered: true,
          confidence: 0.7,
          invocation_mode: "implicit",
          prompt_kind: "meta",
          source: null,
          platform: "codex",
          workspace_path: "/workspace",
          query_origin: "matched_prompt",
          is_system_like: false,
          observation_kind: "canonical",
        },
      ],
      missed: [
        {
          timestamp: "2026-03-31T01:00:00Z",
          session_id: "sess-2",
          query_text: "missed query",
          triggered: false,
          confidence: 0.42,
          invocation_mode: "implicit",
          prompt_kind: "meta",
          source: "codex",
          platform: "codex",
          workspace_path: "/workspace",
          query_origin: "missing",
          is_system_like: false,
          observation_kind: "repaired_contextual_miss",
        },
      ],
      noisy: [],
    },
    testing_readiness: {
      skill_name: "selftune",
      eval_readiness: "log_ready",
      next_step: "run_replay_dry_run",
      summary:
        "Unit tests are present (12 cases), but replay-backed dry-run validation has not been recorded yet.",
      recommended_command:
        "selftune evolve --skill selftune --skill-path /workspace/selftune/SKILL.md --dry-run --validation-mode replay",
      skill_path: "/workspace/selftune/SKILL.md",
      trusted_trigger_count: 90,
      trusted_session_count: 40,
      eval_set_entries: 32,
      latest_eval_at: "2026-03-30T00:00:00Z",
      unit_test_cases: 12,
      unit_test_pass_rate: 0.92,
      unit_test_ran_at: "2026-03-31T00:00:00Z",
      replay_check_count: 0,
      latest_validation_mode: null,
      baseline_sample_size: 0,
      baseline_pass_rate: null,
      latest_baseline_at: null,
      deployment_readiness: "blocked",
      deployment_summary: "Finish the creator test loop before shipping this skill.",
      deployment_command: null,
      latest_evolution_action: "validated",
      latest_evolution_at: "2026-03-31T00:00:00Z",
    },
  };
});

describe("SkillReport", () => {
  it("renders tabs directly before tab-controlled content", async () => {
    renderReport();
    const tabs = screen.getByRole("tab", { name: "Evidence" });
    const panel = screen.getByRole("tabpanel", { name: "Evidence" });
    expect(tabs.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("does not duplicate the latest decision block", async () => {
    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html.match(/Latest Decision/g)?.length).toBe(1);
  });

  it("renders evidence and data quality panel content in their sections", async () => {
    renderReport();
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("tabpanel", { name: "Evidence" }).textContent).toContain(
      "Prompt Evidence",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Data Quality" }));
    expect(screen.getByRole("tabpanel", { name: "Data Quality" }).textContent).toContain(
      "Evidence Quality Rates",
    );
    expect(screen.getByRole("tabpanel", { name: "Data Quality" }).textContent).toContain(
      "Data Hygiene",
    );
    fireEvent.click(screen.getByRole("tab", { name: /Missed Queries/ }));
    expect(screen.getByRole("tabpanel", { name: /Missed Queries/ }).textContent).toContain(
      "missed query",
    );
  });

  it("shows invoker fallback data from session metadata", async () => {
    renderReport();
    fireEvent.click(screen.getByRole("tab", { name: /Invocations/ }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Invoker");
    expect(screen.getByRole("tabpanel").textContent).toContain("codex");
  });

  it("renders the creator test loop section with the recommended command", async () => {
    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html).toContain("Measured trust loop");
    expect(html).toContain("Replay dry-run");
    expect(html).toContain("Deployment");
    expect(html).toContain("selftune improve --skill selftune");
  });

  it("renders the draft package loop for create-readiness-only skills", async () => {
    mockSkillReportData = {
      ...mockSkillReportData,
      usage: { total_checks: 0, triggered_count: 0, pass_rate: 0 },
      sessions_with_skill: 0,
      evidence: [],
      evolution: [],
      canonical_invocations: [],
      trust: {
        state: "low_sample",
        summary:
          "No runtime observations yet. Use the creator test loop to bootstrap this skill before trusting live routing.",
      },
      coverage: {
        checks: 0,
        sessions: 0,
        workspaces: 0,
        last_seen: null,
        first_seen: null,
      },
      evolution_state: {
        has_evidence: false,
        has_pending_proposals: false,
        latest_action: null,
        latest_timestamp: null,
        evidence_rows: 0,
        evolution_rows: 0,
      },
      testing_readiness: {
        ...mockSkillReportData.testing_readiness,
        skill_name: "draft-writer",
        skill_path: "/workspace/.agents/skills/draft-writer/SKILL.md",
      },
      create_readiness: {
        skill_name: "draft-writer",
        skill_dir: "/workspace/.agents/skills/draft-writer",
        skill_path: "/workspace/.agents/skills/draft-writer/SKILL.md",
        entry_workflow: "workflows/default.md",
        manifest_present: true,
        state: "needs_spec_validation",
        ok: false,
        summary:
          "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
        next_command:
          "selftune create check --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
        description_quality: {
          composite: 0.88,
          criteria: {
            length: 1,
            trigger_context: 1,
            vagueness: 0.8,
            specificity: 0.8,
            not_just_name: 0.8,
          },
        },
        checks: {
          skill_md: true,
          frontmatter_present: true,
          skill_name_matches_dir: true,
          description_present: true,
          description_within_budget: true,
          skill_md_within_line_budget: true,
          manifest_present: true,
          workflow_entry: true,
          references_present: true,
          scripts_present: false,
          assets_present: false,
          evals_present: true,
          unit_tests_present: true,
          routing_replay_ready: true,
          routing_replay_recorded: true,
          package_replay_ready: true,
          baseline_present: true,
        },
      },
    };

    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html).toContain("Draft skill lifecycle");
    expect(html).toContain("Verify draft");
    expect(html).toContain("Publish draft");
    expect(screen.getByRole("button", { name: "Package report" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Run search" })).not.toBeNull();
    expect(html).toContain(
      "selftune verify --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
    );
  });

  it("keeps draft-package blockers visible even after runtime data exists", async () => {
    mockSkillReportData = {
      ...mockSkillReportData,
      usage: { total_checks: 12, triggered_count: 10, pass_rate: 0.8 },
      sessions_with_skill: 6,
      trust: {
        state: "observed",
        summary: "Observed in 6 sessions across 2 workspaces; evidence is moderate.",
      },
      coverage: {
        checks: 12,
        sessions: 6,
        workspaces: 2,
        last_seen: "2026-03-31T00:00:00Z",
        first_seen: "2026-03-01T00:00:00Z",
      },
      evolution_state: {
        has_evidence: false,
        has_pending_proposals: false,
        latest_action: null,
        latest_timestamp: null,
        evidence_rows: 0,
        evolution_rows: 0,
      },
      testing_readiness: {
        ...mockSkillReportData.testing_readiness,
        skill_name: "draft-writer",
        skill_path: "/workspace/.agents/skills/draft-writer/SKILL.md",
        next_step: "deploy_candidate",
        summary:
          "Evals, unit tests, package replay, and a package baseline are all present. Ready to run create publish and hand the draft into watch.",
        recommended_command:
          "selftune create publish --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
      },
      create_readiness: {
        skill_name: "draft-writer",
        skill_dir: "/workspace/.agents/skills/draft-writer",
        skill_path: "/workspace/.agents/skills/draft-writer/SKILL.md",
        entry_workflow: "workflows/default.md",
        manifest_present: true,
        state: "needs_spec_validation",
        ok: false,
        summary:
          "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
        next_command:
          "selftune create check --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
        description_quality: {
          composite: 0.88,
          criteria: {
            length: 1,
            trigger_context: 1,
            vagueness: 0.8,
            specificity: 0.8,
            not_just_name: 0.8,
          },
        },
        checks: {
          skill_md: true,
          frontmatter_present: true,
          skill_name_matches_dir: true,
          description_present: true,
          description_within_budget: true,
          skill_md_within_line_budget: true,
          manifest_present: true,
          workflow_entry: true,
          references_present: true,
          scripts_present: false,
          assets_present: false,
          evals_present: true,
          unit_tests_present: true,
          routing_replay_ready: true,
          routing_replay_recorded: true,
          package_replay_ready: true,
          baseline_present: true,
        },
      },
    };

    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html).toContain("Draft skill lifecycle");
    expect(html).toContain("Verify draft");
    expect(html).toContain(
      "selftune verify --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
    );
    expect(html).not.toContain(
      "selftune publish --skill-path /workspace/.agents/skills/draft-writer/SKILL.md",
    );
  });

  it("marks draft-package eval generation as auto-synthetic", async () => {
    const { getDraftPackageActions } = await import("./SkillReport");
    const generateEvals = getDraftPackageActions().find(
      (action) => action.action === "generate-evals",
    );

    expect(generateEvals?.autoSynthetic).toBe(true);
  });

  it("renders the latest bounded-search surface budget in the frontier panel", async () => {
    mockSkillReportData = {
      ...mockSkillReportData,
      frontier_state: {
        skill_name: "selftune",
        accepted_count: 1,
        rejected_count: 0,
        pending_count: 0,
        members: [
          {
            candidate_id: "pkgcand_selftune_1234567890ab",
            skill_name: "selftune",
            fingerprint: "pkg_sha256_abc123",
            decision: "accepted",
            measured_delta: 0.12,
            created_at: "2026-04-15T00:00:00Z",
            parent_candidate_id: null,
            watch_demoted: false,
            evidence_rank: 1,
          },
        ],
        latest_search_run: {
          search_id: "sr_123",
          skill_name: "selftune",
          parent_candidate_id: null,
          candidates_evaluated: 5,
          winner_candidate_id: "pkgcand_selftune_1234567890ab",
          winner_rationale: "Routing was the weakest measured surface.",
          started_at: "2026-04-15T00:00:00Z",
          completed_at: "2026-04-15T00:01:00Z",
          provenance: {
            frontier_size: 1,
            parent_selection_method: "highest_ranked_frontier",
            candidate_fingerprints: ["pkg_sha256_abc123"],
            surface_plan: {
              routing_count: 4,
              body_count: 1,
              weakness_source: "accepted_frontier",
              routing_weakness: 0.9,
              body_weakness: 0.1,
            },
            evaluation_summaries: [],
          },
        },
      },
    };

    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html).toContain("Package frontier");
    expect(html).toContain("Budget:");
    expect(html).toContain("R4/B1");
  });

  it("keeps proposal deep links focused without restoring the old proposal-first layout", async () => {
    mockSearchParams = new URLSearchParams("proposal=p1");
    const { container } = renderReport();
    const html = container.innerHTML;

    expect(html).not.toContain("New to selftune?");
    expect(html).not.toContain("Measured trust loop");
    expect(html).toContain("Ship candidate");
    expect(html.indexOf("Trust Signals")).toBeLessThan(html.indexOf("Evidence"));
  });
});
