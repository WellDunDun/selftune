import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidenceViewer } from "./EvidenceViewer";
import type { EvidenceEntry } from "../types";

function evidence(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    proposal_id: "proposal",
    target: "description",
    stage: "validated",
    timestamp: "2026-09-05T00:00:00Z",
    rationale: null,
    confidence: null,
    original_text: null,
    proposed_text: null,
    validation: null,
    details: null,
    eval_set: [],
    ...overrides,
  };
}

describe("EvidenceViewer", () => {
  it("renders typed historical cases, false outcomes, rates, and gate reasons", () => {
    const html = renderToStaticMarkup(
      <EvidenceViewer
        proposalId="proposal"
        evolution={[]}
        evidence={[
          evidence({
            validation: {
              improved: true,
              before_pass_rate: 0.5,
              after_pass_rate: 0.75,
              net_change: 0.25,
              regressions: [{ query: "historical regression" }],
              per_entry_results: [
                {
                  entry: { query: "nested query", should_trigger: true },
                  before_pass: false,
                  after_pass: true,
                },
                { prompt: "flat query", result: false },
                { input: "unmeasured query" },
              ],
              gates_passed: 1,
              gates_total: 2,
              gate_results: [
                { gate: "quality", passed: false, reason: "Output missed the requirement" },
              ],
              validation_evidence_ref: "evidence:proposal",
            },
          }),
        ]}
      />,
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("historical regression");
    expect(text).toContain("nested query");
    expect(text).toContain("flat query");
    expect(text).toContain("unmeasured query");
    expect(text).toContain("1/3 passed");
    expect(text).toContain("50.0%");
    expect(text).toContain("75.0%");
    expect(text).toContain("quality: failed — Output missed the requirement");
    expect(text).toContain("evidence:proposal");
  });

  it("shows a stored-data warning while retaining the evidence card", () => {
    const html = renderToStaticMarkup(
      <EvidenceViewer
        proposalId="proposal"
        evolution={[]}
        evidence={[
          evidence({
            evidence_error: "The original evidence is still stored locally.",
            original_text: "Original skill content",
          }),
        ]}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The original evidence is still stored locally.");
    expect(html).toContain("Original skill content");
  });
});
