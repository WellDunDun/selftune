// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DashboardProjectsIntelligenceQueryState } from "../../host";
import type { ProjectSkillSetIntelligenceModel } from "../../models";
import { SkillSetIntelligencePanels } from "./SkillSetIntelligencePanels";

afterEach(cleanup);

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
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      errorCount: 2,
      toolCallCount: 1,
    },
  ],
  executionPatterns: [
    {
      id: "execution-pattern-diagnose",
      kind: "repeated_correlated_errors",
      skillId: "diagnose",
      skillName: "diagnose",
      traceCount: 3,
      matchingTraceCount: 2,
      ratio: 0.6,
      evidenceState: "supported",
      causalClaim: false,
      reason: "Correlation.",
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

describe("local trace candidate review", () => {
  it("prepares a local review without offering a hosted submission", async () => {
    render(
      <SkillSetIntelligencePanels
        intelligence={query}
        reviewAction={{ access: "available", execute: async () => undefined }}
        view="trace-signals"
        onReview={() => undefined}
        onReviewExpansion={() => undefined}
        prepareCandidate={{
          access: "available",
          isPending: false,
          execute: async () => ({
            draftId: "draft-1",
            patternId: "execution-pattern-diagnose",
            cohortFingerprint: "sha256:abc",
            targetRevision: "rev",
            readiness: "review_ready",
            failureReason: null,
            evidence: { cohortEntries: 3, resolvedEntries: 3 },
            candidate: {
              body: "Body",
              rationale: "Why",
              changedLines: 1,
              targetSection: "Workflow",
              uncertainty: [],
            },
          }),
        }}
      />,
    );
    fireEvent.click(screen.getByText("Prepare candidate"));
    await waitFor(() => expect(screen.getByText("Body")).toBeTruthy());
    expect(screen.getByText("Target revision: rev")).toBeTruthy();
    expect(screen.getByText("Evidence: 3/3 resolved")).toBeTruthy();
    expect(
      screen.getByText("This candidate and its evaluation evidence stay on this device."),
    ).toBeTruthy();
    expect(screen.queryByText("Load Cloud targets")).toBeNull();
    expect(screen.queryByText("Review scheduled Cloud evaluation")).toBeNull();
  });

  it("keeps local preparation failures visible", async () => {
    render(
      <SkillSetIntelligencePanels
        intelligence={query}
        reviewAction={{ access: "available", execute: async () => undefined }}
        view="trace-signals"
        onReview={() => undefined}
        onReviewExpansion={() => undefined}
        prepareCandidate={{
          access: "available",
          isPending: false,
          execute: async () => {
            throw new Error("The local skill revision changed.");
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText("Prepare candidate"));
    await waitFor(() => expect(screen.getByText("The local skill revision changed.")).toBeTruthy());
    expect(screen.queryByText("Load Cloud targets")).toBeNull();
  });
});
