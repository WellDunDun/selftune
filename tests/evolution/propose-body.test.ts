import { describe, expect, mock, test } from "bun:test";
import {
  buildBodyGenerationPrompt,
  BODY_GENERATOR_SYSTEM,
  parseBodyProposalResponse,
} from "../../cli/selftune/evolution/propose-body.js";
import { stripMarkdownFences } from "../../cli/selftune/utils/llm-call.js";
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
// BODY_GENERATOR_SYSTEM
// ---------------------------------------------------------------------------

describe("BODY_GENERATOR_SYSTEM", () => {
  test("contains key instructions about body generation and JSON", () => {
    expect(BODY_GENERATOR_SYSTEM.toLowerCase()).toContain("body");
    expect(BODY_GENERATOR_SYSTEM.toLowerCase()).toContain("json");
    expect(BODY_GENERATOR_SYSTEM.toLowerCase()).toContain("skill");
    expect(BODY_GENERATOR_SYSTEM.toLowerCase()).toContain("workflow routing");
  });
});

// ---------------------------------------------------------------------------
// buildBodyGenerationPrompt
// ---------------------------------------------------------------------------

describe("buildBodyGenerationPrompt", () => {
  const currentContent = "# Test\n\nA skill for testing.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |";
  const patterns: FailurePattern[] = [
    makePattern("fp-test-0", "test-skill", ["validate input", "check assertions"], 2),
  ];
  const missedQueries = ["validate input", "check assertions"];
  const skillName = "test-skill";

  test("includes skill name", () => {
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName);
    expect(prompt).toContain("test-skill");
  });

  test("includes current content", () => {
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName);
    expect(prompt).toContain("A skill for testing");
    expect(prompt).toContain("## Workflow Routing");
  });

  test("includes failure patterns", () => {
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName);
    expect(prompt).toContain("fp-test-0");
    expect(prompt).toContain("validate input");
  });

  test("includes missed queries", () => {
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName);
    expect(prompt).toContain("check assertions");
  });

  test("includes few-shot examples when provided", () => {
    const fewShot = ["# Example Skill\n\nThis is an example."];
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName, fewShot);
    expect(prompt).toContain("Reference Examples");
    expect(prompt).toContain("Example Skill");
  });

  test("omits few-shot section when not provided", () => {
    const prompt = buildBodyGenerationPrompt(currentContent, patterns, missedQueries, skillName);
    expect(prompt).not.toContain("Reference Examples");
  });

  test("includes failure feedback when present", () => {
    const patternsWithFeedback: FailurePattern[] = [
      {
        pattern_id: "fp-1",
        skill_name: "test",
        invocation_type: "implicit",
        missed_queries: ["validate input"],
        frequency: 1,
        sample_sessions: [],
        extracted_at: "",
        feedback: [
          {
            query: "validate input",
            failure_reason: "No validation keyword",
            improvement_hint: "Add validation triggers",
          },
        ],
      },
    ];
    const prompt = buildBodyGenerationPrompt(
      currentContent,
      patternsWithFeedback,
      ["validate input"],
      "test",
    );
    expect(prompt).toContain("Structured Failure Analysis");
    expect(prompt).toContain("No validation keyword");
  });
});

// ---------------------------------------------------------------------------
// parseBodyProposalResponse
// ---------------------------------------------------------------------------

describe("parseBodyProposalResponse", () => {
  test("handles valid JSON", () => {
    const raw = JSON.stringify({
      proposed_body: "An improved body with ## Workflow Routing",
      rationale: "Better coverage",
      confidence: 0.85,
    });
    const result = parseBodyProposalResponse(raw);
    expect(result.proposed_body).toContain("improved body");
    expect(result.rationale).toBe("Better coverage");
    expect(result.confidence).toBe(0.85);
  });

  test("handles markdown-fenced JSON", () => {
    const raw =
      '```json\n{"proposed_body":"body","rationale":"reason","confidence":0.7}\n```';
    const result = parseBodyProposalResponse(raw);
    expect(result.proposed_body).toBe("body");
    expect(result.confidence).toBe(0.7);
  });

  test("throws on malformed input", () => {
    expect(() => parseBodyProposalResponse("not valid json")).toThrow();
  });

  test("throws on missing required fields", () => {
    const raw = JSON.stringify({ proposed_body: "only this" });
    expect(() => parseBodyProposalResponse(raw)).toThrow();
  });

  test("clamps confidence above 1.0 to 1.0", () => {
    const raw = JSON.stringify({
      proposed_body: "body",
      rationale: "reason",
      confidence: 1.5,
    });
    const result = parseBodyProposalResponse(raw);
    expect(result.confidence).toBe(1.0);
  });

  test("clamps confidence below 0.0 to 0.0", () => {
    const raw = JSON.stringify({
      proposed_body: "body",
      rationale: "reason",
      confidence: -0.3,
    });
    const result = parseBodyProposalResponse(raw);
    expect(result.confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// generateBodyProposal (mocked LLM)
// ---------------------------------------------------------------------------

describe("generateBodyProposal", () => {
  test("assembles proposal structure correctly with mocked LLM", async () => {
    const mockResponse = JSON.stringify({
      proposed_body: "Improved body with ## Workflow Routing\n\n| Trigger | Workflow |",
      rationale: "Better coverage of validation queries",
      confidence: 0.9,
    });

    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      callLlm: async () => mockResponse,
      stripMarkdownFences,
    }));

    const { generateBodyProposal: mockedGenerate } = await import(
      "../../cli/selftune/evolution/propose-body.js"
    );

    const patterns: FailurePattern[] = [
      makePattern("fp-test-0", "test-skill", ["validate input"], 1),
    ];

    const proposal = await mockedGenerate(
      "# Test\n\nOriginal content",
      patterns,
      ["validate input"],
      "test-skill",
      "/skills/test-skill",
      "claude",
    );

    expect(proposal.proposal_id).toMatch(/^evo-body-test-skill-\d+$/);
    expect(proposal.skill_name).toBe("test-skill");
    expect(proposal.skill_path).toBe("/skills/test-skill");
    expect(proposal.target).toBe("body");
    expect(proposal.proposed_body).toContain("Improved body");
    expect(proposal.confidence).toBe(0.9);
    expect(proposal.status).toBe("pending");
  });
});
