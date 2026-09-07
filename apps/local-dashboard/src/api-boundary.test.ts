// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSyncPreferences } from "@selftune/control-plane";
import type { DesktopSettingsResponse } from "./types";
import {
  applyOnboarding,
  fetchSettings,
  updateScheduleSettings,
  updateRemoteLibrarySettings,
  runDashboardAction,
  revokeProjectSkillSetPack,
  previewLibrarySkillLicense,
  shareProjectSkillSet,
} from "./api";

const settings = {
  harnesses: [
    {
      id: "custom-harness",
      name: "Custom",
      description: "An installed harness",
      icon: { src: "/custom.svg", fit: "contain", inset: "none" },
      documentation_url: null,
      source_merge: null,
      status: "connected",
      detected: true,
      connected: true,
      import_available: true,
      hooks_supported: false,
      hooks_installed: false,
      detail: "Connected locally",
    },
  ],
  agent_skill: {
    installed: true,
    locations: ["/tmp/skills/selftune"],
    install_command: "npx skills add selftune-dev/selftune",
  },
  onboarding: {
    version: 1,
    completed: true,
    import_sources: { custom: true },
    hook_harnesses: {},
    features: { observability: true, health_recommendations: true, autonomous_improvement: false },
  },
  cloud_account: { linked: false, cloud_user_id: null, cloud_org_id: null },
  remote_library: {
    configured: false,
    credential_provider: null,
    url: null,
    preferences: defaultSyncPreferences,
  },
  schedule: { supported: false, format: "unsupported", settings_path: "/tmp/jobs.json", jobs: [] },
} satisfies DesktopSettingsResponse;

afterEach(() => vi.restoreAllMocks());

describe("active Desktop response contracts", () => {
  it("preserves valid settings and package-defined harness identities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(settings));
    await expect(fetchSettings()).resolves.toEqual(settings);
  });

  it.each([
    null,
    { ...settings, harnesses: [{ ...settings.harnesses[0], detected: "true" }] },
    { ...settings, onboarding: { ...settings.onboarding, completed: "yes" } },
    { ...settings, remote_library: { ...settings.remote_library, preferences: { drafts: true } } },
    { ...settings, schedule: { ...settings.schedule, jobs: [{ id: "unknown-job" }] } },
  ])("rejects malformed successful settings: %j", async (payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    await expect(fetchSettings()).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });

  it("validates both settings mutation responses and preserves their request bodies", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json(settings));
    const schedule = { jobs: [] };
    const remote = { url: "https://library.example", preferences: defaultSyncPreferences };
    await expect(updateScheduleSettings(schedule)).resolves.toEqual(settings);
    await expect(updateRemoteLibrarySettings(remote)).resolves.toEqual(settings);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v2/settings/schedule",
      expect.objectContaining({ method: "POST", body: JSON.stringify(schedule) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v2/settings/remote-library",
      expect.objectContaining({ method: "POST", body: JSON.stringify(remote) }),
    );
  });

  it("requires onboarding installation results and retains valid failures for review", async () => {
    const complete = {
      ...settings,
      install_results: [{ harness_id: "codex", status: "failed", message: "Read-only directory" }],
      source_sync: { status: "skipped", message: null },
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json(complete));
    const input = {
      import_sources: [],
      hook_harnesses: [],
      features: settings.onboarding.features,
    };
    await expect(applyOnboarding(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(applyOnboarding(input)).resolves.toEqual(complete);
  });

  it.each([
    { error: "Permission denied" },
    {
      error: {
        code: "NOT_ALLOWED",
        message: "Permission denied",
        suggestion: "Choose another directory",
        retryable: false,
      },
    },
  ])("decodes supported service errors: %j", async (payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload, { status: 403 }));
    await expect(updateScheduleSettings({ jobs: [] })).rejects.toMatchObject({
      message: "Permission denied",
      status: 403,
      retryable: false,
    });
  });

  it("does not trust malformed error envelopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { message: { secret: "not a message" }, retryable: "yes" } },
        { status: 503 },
      ),
    );
    await expect(fetchSettings()).rejects.toMatchObject({
      message: "API error: 503",
      retryable: true,
    });
  });

  it("keeps missing-route guidance and handles non-JSON failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response("<html>Unavailable</html>", { status: 503 }));
    await expect(fetchSettings()).rejects.toMatchObject({ code: "ROUTE_NOT_FOUND" });
    await expect(revokeProjectSkillSetPack("research")).rejects.toMatchObject({ status: 503 });
  });

  it("validates action results without converting a failed command into success", async () => {
    const result = {
      success: false,
      output: "Command failed",
      error: "Invalid arguments",
      exitCode: 1,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json({ ...result, success: "false" }));
    const request = { skill: "review", skillPath: "/tmp/review/SKILL.md" };
    await expect(runDashboardAction("generate-evals", request)).resolves.toEqual(result);
    await expect(runDashboardAction("generate-evals", request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("omits absent optional JSON fields and includes explicitly selected sharing fields", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const terms = { copyrightHolder: "Author", licensedOrganization: "Team", year: 2026 };
    await previewLibrarySkillLicense({ skillId: "review", terms });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v2/library/license/preview",
      expect.objectContaining({
        body: JSON.stringify({
          skill_id: "review",
          terms: { copyright_holder: "Author", licensed_organization: "Team", year: 2026 },
        }),
      }),
    );
    await shareProjectSkillSet({
      skillSetId: "research",
      mode: "private_single_claim",
      delivery: "email",
      recipientEmail: "review@example.com",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v2/skill-sets/share",
      expect.objectContaining({
        body: JSON.stringify({
          set_id: "research",
          mode: "private_single_claim",
          delivery: "email",
          recipient_email: "review@example.com",
        }),
      }),
    );
  });
});
