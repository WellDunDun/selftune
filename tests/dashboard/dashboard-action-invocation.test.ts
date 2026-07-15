import { describe, expect, it } from "bun:test";

import { resolveDashboardActionInvocation } from "@selftune/local/routes/actions";

describe("dashboard action invocation", () => {
  it("uses the compiled task CLI in packaged desktop builds", () => {
    expect(
      resolveDashboardActionInvocation("sync", [], {
        binPath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune-cli",
      }),
    ).toEqual(["/Applications/SelfTune.app/Contents/Resources/selftune/selftune-cli", "sync"]);
  });

  it("uses the source entrypoint during development", () => {
    expect(
      resolveDashboardActionInvocation("watch", ["--skill", "example"], {
        sourceIndexPath: "/workspace/cli/selftune/index.ts",
      }),
    ).toEqual(["bun", "run", "/workspace/cli/selftune/index.ts", "watch", "--skill", "example"]);
  });
});
