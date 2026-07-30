// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("trace candidate Cloud evaluation", () => {
  it("requires an explicit eligible target and renders its maintained receipt link", async () => {
    let resolveSubmission!: (receipt: { runId: string }) => void;
    const submit = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
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
        loadTargets={{
          access: "available",
          isPending: false,
          execute: async () => ({
            runId: null,
            blockers: [],
            targets: [
              {
                sourceId: "source",
                snapshotId: "snapshot",
                skillId: "skill",
                suiteId: "suite",
                suiteName: "Reliable outcome suite",
                manifestDigest: "sha256:digest",
              },
            ],
          }),
        }}
        submitTarget={{ access: "available", isPending: false, execute: submit }}
      />,
    );
    fireEvent.click(screen.getByText("Prepare candidate"));
    await waitFor(() => expect(screen.getByText("Load Cloud targets")).toBeTruthy());
    fireEvent.click(screen.getByText("Load Cloud targets"));
    await waitFor(() => expect(screen.getByText("Reliable outcome suite")).toBeTruthy());
    fireEvent.click(screen.getByText("Evaluate"));
    fireEvent.click(screen.getByText("Evaluate"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    resolveSubmission({ runId: "run_123" });
    await waitFor(() => expect(screen.getByText("Review scheduled Cloud evaluation")).toBeTruthy());
    expect(screen.getByText("Review scheduled Cloud evaluation").getAttribute("href")).toBe(
      "https://app.selftune.dev/improve/run_123",
    );
  });

  it("shows unavailable target states without enabling an implicit submission", async () => {
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
            draftId: "draft-stale",
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
        loadTargets={{
          access: "available",
          isPending: false,
          execute: async () => {
            throw new Error("Cloud is not linked; this candidate is stale.");
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText("Prepare candidate"));
    await waitFor(() => expect(screen.getByText("Load Cloud targets")).toBeTruthy());
    fireEvent.click(screen.getByText("Load Cloud targets"));
    await waitFor(() =>
      expect(screen.getByText("Cloud is not linked; this candidate is stale.")).toBeTruthy(),
    );
    expect(screen.queryByText("Evaluate")).toBeNull();
  });
});
