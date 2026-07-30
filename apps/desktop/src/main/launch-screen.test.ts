import { describe, expect, it } from "bun:test";

import { runtimeLaunchHtml } from "./launch-screen";

describe("runtime launch screen", () => {
  it("renders a branded indeterminate progress surface without script execution", () => {
    const html = runtimeLaunchHtml();
    expect(html).toContain("Starting the local service...");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("-webkit-app-region: drag");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("--primary: #171816");
    expect(html).toContain('viewBox="0 0 250 250"');
    expect(html).not.toContain(">ST</div>");
    expect(html).not.toContain("#57b88a");
    expect(html).not.toContain("<script");
  });
});
