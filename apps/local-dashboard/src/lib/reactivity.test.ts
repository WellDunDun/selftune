import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  dashboardQueryKeys,
  DashboardResource,
  type DashboardResource as DashboardResourceName,
  dashboardUpdateResources,
  dashboardUpdateResourcesFromJson,
  databaseLiveResources,
  createSSEConnectionLease,
  isSSEConnected,
  invalidateDashboardResources,
  libraryLocationWriteResources,
  projectSkillSetResources,
  reactiveMutationOptions,
  sourceUpdateResources,
} from "@/lib/reactivity";

const trackedResources = [
  DashboardResource.libraryInventory,
  DashboardResource.skillIntelligence,
  DashboardResource.libraryDetail,
  DashboardResource.overview,
  DashboardResource.sourceUpdate,
  DashboardResource.projects,
] as const;

function seedResources(
  queryClient: QueryClient,
  resources: readonly DashboardResourceName[] = trackedResources,
): void {
  for (const resource of resources) {
    for (const queryKey of dashboardQueryKeys[resource]) {
      queryClient.setQueryData(queryKey, `${resource}:${String(queryKey[0])}`);
    }
  }
}

function expectResourcesInvalidated(
  queryClient: QueryClient,
  resources: readonly DashboardResourceName[] = trackedResources,
): void {
  for (const resource of resources) {
    for (const queryKey of dashboardQueryKeys[resource]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  }
}

describe("dashboard semantic reactivity", () => {
  it("keeps bounded skill intelligence out of ordinary SQLite WAL invalidations", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);

    await invalidateDashboardResources(queryClient, databaseLiveResources);

    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["portfolio"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["skill-intelligence"])?.isInvalidated).toBe(false);
  });

  it("keeps polling disabled only while an SSE lease is open", () => {
    const first = createSSEConnectionLease();
    const replacement = createSSEConnectionLease();

    expect(isSSEConnected()).toBe(false);
    first.open();
    expect(isSSEConnected()).toBe(true);
    first.disconnected();
    expect(isSSEConnected()).toBe(false);
    replacement.open();
    expect(isSSEConnected()).toBe(true);
    replacement.close();
    expect(isSSEConnected()).toBe(false);
    first.close();
  });

  it("refreshes only Projects after a Skill Set is created", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);
    queryClient.setQueryData(["unrelated"], "stable");

    await invalidateDashboardResources(queryClient, projectSkillSetResources.create);

    expectResourcesInvalidated(queryClient, [DashboardResource.projects]);
    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["overview"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });

  it("uses the same precise Projects resource for edit, derive, export, and plan", () => {
    expect(projectSkillSetResources.update).toEqual(projectSkillSetResources.create);
    expect(projectSkillSetResources.derive).toEqual(projectSkillSetResources.create);
    expect(projectSkillSetResources.export).toEqual(projectSkillSetResources.create);
    expect(projectSkillSetResources.plan).toEqual(projectSkillSetResources.create);
  });

  it("converges Projects, Library, and overview after apply and rollback", async () => {
    const affected = [
      DashboardResource.projects,
      DashboardResource.libraryInventory,
      DashboardResource.libraryDetail,
      DashboardResource.skillIntelligence,
      DashboardResource.overview,
    ] as const;
    expect(projectSkillSetResources.apply).toEqual(affected);
    expect(projectSkillSetResources.rollback).toEqual(affected);

    const queryClient = new QueryClient();
    seedResources(queryClient);
    queryClient.setQueryData(["unrelated"], "stable");
    await invalidateDashboardResources(queryClient, projectSkillSetResources.apply);

    expectResourcesInvalidated(queryClient, affected);
    expect(
      queryClient.getQueryState(dashboardQueryKeys[DashboardResource.sourceUpdate][0])
        ?.isInvalidated,
    ).toBe(false);
    expect(queryClient.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });

  it("preserves cached project and Library state on an actionable rollback failure", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async () => {
          throw new Error("Rollback receipt is stale. Preview the project and retry.");
        },
        resources: projectSkillSetResources.rollback,
      }),
    );

    await expect(observer.mutate(undefined)).rejects.toThrow(
      "Rollback receipt is stale. Preview the project and retry.",
    );

    for (const resource of trackedResources) {
      for (const queryKey of dashboardQueryKeys[resource]) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      }
    }
  });

  it("refreshes exactly the stable views changed by an applied source update", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);
    queryClient.setQueryData(["unrelated"], "stable");

    await invalidateDashboardResources(queryClient, sourceUpdateResources.apply);

    expectResourcesInvalidated(queryClient);
    expect(queryClient.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });

  it("refreshes staged source-update state after a successful preview", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(dashboardQueryKeys[DashboardResource.sourceUpdate][0], "old preview");
    queryClient.setQueryData(["library"], "stable library");
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async (skillName: string) => ({ skillName, status: "available" }),
        resources: sourceUpdateResources.preview,
      }),
    );

    await observer.mutate("agent-browser");

    expect(
      queryClient.getQueryState(dashboardQueryKeys[DashboardResource.sourceUpdate][0])
        ?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(false);
  });

  it("keeps stable and staged views intact when a source-update action fails", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      dashboardQueryKeys[DashboardResource.sourceUpdate][0],
      "reviewed preview",
    );
    queryClient.setQueryData(["library"], "stable library");
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async () => {
          throw new Error("MERGE_INVALID");
        },
        resources: sourceUpdateResources.apply,
      }),
    );

    await expect(observer.mutate(undefined)).rejects.toThrow("MERGE_INVALID");

    expect(
      queryClient.getQueryState(dashboardQueryKeys[DashboardResource.sourceUpdate][0])
        ?.isInvalidated,
    ).toBe(false);
    expect(queryClient.getQueryState(["library"])?.isInvalidated).toBe(false);
  });

  it("refreshes only staged source-update state after merge preparation", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(dashboardQueryKeys[DashboardResource.sourceUpdate][0], "old merge");
    queryClient.setQueryData(dashboardQueryKeys[DashboardResource.projects][0], "projects");
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async () => ({ mergeId: "merge-1" }),
        resources: sourceUpdateResources.prepareMerge,
      }),
    );

    await observer.mutate(undefined);

    expect(
      queryClient.getQueryState(dashboardQueryKeys[DashboardResource.sourceUpdate][0])
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(dashboardQueryKeys[DashboardResource.projects][0])?.isInvalidated,
    ).toBe(false);
  });

  it("refreshes derived Library views after a partially applied removal fails", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);
    const observer = new MutationObserver(
      queryClient,
      reactiveMutationOptions(queryClient, {
        mutationFn: async () => {
          throw new Error("1 of 2 locations were removed");
        },
        resources: libraryLocationWriteResources,
        invalidateOn: "settled",
      }),
    );

    await expect(observer.mutate(undefined)).rejects.toThrow("1 of 2 locations were removed");

    expectResourcesInvalidated(queryClient);
  });

  it("reads semantic resources from live updates and safely falls back for older servers", () => {
    expect(
      dashboardUpdateResources({
        type: "update",
        resources: sourceUpdateResources.apply,
        ts: 1,
      }),
    ).toEqual(sourceUpdateResources.apply);
    expect(dashboardUpdateResources({ type: "update", ts: 1 })).toEqual(databaseLiveResources);
    expect(
      dashboardUpdateResources({
        resources: ["library-inventory", "not-a-dashboard-resource"],
      }),
    ).toEqual([DashboardResource.libraryInventory]);
    expect(dashboardUpdateResourcesFromJson("not-json")).toEqual(databaseLiveResources);
  });

  it("refreshes the same views when an applied source update arrives over SSE", async () => {
    const queryClient = new QueryClient();
    seedResources(queryClient);
    queryClient.setQueryData(["unrelated"], "stable");

    const event = {
      type: "update",
      ts: 1,
      resources: sourceUpdateResources.apply,
    };
    await invalidateDashboardResources(queryClient, dashboardUpdateResources(event));

    expectResourcesInvalidated(queryClient);
    expect(queryClient.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });
});
