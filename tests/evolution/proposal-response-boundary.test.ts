import { describe, expect, test } from "bun:test";
import { parseBodyProposalResponse } from "../../packages/runtime/evolution/propose-body.js";
import { parseRoutingProposalResponse } from "../../packages/runtime/evolution/propose-routing.js";
import { parseProposalResponse } from "../../packages/runtime/evolution/propose-description.js";
import { parseRefinementResponse } from "../../packages/runtime/evolution/refine-body.js";

for (const subject of [
  {
    name: "body",
    parse: parseBodyProposalResponse,
    content: "proposed_body",
    rationale: "rationale",
  },
  {
    name: "routing",
    parse: parseRoutingProposalResponse,
    content: "proposed_routing",
    rationale: "rationale",
  },
  {
    name: "description",
    parse: parseProposalResponse,
    content: "proposed_description",
    rationale: "rationale",
  },
  {
    name: "refinement",
    parse: parseRefinementResponse,
    content: "refined_body",
    rationale: "changes_made",
  },
]) {
  describe(`${subject.name} response boundary`, () => {
    const valid = {
      [subject.content]: "  Preserve this text.  ",
      [subject.rationale]: "Why",
      confidence: 0.8,
    };

    test.each([
      { confidence: -0.3, expected: 0 },
      { confidence: 0, expected: 0 },
      { confidence: 0.7, expected: 0.7 },
      { confidence: 1, expected: 1 },
      { confidence: 1.5, expected: 1 },
    ])("retains numeric confidence clamping: $confidence", ({ confidence, expected }) => {
      const result = subject.parse(JSON.stringify({ ...valid, confidence }));
      expect(result.confidence).toBe(expected);
      expect(Object.entries(result)).toContainEqual([subject.content, "  Preserve this text.  "]);
    });

    test.each(["null", "[]", "true", "{}", "{invalid"])(
      "rejects an invalid response root: %s",
      (raw) => {
        expect(() => subject.parse(raw)).toThrow();
      },
    );

    test.each([subject.content, subject.rationale, "confidence"])(
      "rejects a missing required field: %s",
      (field) => {
        const missing = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
        expect(() => subject.parse(JSON.stringify(missing))).toThrow(field);
      },
    );

    test.each([
      { field: subject.content, value: 42 },
      { field: subject.rationale, value: false },
      { field: "confidence", value: "0.8" },
    ])("rejects a field with the wrong type: $field", ({ field, value }) => {
      expect(() => subject.parse(JSON.stringify({ ...valid, [field]: value }))).toThrow(field);
    });

    test("accepts fenced JSON without retaining undeclared model fields", () => {
      const raw = `\`\`\`json\n${JSON.stringify({ ...valid, extra: { private: "not part of a proposal" } })}\n\`\`\``;
      const result = subject.parse(raw);
      expect(Object.keys(result).sort()).toEqual(
        [subject.content, subject.rationale, "confidence"].sort(),
      );
      expect(Object.entries(result)).toContainEqual([subject.rationale, "Why"]);
    });
  });
}
