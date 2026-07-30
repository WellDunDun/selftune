import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  dashboardQueryKeys,
  dashboardUpdateResources,
  DashboardResource,
  insightDecisionResources,
  invalidateDashboardResources,
  reactiveMutationOptions,
} from "@/lib/reactivity";

function seed(queryClient: QueryClient): void {
  for (const resource of Object.values(DashboardResource)) {
    for (const queryKey of dashboardQueryKeys[resource]) {
      queryClient.setQueryData(queryKey, `cached:${String(queryKey[0])}`);
    }
  }
  queryClient.setQueryData(["unrelated"], "stable");
}

describe("Insights semantic reactivity", () => {
  it("declares the precise resources affected by each successful decision", () => {
    expect(insightDecisionResources.review).toEqual([
      DashboardResource.insightsQueue,
      DashboardResource.overview,
      DashboardResource.proposals,
    ]);
    expect(insightDecisionResources.draft).toEqual([
      DashboardResource.insightsQueue,
      DashboardResource.libraryInventory,
      DashboardResource.skillIntelligence,
      DashboardResource.overview,
      DashboardResource.proposals,
    ]);
    expect(insightDecisionResources.evaluate).toEqual([
      DashboardResource.insightsQueue,
      DashboardResource.proposals,
    ]);
    expect(insightDecisionResources.release).toEqual(insightDecisionResources.draft);
  });

  it("converges queue, Library, overview, and proposal views without unrelated churn", async () => {
    const queryClient = new QueryClient();
    seed(queryClient);

    await invalidateDashboardResources(queryClient, insightDecisionResources.release);

    for (const queryKey of [["insights"], ["library"], ["overview"], ["skill-report"]]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["source-update"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["skill-sets"])?.isInvalidated).toBe(false);
  });

  it("uses success-only invalidation so failed and retried decisions leave no optimistic state", async () => {
    const queryClient = new QueryClient();
    seed(queryClient);
    let attempts = 0;
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Decision was not persisted");
          return { status: "accepted" };
        },
        resources: insightDecisionResources.review,
      }),
    );

    await expect(observer.mutate(undefined)).rejects.toThrow("Decision was not persisted");
    for (const resource of Object.values(DashboardResource)) {
      for (const queryKey of dashboardQueryKeys[resource]) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      }
    }

    await observer.mutate(undefined);
    expect(attempts).toBe(2);
    expect(queryClient.getQueryState(["insights"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["overview"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["skill-report"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(false);
  });

  it("reuses the mutation declaration for a matching live update", () => {
    expect(
      dashboardUpdateResources({
        type: "update",
        ts: 1,
        resources: insightDecisionResources.release,
      }),
    ).toEqual(insightDecisionResources.release);
  });
});
