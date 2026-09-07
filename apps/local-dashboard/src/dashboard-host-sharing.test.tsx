// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import type { SkillSetPackManagementList } from "@selftune/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localDashboardModules } from "./dashboard-host";
import { useLocalLibraryTransferActions } from "./local-library-transfer-actions";
import { settingsFor } from "./test-fixtures/settings";
import type { WorkspaceMembersResponse } from "./types";

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function renderSharing(url: string) {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/v2/settings") return Response.json(settingsFor(url));
    if (input === "/api/v2/skill-sets/packs") {
      return Response.json({ packs: [] } satisfies SkillSetPackManagementList);
    }
    if (input === "/api/v2/settings/workspace/members") {
      return Response.json({
        current_user_id: "owner",
        current_role: "owner",
        members: [],
        invitations: [],
      } satisfies WorkspaceMembersResponse);
    }
    throw new Error(`Unexpected request: ${input}`);
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(
    () => {
      const projects = localDashboardModules.skillSets.projects;
      if (projects.access !== "available") {
        throw new Error("Expected local Skill Sets to be available.");
      }
      return {
        projects: projects.useActions(),
        library: useLocalLibraryTransferActions(),
      };
    },
    { wrapper: Wrapper },
  );
  return { result, fetch };
}

describe("local project and Library sharing capabilities", () => {
  it("offers managed-Cloud copy-link sharing without requesting self-hosted data", async () => {
    const { result, fetch } = renderSharing("https://cloud.selftune.dev");
    await waitFor(() => expect(result.current.projects.share?.access).toBe("available"));

    for (const actions of [result.current.projects, result.current.library]) {
      expect(actions.share).toMatchObject({
        access: "available",
        capabilities: {
          linkModes: ["private_single_claim"],
          deliveries: ["copy_link"],
        },
      });
    }
    expect(result.current.library.backup?.access).toBe("unavailable");
    expect(result.current.projects.publishRelease).toMatchObject({
      preview: { access: "available" },
      execute: { access: "available" },
    });
    expect(result.current.projects.usePacks).toBeUndefined();
    expect(result.current.projects.revokePack).toBeUndefined();
    expect(result.current.projects.useShareRecipients).toBeUndefined();
    expect(result.current.projects.shareWithWorkspace).toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v2/settings"]);
  });

  it("loads self-hosted distribution data and exposes full sharing and backup", async () => {
    const { result, fetch } = renderSharing("https://skills.example.test");
    await waitFor(() => expect(result.current.projects.usePacks?.().data).toEqual([]));

    for (const actions of [result.current.projects, result.current.library]) {
      expect(actions.share).toMatchObject({
        access: "available",
        capabilities: {
          linkModes: ["reusable_unlisted", "private_single_claim"],
          deliveries: ["copy_link", "email"],
        },
      });
    }
    expect(result.current.library.backup?.access).toBe("available");
    expect(result.current.projects.publishRelease).toBeUndefined();
    expect(result.current.projects.revokePack).toMatchObject({ access: "available" });
    expect(result.current.projects.useShareRecipients?.()).toEqual([]);
    expect(result.current.projects.shareWithWorkspace).toMatchObject({ access: "available" });
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "/api/v2/settings",
      "/api/v2/settings/workspace/members",
      "/api/v2/skill-sets/packs",
    ]);
  });
});
