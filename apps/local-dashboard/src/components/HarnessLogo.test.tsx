import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HarnessLogo } from "./HarnessLogo";

describe("HarnessLogo", () => {
  it("renders arbitrary package-owned presentation metadata without an app registry", () => {
    const src = "data:image/svg+xml,%3Csvg%20data-fixture%3D%22true%22%2F%3E";
    const html = renderToStaticMarkup(
      <HarnessLogo name="Fixture Agent" icon={{ src, fit: "cover", inset: "none" }} />,
    );

    expect(html).toContain(`src="${src}"`);
    expect(html).toContain("object-cover");
    expect(html).not.toContain("fixture.svg");
  });
});
