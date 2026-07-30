import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { TriggerSparkline } from "./TriggerSparkline";

describe("TriggerSparkline", () => {
  it("renders a flat baseline when analytics loaded without observations", () => {
    const html = renderToStaticMarkup(
      <TriggerSparkline data={[]} label="unused-skill" lifetimeTotal={0} />,
    );

    expect(html).toContain("unused-skill: no recorded triggers");
    expect(html).toContain("<line");
    expect(html).not.toContain("no trigger history");
  });

  it("keeps the unavailable placeholder when analytics has not loaded", () => {
    const html = renderToStaticMarkup(
      <TriggerSparkline data={[]} label="pending-skill" lifetimeTotal={null} />,
    );

    expect(html).toContain("pending-skill: no trigger history");
    expect(html).not.toContain("<line");
  });
});
