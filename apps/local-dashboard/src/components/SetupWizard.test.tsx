// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplyOnboardingResponse, DesktopSettingsResponse } from "@/types";

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

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function renderSetup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<SetupWizard settings={settings} />} />
          <Route path="/skills" element={<h1>Skills Library</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("SetupWizard", () => {
  it("offers a bounded prompt when the SelfTune agent skill is not detected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
    renderSetup();
    fireEvent.click(screen.getByRole("button", { name: /copy prompt for my ai agent/i }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("If the SelfTune skill is not already installed"),
    );
    expect(screen.getByText("npx skills add selftune-dev/selftune")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains on-demand use, saves selected features, and opens the Library after setup", async () => {
    const completed = {
      ...settings,
      onboarding: { ...settings.onboarding, completed: true },
      install_results: [],
      source_sync: { status: "processed", message: null },
    } satisfies ApplyOnboardingResponse;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(completed));
    renderSetup();
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    }
    fireEvent.click(screen.getByRole("switch", { name: /Enable Health recommendations$/ }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/keep specialist skills ready/i)).toBeTruthy();
    expect(screen.getByText(/Corey Haines marketing skills/i)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /apply setup/i }));
    await screen.findByRole("heading", { name: "Skills Library" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v2/settings/onboarding",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          import_sources: [],
          hook_harnesses: [],
          features: {
            observability: true,
            health_recommendations: false,
            autonomous_improvement: false,
          },
        }),
      }),
    );
  });
});
