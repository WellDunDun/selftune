import { expect, test } from "bun:test";
import { decodeBodyQualityAssessment } from "../../packages/runtime/evolution/validate-body.js";

test.each([
  { input: '{"score":0,"reason":"needs work"}', score: 0, reason: "needs work" },
  { input: '{"score":2,"reason":"clear"}', score: 1, reason: "clear" },
  { input: '{"score":-1}', score: 0, reason: "No reason provided" },
  { input: '{"score":"0.9","reason":"valid neighbor"}', score: 0.5, reason: "valid neighbor" },
  { input: '{"score":0.8,"reason":[]}', score: 0.8, reason: "No reason provided" },
  { input: '{"score":null,"reason":""}', score: 0.5, reason: "" },
  { input: '```json\n{"score":0.7,"reason":"clear"}\n```', score: 0.7, reason: "clear" },
  { input: "{invalid", score: 0.5, reason: "Failed to parse quality assessment response" },
  { input: "null", score: 0.5, reason: "Quality assessment response is not a JSON object" },
  { input: "[]", score: 0.5, reason: "Quality assessment response is not a JSON object" },
  {
    input: '"not an assessment"',
    score: 0.5,
    reason: "Quality assessment response is not a JSON object",
  },
])(
  "decodes model assessment fields without discarding valid neighbors: $input",
  ({ input, score, reason }) => {
    expect(decodeBodyQualityAssessment(input)).toEqual({ score, reason });
  },
);
