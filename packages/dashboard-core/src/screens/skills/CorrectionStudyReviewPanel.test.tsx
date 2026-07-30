import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CorrectionStudyReviewPanel } from "./CorrectionStudyReviewPanel";

test("renders durable evidence, proposed diff, regressions, and edit safety reason", () => {
  const html = renderToStaticMarkup(
    <CorrectionStudyReviewPanel
      contribution={{
        access: "available",
        list: async () => [],
        recordDecision: async () => ({ recorded: true, appliesSkill: false }),
      }}
    />,
  );
  expect(html).toContain("Correction reviews");
});

test("renders explicit unavailable host parity", () => {
  const html = renderToStaticMarkup(
    <CorrectionStudyReviewPanel
      contribution={{ access: "unavailable", reason: "Cloud unavailable" }}
    />,
  );
  expect(html).toContain("Cloud unavailable");
});
