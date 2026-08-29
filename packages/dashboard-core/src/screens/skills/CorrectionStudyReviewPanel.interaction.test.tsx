// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { CorrectionStudyReviewModel } from "../../models";
import { CorrectionStudyReviewPanel } from "./CorrectionStudyReviewPanel";

afterEach(cleanup);

const review: CorrectionStudyReviewModel = {
  candidateId: "candidate-review",
  evidenceLevel: "E2",
  observedFailure: "The agent claimed an upload before portal confirmation.",
  correctionIntent: "Require a successful portal status.",
  proposedChange: {
    diff: "--- current\n-Claim success when selected.\n+++ proposed\n+Wait for portal success.",
  },
  evaluation: {
    summary: "selected: selected",
    regressions: ["prior-regression"],
  },
  limitations: ["Review-only; no skill is applied."],
  manifestDigest: `sha256:${"a".repeat(64)}`,
  provenance: ["Verifier portal-check@v1"],
  actions: {
    accept: { available: true },
    edit: { available: false, reason: "A replacement requires re-evaluation." },
    reject: { available: true },
    defer: { available: true },
  },
};

test("loads auditable evidence and records a reason-bound non-applying decision", async () => {
  const list = vi.fn().mockResolvedValue([review]);
  const recordDecision = vi.fn().mockResolvedValue({ recorded: true, appliesSkill: false });
  render(
    <CorrectionStudyReviewPanel contribution={{ access: "available", list, recordDecision }} />,
  );

  expect(await screen.findByText(review.observedFailure)).not.toBeNull();
  expect(screen.getByText("E2")).not.toBeNull();
  expect(screen.getByText(/Wait for portal success/)).not.toBeNull();
  expect(screen.getByText(/prior-regression/)).not.toBeNull();
  expect(screen.getByText(/Verifier portal-check@v1/)).not.toBeNull();

  const accept = screen.getByRole("button", { name: "accept" });
  expect(accept.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Reason for candidate-review"), {
    target: { value: "The frozen evidence is sufficient." },
  });
  expect(accept.hasAttribute("disabled")).toBe(false);
  fireEvent.click(accept);

  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith({
      candidateId: "candidate-review",
      action: "accept",
      reason: "The frozen evidence is sufficient.",
      manifestDigest: review.manifestDigest,
    }),
  );
  expect(list).toHaveBeenCalledTimes(2);
});

test("surfaces decision failures without removing the review", async () => {
  const recordDecision = vi.fn().mockRejectedValue(new Error("durable conflict"));
  render(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: vi.fn().mockResolvedValue([review]),
        recordDecision,
      }}
    />,
  );
  await screen.findByText(review.observedFailure);
  fireEvent.change(screen.getByLabelText("Reason for candidate-review"), {
    target: { value: "Reject this candidate." },
  });
  fireEvent.click(screen.getByRole("button", { name: "reject" }));
  expect(await screen.findByText("The decision could not be recorded.")).not.toBeNull();
  expect(screen.getByText(review.observedFailure)).not.toBeNull();
});

test("keeps hypothesis-level studies out of the decision queue", async () => {
  const hypotheses: CorrectionStudyReviewModel[] = [
    {
      ...review,
      candidateId: "e0-no-evidence",
      evidenceLevel: "E0",
      observedFailure: "Legacy correction without attribution.",
      evaluation: null,
    },
    {
      ...review,
      candidateId: "e05-intent-only",
      evidenceLevel: "E0.5",
      observedFailure: "Correction intent recorded, never replayed.",
      evaluation: null,
    },
    {
      ...review,
      candidateId: "e2-level-without-result",
      evidenceLevel: "E2",
      observedFailure: "Claims a benchmark it cannot show.",
      evaluation: null,
    },
  ];
  const { container } = render(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: vi.fn().mockResolvedValue(hypotheses),
        recordDecision: vi.fn(),
      }}
    />,
  );

  await waitFor(() => expect(container.innerHTML).toBe(""));
  for (const item of hypotheses) {
    expect(screen.queryByText(item.observedFailure)).toBeNull();
  }
});

test("still renders decidable studies alongside excluded hypotheses", async () => {
  const excluded: CorrectionStudyReviewModel = {
    ...review,
    candidateId: "e0-excluded",
    evidenceLevel: "E0",
    observedFailure: "Legacy correction without attribution.",
    evaluation: null,
  };
  render(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: vi.fn().mockResolvedValue([excluded, review]),
        recordDecision: vi.fn(),
      }}
    />,
  );

  expect(await screen.findByText(review.observedFailure)).not.toBeNull();
  expect(screen.queryByText(excluded.observedFailure)).toBeNull();
});

test("shows a list failure without also claiming there are no reviews", async () => {
  render(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: vi.fn().mockRejectedValue(new Error("request failed")),
        recordDecision: vi.fn(),
      }}
    />,
  );

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Correction reviews could not be loaded.",
  );
  expect(screen.queryByText("No correction studies need review.")).toBeNull();
});
