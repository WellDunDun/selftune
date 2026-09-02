// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSettingsResponse } from "@/types";

const useSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useSettings", () => {
  const mutation = () => ({
    data: undefined,
    isPending: false,
    mutate: vi.fn(),
  });

  return {
    useSettings: useSettingsMock,
    useCreateRemoteLibraryShare: mutation,
    useExportRemoteLibrary: mutation,
    useInviteWorkspaceMember: mutation,
    useLinkCloudAccount: mutation,
    usePreviewRemoteLibrary: mutation,
    useRemoteLibraryShareAction: mutation,
    useRemoveWorkspaceMember: mutation,
    useResetWorkspaceSkillSetPolicy: mutation,
    useRestoreRemoteLibrary: mutation,
    useSyncRemoteLibrary: mutation,
    useUpdateRemoteLibrarySettings: mutation,
    useUpdateScheduleSettings: mutation,
    useUpdateWorkspaceMemberRole: mutation,
    useUpdateWorkspaceSkillSetPolicy: mutation,
    useRemoteLibraryStatus: () => ({ data: undefined, isError: false }),
    useRemoteLibraryShares: () => ({ data: undefined }),
    useWorkspaceSkillSetPolicies: () => ({ data: undefined, isLoading: false }),
    useWorkspaceMembers: () => ({ data: undefined, isLoading: false }),
  };
});

import { Settings } from "./Settings";

function settingsFor(url: string): DesktopSettingsResponse {
  return {
    harnesses: [],
    agent_skill: {
      installed: true,
      locations: [],
      install_command: "npx skills add selftune-dev/selftune",
    },
    onboarding: {
      version: 1,
      completed: true,
      import_sources: {
        claude_code: false,
        cline: false,
        codex: false,
        opencode: false,
        openclaw: false,
        pi: false,
      },
      hook_harnesses: {
        claude_code: false,
        cline: false,
        codex: false,
        opencode: false,
        pi: false,
      },
      features: {
        observability: true,
        health_recommendations: true,
        autonomous_improvement: false,
      },
    },
    cloud_account: {
      linked: true,
      cloud_user_id: "user-1",
      cloud_org_id: "workspace-1",
    },
    remote_library: {
      configured: true,
      credential_provider: null,
      url,
      preferences: {
        releasedSkills: false,
        drafts: false,
        skillSets: false,
        metadata: false,
        decisionHistory: false,
      },
    },
    schedule: {
      supported: true,
      format: "launchd",
      settings_path: "/tmp/jobs.json",
      jobs: [],
    },
  };
}

function renderSettings(url: string) {
  useSettingsMock.mockReturnValue({
    data: settingsFor(url),
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  });

  return render(
    <MemoryRouter initialEntries={["/settings?section=remote-library"]}>
      <Settings />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useSettingsMock.mockReset();
});

describe("Settings remote-library capabilities", () => {
  it("shows complete backup actions only for a configured self-hosted server", async () => {
    const cloud = renderSettings("https://cloud.selftune.dev");

    await screen.findByRole("heading", {
      name: "Cloud connection & self-hosted backup",
    });
    expect(screen.queryByTitle("Export complete backup")).toBeNull();
    expect(screen.queryByTitle("Restore into a new local directory")).toBeNull();

    cloud.unmount();
    renderSettings("https://selftune.example.com");

    expect(await screen.findByTitle("Export complete backup")).not.toBeNull();
    expect(screen.getByTitle("Restore into a new local directory")).not.toBeNull();
  });
});
