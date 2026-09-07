import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WizardSteps } from "./wizard-steps";

describe("WizardSteps", () => {
  it("renders the accessible step rail and first step content", () => {
    const html = renderToStaticMarkup(
      <WizardSteps
        steps={[
          { id: "inspect", label: "Inspect", content: <p>Inspect the exact revision.</p> },
          { id: "evidence", label: "Evidence", content: <p>Check the evidence.</p> },
          { id: "decide", label: "Decide", content: <p>Choose the outcome.</p> },
        ]}
      />,
    );

    expect(html).toContain('aria-label="Steps"');
    expect(html).toContain("Step 1 of 3: Inspect");
    expect(html).toContain("Inspect the exact revision.");
    expect(html).toContain("Step 3 of 3: Decide");
  });
});
