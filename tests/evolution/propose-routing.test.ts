import { describe, expect, mock, test } from "bun:test";
import {
  buildRoutingProposalPrompt,
  parseRoutingProposalResponse,
  ROUTING_PROPOSER_SYSTEM,
} from "../../cli/selftune/evolution/propose-routing.js";
import type { FailurePattern } from "../../cli/selftune/types.js";
import { stripMarkdownFences } from "../../cli/selftune/utils/llm-call.js";

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
// ROUTING_PROPOSER_SYSTEM
// ---------------------------------------------------------------------------

describe("ROUTING_PROPOSER_SYSTEM", () => {
  test("contains key instructions about routing and JSON", () => {
    expect(ROUTING_PROPOSER_SYSTEM.toLowerCase()).toContain("routing");
    expect(ROUTING_PROPOSER_SYSTEM.toLowerCase()).toContain("json");
    expect(ROUTING_PROPOSER_SYSTEM.toLowerCase()).toContain("trigger");
    expect(ROUTING_PROPOSER_SYSTEM.toLowerCase()).toContain("workflow");
  });
});

// ---------------------------------------------------------------------------
// buildRoutingProposalPrompt
// ---------------------------------------------------------------------------

describe("buildRoutingProposalPrompt", () => {
  const currentRouting = "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |";
  const fullContent = `# Presenter\n\nA skill for slides.\n\n## Workflow Routing\n\n${currentRouting}`;
  const patterns: FailurePattern[] = [
    makePattern("fp-presenter-0", "presenter", ["create deck", "build pptx"], 2),
  ];
  const missedQueries = ["create deck", "build pptx"];
  const skillName = "presenter";

  test("includes skill name in output", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).toContain("presenter");
  });

  test("includes current routing in output", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).toContain("make slides");
    expect(prompt).toContain("| Trigger | Workflow |");
  });

  test("includes full skill content", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).toContain("# Presenter");
    expect(prompt).toContain("A skill for slides");
  });

  test("includes failure pattern info", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).toContain("fp-presenter-0");
    expect(prompt).toContain("create deck");
    expect(prompt).toContain("build pptx");
  });

  test("includes missed queries", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).toContain("create deck");
  });

  test("includes failure feedback when present", () => {
    const patternsWithFeedback: FailurePattern[] = [
      {
        pattern_id: "fp-1",
        skill_name: "test",
        invocation_type: "implicit",
        missed_queries: ["create deck"],
        frequency: 1,
        sample_sessions: [],
        extracted_at: "",
        feedback: [
          {
            query: "create deck",
            failure_reason: "No deck keyword in routing",
            improvement_hint: "Add deck/pptx triggers",
          },
        ],
      },
    ];
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patternsWithFeedback,
      ["create deck"],
      "test",
    );
    expect(prompt).toContain("Structured Failure Analysis");
    expect(prompt).toContain("No deck keyword in routing");
  });

  test("omits failure feedback when not present", () => {
    const prompt = buildRoutingProposalPrompt(
      currentRouting,
      fullContent,
      patterns,
      missedQueries,
      skillName,
    );
    expect(prompt).not.toContain("Structured Failure Analysis");
  });
});

// ---------------------------------------------------------------------------
// parseRoutingProposalResponse
// ---------------------------------------------------------------------------

describe("parseRoutingProposalResponse", () => {
  test("handles valid JSON", () => {
    const raw = JSON.stringify({
      proposed_routing: "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
      rationale: "Added more triggers",
      confidence: 0.85,
    });
    const result = parseRoutingProposalResponse(raw);
    expect(result.proposed_routing).toContain("| Trigger | Workflow |");
    expect(result.rationale).toBe("Added more triggers");
    expect(result.confidence).toBe(0.85);
  });

  test("handles markdown-fenced JSON", () => {
    const raw = '```json\n{"proposed_routing":"table","rationale":"reason","confidence":0.7}\n```';
    const result = parseRoutingProposalResponse(raw);
    expect(result.proposed_routing).toBe("table");
    expect(result.confidence).toBe(0.7);
  });

  test("throws on malformed input", () => {
    expect(() => parseRoutingProposalResponse("not valid json")).toThrow();
  });

  test("throws on missing required fields", () => {
    const raw = JSON.stringify({ proposed_routing: "only this" });
    expect(() => parseRoutingProposalResponse(raw)).toThrow();
  });

  test("clamps confidence above 1.0 to 1.0", () => {
    const raw = JSON.stringify({
      proposed_routing: "table",
      rationale: "reason",
      confidence: 1.5,
    });
    const result = parseRoutingProposalResponse(raw);
    expect(result.confidence).toBe(1.0);
  });

  test("clamps confidence below 0.0 to 0.0", () => {
    const raw = JSON.stringify({
      proposed_routing: "table",
      rationale: "reason",
      confidence: -0.3,
    });
    const result = parseRoutingProposalResponse(raw);
    expect(result.confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// generateRoutingProposal (mocked LLM)
// ---------------------------------------------------------------------------

describe("generateRoutingProposal", () => {
  test("assembles proposal structure correctly with mocked LLM", async () => {
    const mockResponse = JSON.stringify({
      proposed_routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck | presentation |",
      rationale: "Added deck trigger",
      confidence: 0.9,
    });

    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      callLlm: async () => mockResponse,
      stripMarkdownFences,
    }));

    const { generateRoutingProposal: mockedGenerate } = await import(
      "../../cli/selftune/evolution/propose-routing.js"
    );

    const patterns: FailurePattern[] = [makePattern("fp-test-0", "test-skill", ["create deck"], 1)];

    const proposal = await mockedGenerate(
      "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
      "# Test\n\nFull content",
      patterns,
      ["create deck"],
      "test-skill",
      "/skills/test-skill",
      "claude",
    );

    expect(proposal.proposal_id).toMatch(/^evo-routing-test-skill-\d+$/);
    expect(proposal.skill_name).toBe("test-skill");
    expect(proposal.skill_path).toBe("/skills/test-skill");
    expect(proposal.target).toBe("routing");
    expect(proposal.proposed_body).toContain("create deck");
    expect(proposal.confidence).toBe(0.9);
    expect(proposal.status).toBe("pending");
  });

  test("throws when LLM returns malformed JSON", async () => {
    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      callLlm: async () => "not valid json at all",
      stripMarkdownFences,
    }));

    const { generateRoutingProposal: mockedGenerate } = await import(
      "../../cli/selftune/evolution/propose-routing.js"
    );

    const patterns: FailurePattern[] = [makePattern("fp-test-0", "test-skill", ["create deck"], 1)];

    await expect(
      mockedGenerate(
        "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
        "# Test\n\nFull content",
        patterns,
        ["create deck"],
        "test-skill",
        "/skills/test-skill",
        "claude",
      ),
    ).rejects.toThrow();
  });

  test("throws when LLM throws an error", async () => {
    mock.module("../../cli/selftune/utils/llm-call.js", () => ({
      callLlm: async () => {
        throw new Error("LLM unavailable");
      },
      stripMarkdownFences,
    }));

    const { generateRoutingProposal: mockedGenerate } = await import(
      "../../cli/selftune/evolution/propose-routing.js"
    );

    const patterns: FailurePattern[] = [makePattern("fp-test-0", "test-skill", ["create deck"], 1)];

    await expect(
      mockedGenerate(
        "| Trigger | Workflow |",
        "# Test",
        patterns,
        ["create deck"],
        "test-skill",
        "/skills/test-skill",
        "claude",
      ),
    ).rejects.toThrow("LLM unavailable");
  });
});
