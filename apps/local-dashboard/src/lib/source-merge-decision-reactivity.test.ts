import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  dashboardQueryKeys,
  DashboardResource,
  invalidateDashboardResources,
  sourceMergeDecisionResources,
} from "@/lib/reactivity";

function seed(queryClient: QueryClient): void {
  for (const resource of Object.values(DashboardResource)) {
    for (const queryKey of dashboardQueryKeys[resource])
      queryClient.setQueryData(queryKey, "stable");
  }
}

describe("source merge decision reactivity", () => {
  it("refreshes only Decisions when a merge is declined", async () => {
    const queryClient = new QueryClient();
    seed(queryClient);

    await invalidateDashboardResources(queryClient, sourceMergeDecisionResources.decide);

    expect(queryClient.getQueryState(["source-merge-decisions"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["overview"])?.isInvalidated).toBe(false);
  });

  it("converges Decisions, Library, overview, source review, and Projects after approval", async () => {
    const queryClient = new QueryClient();
    seed(queryClient);

    await invalidateDashboardResources(queryClient, sourceMergeDecisionResources.approve);

    for (const queryKey of [
      ["source-merge-decisions"],
      ["library"],
      ["skill-report"],
      ["overview"],
      ["source-update"],
      ["skill-sets"],
    ]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(["insights"])?.isInvalidated).toBe(false);
  });
});
