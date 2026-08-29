import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CorrectionStudyReviewPanel } from "./CorrectionStudyReviewPanel";

test("renders no panel at all when nothing is decidable", () => {
  const html = renderToStaticMarkup(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: async () => [],
        recordDecision: async () => ({ recorded: true, appliesSkill: false }),
      }}
    />,
  );
  expect(html).toBe("");
});

test("renders explicit unavailable host parity", () => {
  const html = renderToStaticMarkup(
    <CorrectionStudyReviewPanel
      contribution={{ access: "unavailable", reason: "Cloud unavailable" }}
    />,
  );
  expect(html).toContain("Cloud unavailable");
});
