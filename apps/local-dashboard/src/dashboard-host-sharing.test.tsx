// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const remoteSettings = vi.hoisted(() => ({
  value: {
    cloud_account: { linked: true },
    remote_library: { configured: true, url: "https://cloud.selftune.dev" },
  },
}));

const enabledQueries = vi.hoisted(() => ({ packs: false, members: false }));

vi.mock("./hooks/useSettings", async () => {
  const actual = await vi.importActual<typeof import("./hooks/useSettings")>("./hooks/useSettings");
  return {
    ...actual,
    useSettings: () => ({ data: remoteSettings.value }),
    useWorkspaceMembers: (enabled: boolean) => {
      enabledQueries.members = enabled;
      return {
        data: { current_user_id: "owner", members: [] },
        isLoading: false,
        error: null,
      };
    },
  };
});

vi.mock("./hooks/useSkillSets", async () => {
  const actual =
    await vi.importActual<typeof import("./hooks/useSkillSets")>("./hooks/useSkillSets");
  return {
    ...actual,
    useSkillSetPacks: (enabled: boolean) => {
      enabledQueries.packs = enabled;
      return {
        data: { packs: [] },
        isLoading: false,
        error: null,
        refetch: vi.fn().mockResolvedValue(undefined),
      };
    },
  };
});

import { localDashboardModules } from "./dashboard-host";

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

function useProjectsActions() {
  const projects = localDashboardModules.skillSets.projects;
  if (projects.access !== "available") {
    throw new Error("Expected local Skill Sets to be available.");
  }
  return projects.useActions();
}

describe("local project sharing capabilities", () => {
  beforeEach(() => {
    enabledQueries.packs = false;
    enabledQueries.members = false;
  });

  it("keeps unsupported managed-Cloud pack and workspace actions out of the host seam", () => {
    remoteSettings.value = {
      cloud_account: { linked: true },
      remote_library: { configured: true, url: "https://cloud.selftune.dev" },
    };

    const { result } = renderHook(useProjectsActions, {
      wrapper: queryWrapper(),
    });

    expect(result.current.share).toMatchObject({
      access: "available",
      capabilities: {
        linkModes: ["private_single_claim"],
        deliveries: ["copy_link"],
      },
    });
    expect(result.current.publishRelease).toMatchObject({
      preview: { access: "available" },
      execute: { access: "available" },
    });
    expect(result.current.usePacks).toBeUndefined();
    expect(result.current.revokePack).toBeUndefined();
    expect(result.current.useShareRecipients).toBeUndefined();
    expect(result.current.shareWithWorkspace).toBeUndefined();
    expect(enabledQueries).toEqual({ packs: false, members: false });
  });

  it("preserves the complete distribution seam for self-hosted servers", () => {
    remoteSettings.value = {
      cloud_account: { linked: false },
      remote_library: { configured: true, url: "https://skills.example.test" },
    };

    const { result } = renderHook(useProjectsActions, {
      wrapper: queryWrapper(),
    });

    expect(result.current.share).toMatchObject({
      access: "available",
      capabilities: {
        linkModes: ["reusable_unlisted", "private_single_claim"],
        deliveries: ["copy_link", "email"],
      },
    });
    expect(result.current.publishRelease).toBeUndefined();
    expect(result.current.usePacks).toBeTypeOf("function");
    expect(result.current.revokePack).toMatchObject({ access: "available" });
    expect(result.current.useShareRecipients).toBeTypeOf("function");
    expect(result.current.shareWithWorkspace).toMatchObject({
      access: "available",
    });
    expect(enabledQueries).toEqual({ packs: true, members: true });
  });
});
