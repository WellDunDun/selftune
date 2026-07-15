import { describe, expect, it } from "bun:test";

import { runtimeCrashHtml } from "./crash-screen";

describe("runtime crash screen", () => {
  it("offers every recovery action through the preload bridge", () => {
    const html = runtimeCrashHtml({ detail: "database failed", reported: false });
    expect(html).toContain("restartService()");
    expect(html).toContain("checkForUpdates()");
    expect(html).toContain("exportDiagnostics()");
    expect(html).toContain("resetLocalState()");
    expect(html).toContain("Automatic error reporting is off.");
    expect(html).toContain("Diagnostic exports stay on this Mac until you choose to share them.");
  });

  it("does not let failure detail terminate the inline script", () => {
    const html = runtimeCrashHtml({
      detail: "</script><script>window.compromised = true</script>",
      reported: true,
    });
    expect(html).not.toContain("</script><script>window.compromised");
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("Automatic error reporting is enabled.");
    expect(html).not.toContain("skill data");
    expect(html).not.toContain("report was sent");
  });
});
