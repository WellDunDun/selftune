import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { DashboardActionResultSummary } from "@/types";
import { ingestDashboardActionEvent } from "@/lib/live-action-feed";
import { LiveRun } from "./LiveRun";

const selectedSummary: DashboardActionResultSummary = {
  reason: "Package evaluation passed",
  improved: true,
  deployed: true,
  before_pass_rate: 0.45,
  after_pass_rate: 0.85,
  net_change: 0.4,
  validation_mode: "host_replay",
  package_evaluation_source: "candidate_cache",
  package_candidate_id: "pkgcand_Taxes_eval123456",
  package_parent_candidate_id: "pkgcand_Taxes_root123456",
  package_candidate_generation: 2,
  package_candidate_acceptance_decision: "accepted",
  package_candidate_acceptance_rationale:
    "Measured improvement vs parent: replay +10.0%, baseline lift +0.120.",
  recommended_command: "selftune create publish --skill-path /tmp/Taxes/SKILL.md --watch",
  package_evidence: {
    replay_failures: 1,
    baseline_wins: 2,
    baseline_regressions: 0,
    replay_failure_samples: [
      {
        query: "draft my taxes",
        evidence: "selected competing skill",
      },
    ],
    baseline_win_samples: [
      {
        query: "file my taxes",
        evidence: "with-skill replay passed",
      },
    ],
    baseline_regression_samples: [],
  },
  package_efficiency: {
    with_skill: {
      eval_runs: 6,
      usage_observations: 6,
      total_duration_ms: 24000,
      avg_duration_ms: 4000,
      total_input_tokens: 1200,
      total_output_tokens: 300,
      total_cache_creation_input_tokens: 100,
      total_cache_read_input_tokens: 500,
      total_cost_usd: 0.42,
      total_turns: 12,
    },
    without_skill: {
      eval_runs: 6,
      usage_observations: 6,
      total_duration_ms: 31000,
      avg_duration_ms: 5166.7,
      total_input_tokens: 1500,
      total_output_tokens: 280,
      total_cache_creation_input_tokens: 120,
      total_cache_read_input_tokens: 450,
      total_cost_usd: 0.51,
      total_turns: 15,
    },
  },
  package_routing: {
    mode: "routing",
    validation_mode: "host_replay",
    agent: "claude",
    proposal_id: "create-routing-1",
    fixture_id: "fixture-routing",
    total: 6,
    passed: 5,
    failed: 1,
    pass_rate: 5 / 6,
  },
  package_body: {
    structural_valid: true,
    structural_reason: "Structural validation passed",
    quality_score: 0.82,
    quality_reason: "The body is clear and preserves the routing section.",
    quality_threshold: 0.6,
    quality_passed: true,
    valid: true,
  },
  package_grading: {
    baseline: {
      proposal_id: "deploy-42",
      measured_at: "2026-04-14T12:00:00.000Z",
      pass_rate: 0.82,
      mean_score: 0.74,
      sample_size: 6,
    },
    recent: {
      sample_size: 2,
      average_pass_rate: 0.75,
      average_mean_score: 0.64,
      newest_graded_at: "2026-04-14T12:10:00.000Z",
      oldest_graded_at: "2026-04-14T12:05:00.000Z",
    },
    pass_rate_delta: -0.07,
    mean_score_delta: -0.1,
    regressed: true,
  },
  package_unit_tests: {
    total: 3,
    passed: 2,
    failed: 1,
    pass_rate: 2 / 3,
    run_at: "2026-04-14T12:15:00.000Z",
    failing_tests: [
      {
        test_id: "guardrail-regression",
        error: "Assistant leaked the secret",
        failed_assertions: ["contains: Do not send the raw API key"],
      },
    ],
  },
  package_watch: {
    snapshot: {
      timestamp: "2026-04-14T12:30:00.000Z",
      skill_name: "Taxes",
      window_sessions: 20,
      skill_checks: 6,
      pass_rate: 0.88,
      false_negative_rate: 0.12,
      by_invocation_type: {
        explicit: { passed: 2, total: 2 },
        implicit: { passed: 2, total: 3 },
        contextual: { passed: 1, total: 1 },
        negative: { passed: 0, total: 0 },
      },
      regression_detected: false,
      baseline_pass_rate: 0.8,
    },
    alert: null,
    rolled_back: false,
    recommendation:
      'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
    recommended_command: null,
    grade_alert: null,
    grade_regression: null,
  },
  search_run: null,
};

function renderRun(eventId: string, summary: DashboardActionResultSummary) {
  const event = {
    event_id: eventId,
    action: "deploy-candidate",
    skill_name: "Taxes",
    skill_path: "/tmp/Taxes/SKILL.md",
    ts: Date.now(),
  } as const;
  ingestDashboardActionEvent({ ...event, stage: "started" });
  ingestDashboardActionEvent({ ...event, stage: "finished", success: true, summary });
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/live-run?event=${eventId}`]}>
          <LiveRun />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

describe("LiveRun", () => {
  it("renders measured package evidence, efficiency, watch signal, and next-command guidance", () => {
    const html = renderRun("event-evidence", selectedSummary);

    expect(html).toContain("Measured package evidence");
    expect(html).toContain("Evaluation source");
    expect(html).toContain("Accepted candidate cache");
    expect(html).toContain("Candidate");
    expect(html).toContain("pkgcand_Taxes_eval123456");
    expect(html).toContain("Parent / generation");
    expect(html).toContain("pkgcand_Taxes_root123456 / 2");
    expect(html).toContain("Candidate acceptance");
    expect(html).toContain("accepted");
    expect(html).toContain("Measured improvement vs parent");
    expect(html).toContain("draft my taxes");
    expect(html).toContain("selected competing skill");
    expect(html).toContain("Measured efficiency");
    expect(html).toContain("With skill");
    expect(html).toContain("Without skill");
    expect(html).toContain("Routing validation");
    expect(html).toContain("fixture-routing");
    expect(html).toContain("Body validation");
    expect(html).toContain("The body is clear and preserves the routing section.");
    expect(html).toContain("Measured grading context");
    expect(html).toContain("Baseline grade");
    expect(html).toContain("Recent average");
    expect(html).toContain("Recent grading is below baseline");
    expect(html).toContain("Deterministic unit tests");
    expect(html).toContain("guardrail-regression");
    expect(html).toContain("Assistant leaked the secret");
    expect(html).toContain("Measured watch signal");
    expect(html).toContain("Skill checks");
    expect(html).toContain("Invocation signal");
    expect(html).toContain("Recommended next command");
    expect(html).toContain("selftune publish --skill-path /tmp/Taxes/SKILL.md");
  });

  it("renders bounded search surface budgeting from the selected event", () => {
    const html = renderRun("event-search", {
      ...selectedSummary,
      search_run: {
        search_id: "sr_123",
        parent_candidate_id: "pkgcand_parent123456",
        winner_candidate_id: "pkgcand_winner123456",
        winner_rationale: "Routing weakness dominated the measured gap.",
        candidates_evaluated: 5,
        frontier_size: 2,
        parent_selection_method: "highest_ranked_frontier",
        surface_plan: {
          routing_count: 4,
          body_count: 1,
          weakness_source: "accepted_frontier",
          routing_weakness: 0.9,
          body_weakness: 0.1,
        },
      },
    });

    expect(html).toContain("Surface budget");
    expect(html).toContain("Routing 4, body 1");
    expect(html).toContain("accepted_frontier");
  });
});
