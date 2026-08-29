// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DashboardTeamCollaborationActions,
  DashboardTeamCollaborationContribution,
} from "@selftune/dashboard-core/host";
import type { TeamCollaborationSnapshotModel } from "@selftune/dashboard-core/models";
import {
  fetchLocalTeamCollaboration,
  localDashboardModules,
  localWorkspaceSkillSetPolicyInput,
  selfHostDashboardModules,
} from "./dashboard-host";

const snapshot: TeamCollaborationSnapshotModel = {
  entries: [
    {
      id: "entry/one",
      name: "release-review",
      rolloutPolicy: "manual",
      currentVersion: "1.0.0",
      pendingContributions: 1,
      installations: 2,
      conflicts: 0,
    },
  ],
  contributions: [],
  installations: [],
};

function availableCollaboration(): Extract<
  DashboardTeamCollaborationContribution,
  { access: "available" }
> {
  const collaboration = localDashboardModules.teamCollaboration.collaboration;
  if (!collaboration || collaboration.access !== "available") {
    throw new Error("Expected the local collaboration adapter to be available.");
  }
  return collaboration;
}

function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("Desktop team collaboration adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the canonical snapshot through the local sidecar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => availableCollaboration().useSnapshot(), {
      wrapper: queryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/team-collaboration");
  });

  it("exposes admin actions and sends the exact sidecar requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/v2/team-collaboration/access") {
        return new Response(JSON.stringify({ currentRole: "admin", readOnly: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const { result } = renderHook(() => availableCollaboration().useActions(), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.updateRolloutPolicy.access).toBe("available"));

    await act(async () => {
      const rollout = result.current.updateRolloutPolicy;
      if (rollout.access !== "available") throw new Error("Rollout action was not available.");
      await rollout.execute({ entryId: "entry/one", policy: "automatic" });
    });
    async function executeDecision(
      name: string,
      action: DashboardTeamCollaborationActions["adoptContribution"],
    ) {
      await act(async () => {
        if (action.access !== "available") throw new Error(`${name} action was not available.`);
        await action.execute("candidate one");
      });
    }
    await executeDecision("adopt", result.current.adoptContribution);
    await executeDecision("reject", result.current.rejectContribution);
    await executeDecision("rollback", result.current.rollbackContribution);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/team-collaboration/registry/entry%2Fone/rollout-policy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: "automatic" }),
      },
    );
    for (const decision of ["adopt", "reject", "rollback"]) {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v2/team-collaboration/contributions/candidate%20one/${decision}`,
        { method: "POST" },
      );
    }
  });

  it("keeps member and viewer collaboration read only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ currentRole: "member", readOnly: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => availableCollaboration().useActions(), {
      wrapper: queryWrapper(),
    });
    await waitFor(() =>
      expect(result.current.adoptContribution).toMatchObject({
        access: "unavailable",
        reason: expect.stringMatching(/admins and owners/i),
      }),
    );

    expect(result.current.adoptContribution).toMatchObject({
      access: "unavailable",
      reason: expect.stringMatching(/admins and owners/i),
    });
    expect(result.current.rejectContribution.access).toBe("unavailable");
    expect(result.current.rollbackContribution.access).toBe("unavailable");
  });

  it("keeps an admin read only when the Cloud workspace is read only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ currentRole: "admin", readOnly: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => availableCollaboration().useActions(), {
      wrapper: queryWrapper(),
    });
    await waitFor(() =>
      expect(result.current.updateRolloutPolicy).toMatchObject({
        access: "unavailable",
        reason: expect.stringMatching(/workspace is read only/i),
      }),
    );

    expect(result.current.adoptContribution.access).toBe("unavailable");
    expect(result.current.rejectContribution.access).toBe("unavailable");
    expect(result.current.rollbackContribution.access).toBe("unavailable");
  });

  it("keeps mutations unavailable when workspace authority cannot be verified", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Cloud workspace unavailable", { status: 503 }),
    );

    const { result } = renderHook(() => availableCollaboration().useActions(), {
      wrapper: queryWrapper(),
    });
    await waitFor(() =>
      expect(result.current.updateRolloutPolicy).toMatchObject({
        access: "unavailable",
        reason: expect.stringMatching(/permissions could not be loaded/i),
      }),
    );

    expect(result.current.adoptContribution.access).toBe("unavailable");
  });

  it("surfaces an offline local service as a query error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => availableCollaboration().useSnapshot(), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(result.current.error).toMatch(/could not be reached/i));

    expect(result.current.data).toBeNull();
    await expect(fetchLocalTeamCollaboration()).rejects.toThrow(/could not be reached/i);
  });

  it("mounts the shared contribution in both Desktop compositions", () => {
    expect(localDashboardModules.teamCollaboration.collaboration?.access).toBe("available");
    expect(selfHostDashboardModules.teamCollaboration.collaboration).toBe(
      localDashboardModules.teamCollaboration.collaboration,
    );
  });

  it("marks whole-workspace Skill Set sharing as required", () => {
    expect(localWorkspaceSkillSetPolicyInput("engineering")).toEqual({
      skillSetId: "engineering",
      action: "require",
    });
  });
});
