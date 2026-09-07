import type { DesktopSettingsResponse } from "../types";

export function settingsFor(url: string): DesktopSettingsResponse {
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
