import { describe, expect, mock, test } from "bun:test";

import {
  buildProposalPrompt,
  PROPOSER_SYSTEM,
  parseProposalResponse,
} from "../../cli/selftune/evolution/propose-description.js";
import type { FailurePattern } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makePattern(
  patternId: string,
  skillName: string,
  missedQueries: string[],
  frequency?: number,
): FailurePattern {
  return {
    pattern_id: patternId,
    skill_name: skillName,
    invocation_type: "implicit",
    missed_queries: missedQueries,
    frequency: frequency ?? missedQueries.length,
    sample_sessions: [],
    extracted_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PROPOSER_SYSTEM
// ---------------------------------------------------------------------------

describe("PROPOSER_SYSTEM", () => {
  test("contains key instructions about description and JSON", () => {
    expect(PROPOSER_SYSTEM.toLowerCase()).toContain("description");
    expect(PROPOSER_SYSTEM.toLowerCase()).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// buildProposalPrompt
// ---------------------------------------------------------------------------

describe("buildProposalPrompt", () => {
  const currentDescription = "A skill that builds presentation slides";
  const patterns: FailurePattern[] = [
    makePattern("fp-presenter-0", "presenter", ["make slides", "create slides"], 2),
    makePattern("fp-presenter-1", "presenter", ["generate deck"], 1),
  ];
  const missedQueries = ["make slides", "create slides", "generate deck"];
  const skillName = "presenter";

  test("includes skill name in output", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).toContain("presenter");
  });

  test("includes current description in output", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).toContain("A skill that builds presentation slides");
  });

  test("includes failure pattern info", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).toContain("fp-presenter-0");
    expect(prompt).toContain("make slides");
    expect(prompt).toContain("create slides");
  });

  test("includes missed queries", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).toContain("generate deck");
  });

  test("includes failure feedback section when patterns have feedback", () => {
    const patternsWithFeedback: FailurePattern[] = [
      {
        pattern_id: "fp-1",
        skill_name: "test",
        invocation_type: "implicit",
        missed_queries: ["make slides"],
        frequency: 1,
        sample_sessions: [],
        extracted_at: "",
        feedback: [
          {
            query: "make slides",
            failure_reason: "No slide keywords in description",
            improvement_hint: "Add presentation/slides triggers",
          },
        ],
      },
    ];
    const prompt = buildProposalPrompt(
      "Original desc",
      patternsWithFeedback,
      ["make slides"],
      "test",
    );
    expect(prompt).toContain("Structured Failure Analysis");
    expect(prompt).toContain("No slide keywords in description");
    expect(prompt).toContain("Add presentation/slides triggers");
  });

  test("omits failure feedback section when no patterns have feedback", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).not.toContain("Structured Failure Analysis");
  });

  test("includes aggregate metrics section when provided", () => {
    const metrics = {
      mean_score: 0.72,
      score_std_dev: 0.15,
      failed_session_rate: 0.33,
      mean_errors: 2.5,
      total_graded: 12,
    };
    const prompt = buildProposalPrompt(
      currentDescription,
      patterns,
      missedQueries,
      skillName,
      metrics,
    );
    expect(prompt).toContain("Mean grading score: 0.72/1.0");
    expect(prompt).toContain("σ=0.15");
    expect(prompt).toContain("Failed session rate: 33%");
    expect(prompt).toContain("Mean execution errors per session: 2.5");
    expect(prompt).toContain("Sessions graded: 12");
  });

  test("omits aggregate metrics section when not provided", () => {
    const prompt = buildProposalPrompt(currentDescription, patterns, missedQueries, skillName);
    expect(prompt).not.toContain("Mean grading score");
    expect(prompt).not.toContain("Failed session rate");
  });
});

// ---------------------------------------------------------------------------
// parseProposalResponse
// ---------------------------------------------------------------------------

describe("parseProposalResponse", () => {
  test("handles valid JSON", () => {
    const raw = JSON.stringify({
      proposed_description: "An improved skill description",
      rationale: "Better coverage of slide-related queries",
      confidence: 0.85,
    });
    const result = parseProposalResponse(raw);
    expect(result.proposed_description).toBe("An improved skill description");
    expect(result.rationale).toBe("Better coverage of slide-related queries");
    expect(result.confidence).toBe(0.85);
  });

  test("handles markdown-fenced JSON", () => {
    const raw =
      '```json\n{"proposed_description":"fenced desc","rationale":"reason","confidence":0.7}\n```';
    const result = parseProposalResponse(raw);
    expect(result.proposed_description).toBe("fenced desc");
    expect(result.rationale).toBe("reason");
    expect(result.confidence).toBe(0.7);
  });

  test("throws on malformed input", () => {
    expect(() => parseProposalResponse("not valid json at all")).toThrow();
  });

  test("throws on missing required fields", () => {
    const raw = JSON.stringify({ proposed_description: "only this field" });
    expect(() => parseProposalResponse(raw)).toThrow();
  });

  test("clamps confidence above 1.0 to 1.0", () => {
    const raw = JSON.stringify({
      proposed_description: "desc",
      rationale: "reason",
      confidence: 1.5,
    });
    const result = parseProposalResponse(raw);
    expect(result.confidence).toBe(1.0);
  });

  test("clamps confidence below 0.0 to 0.0", () => {
    const raw = JSON.stringify({
      proposed_description: "desc",
      rationale: "reason",
      confidence: -0.3,
    });
    const result = parseProposalResponse(raw);
    expect(result.confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// generateProposal (mocked LLM)
// ---------------------------------------------------------------------------

describe("generateProposal", () => {
  test("assembles proposal structure correctly with mocked LLM", async () => {
    // Mock callLlm at the module level
    const mockModule = await import("../../cli/selftune/utils/llm-call.js");
    const _originalCallLlm = mockModule.callLlm;

    // We test indirectly: build + parse cover the logic, so we verify structure
    // by calling generateProposal with a mock that returns valid JSON
    const mockResponse = JSON.stringify({
      proposed_description: "Enhanced description for better routing",
      rationale: "Covers more query patterns including slides and decks",
      confidence: 0.9,
    });

    // Use bun's mock.module to mock callLlm
    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      ...mockModule,
      callLlm: async () => mockResponse,
      stripMarkdownFences: mockModule.stripMarkdownFences,
    }));

    // Re-import the module to pick up mocked dependencies
    // Clear module cache and re-import
    const { generateProposal: mockedGenerate } =
      await import("../../cli/selftune/evolution/propose-description.js");

    const patterns: FailurePattern[] = [
      makePattern("fp-test-0", "test-skill", ["query one", "query two"], 2),
    ];

    const proposal = await mockedGenerate(
      "Original description",
      patterns,
      ["query one", "query two"],
      "test-skill",
      "/skills/test-skill",
      "claude",
    );

    // Verify proposal structure
    expect(proposal.proposal_id).toMatch(/^evo-test-skill-\d+$/);
    expect(proposal.skill_name).toBe("test-skill");
    expect(proposal.skill_path).toBe("/skills/test-skill");
    expect(proposal.original_description).toBe("Original description");
    expect(proposal.proposed_description).toBe("Enhanced description for better routing");
    expect(proposal.rationale).toBe("Covers more query patterns including slides and decks");
    expect(proposal.failure_patterns).toEqual(["fp-test-0"]);
    expect(proposal.confidence).toBe(0.9);
    expect(proposal.status).toBe("pending");
    expect(typeof proposal.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(proposal.created_at))).toBe(false);

    // Verify eval_results are zeroed out
    expect(proposal.eval_results.before).toEqual({ total: 0, passed: 0, failed: 0, pass_rate: 0 });
    expect(proposal.eval_results.after).toEqual({ total: 0, passed: 0, failed: 0, pass_rate: 0 });
  });
});
