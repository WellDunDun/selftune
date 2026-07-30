import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { DashboardProjectsIntelligenceQueryState } from "../../host";
import type { ProjectSkillSetIntelligenceModel } from "../../models";
import { SkillSetIntelligencePanels } from "./SkillSetIntelligencePanels";

const intelligence: ProjectSkillSetIntelligenceModel = {
  validation: { ready: false, discoverySessions: 0, heldOutSessions: 0 },
  calibration: {
    status: "insufficient_evidence",
    minimumLabeledReviews: 20,
    labeledReviews: 0,
    appliedMinEvidenceScore: 0.7,
  },
  suggestions: [],
  catalogExpansions: [],
  outcomes: [],
  traceSignals: [
    {
      skillName: "diagnose",
      invocationCount: 3,
      traceCount: 3,
      errorTraceCount: 2,
      durationMs: 1_250,
      inputTokens: 320,
      outputTokens: 140,
      errorCount: 2,
      toolCallCount: 5,
    },
  ],
  executionPatterns: [
    {
      id: "execution-pattern-diagnose",
      kind: "repeated_correlated_errors",
      skillId: "different-internal-id",
      skillName: "Diagnose",
      traceCount: 3,
      matchingTraceCount: 2,
      ratio: 0.667,
      evidenceState: "supported",
      causalClaim: false,
      reason: "Errors correlated with 2 of 3 traced diagnose executions.",
    },
  ],
};

const query: DashboardProjectsIntelligenceQueryState = {
  access: "available",
  data: intelligence,
  isLoading: false,
  error: null,
  refresh() {},
};

describe("Trace signals panel", () => {
  it("presents automatic trace metrics and an explicitly non-causal pattern", () => {
    const html = renderToStaticMarkup(
      <SkillSetIntelligencePanels
        intelligence={query}
        reviewAction={{ access: "available", execute: async () => undefined }}
        prepareCandidate={{
          access: "available",
          isPending: false,
          execute: async () => ({
            draftId: "draft-1",
            patternId: "execution-pattern-diagnose",
            cohortFingerprint: "cohort",
            targetRevision: "revision",
            readiness: "review_ready",
            failureReason: null,
            evidence: { cohortEntries: 3, resolvedEntries: 3 },
            candidate: {
              body: "Keep diagnosis scoped.",
              rationale: "Addresses the observed failure pattern.",
              changedLines: 1,
              targetSection: "Workflow",
              uncertainty: [],
            },
          }),
        }}
        view="trace-signals"
        onReview={() => undefined}
        onReviewExpansion={() => undefined}
      />,
    );

    expect(html).toContain("Trace signals");
    expect(html).toContain("diagnose");
    expect(html).toContain("2 of 3 traced executions reported errors");
    expect(html).toContain("3 invocations · 5 tool calls · 2 errors · 1,250 ms");
    expect(html).toContain("320 input tokens · 140 output tokens");
    expect(html).toContain("Supported correlation");
    expect(html).toContain("Prepare candidate");
    expect(html).toContain("Correlation only — this does not show that the skill caused errors.");
  });
});
