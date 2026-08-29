// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplyOnboardingResponse, DesktopSettingsResponse } from "@/types";

const navigate = vi.fn();
const mutate = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/hooks/useSettings", () => ({
  useApplyOnboarding: () => ({ isPending: false, mutate }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/HarnessLogo", () => ({ HarnessLogo: () => null }));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ "aria-label": ariaLabel }: { "aria-label": string }) => (
    <button aria-label={ariaLabel} />
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { SetupWizard } from "./SetupWizard";

const settings: DesktopSettingsResponse = {
  harnesses: [],
  agent_skill: {
    installed: false,
    locations: [],
    install_command: "npx skills add selftune-dev/selftune",
  },
  onboarding: {
    version: 1,
    completed: false,
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
  cloud_account: { linked: false, cloud_user_id: null, cloud_org_id: null },
  remote_library: {
    configured: false,
    credential_provider: null,
    url: null,
    preferences: {
      releasedSkills: false,
      drafts: false,
      skillSets: false,
      metadata: false,
      decisionHistory: false,
    },
  },
  schedule: { supported: true, format: "launchd", settings_path: "/tmp/jobs.json", jobs: [] },
};

afterEach(() => {
  cleanup();
  navigate.mockReset();
  mutate.mockReset();
});

describe("SetupWizard", () => {
  it("offers a bounded prompt when the SelfTune agent skill is not detected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<SetupWizard settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /copy prompt for my ai agent/i }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("If the SelfTune skill is not already installed"),
    );
    expect(screen.getByText("npx skills add selftune-dev/selftune")).toBeTruthy();
  });

  it("opens the cleanup overview after selected history is processed", () => {
    mutate.mockImplementation((_request, callbacks) => {
      callbacks.onSuccess({
        ...settings,
        onboarding: { ...settings.onboarding, completed: true },
        install_results: [],
        source_sync: { status: "processed", message: null },
      } satisfies ApplyOnboardingResponse);
    });

    render(<SetupWizard settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /apply setup/i }));

    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });
});
