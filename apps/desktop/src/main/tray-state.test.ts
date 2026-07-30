import { describe, expect, it } from "bun:test";

import {
  harnessSummary,
  humanizeSchedule,
  remoteLibrarySummary,
  statusLabel,
  toggleScheduleJob,
  type TrayRemoteState,
} from "./tray-state";

const remoteState: TrayRemoteState = {
  insights: {
    counts: {
      pending: 1,
      accepted: 1,
      drafted: 1,
      snoozed: 0,
      completed: 0,
      stale_reviews: 1,
      routing_reviews: 0,
    },
  },
  health: {
    ok: true,
    version: "0.2.22",
    latest_version: null,
    update_available: false,
    log_dir: "/tmp/selftune/logs",
  },
  overview: {
    autonomy_status: {
      level: "needs_review",
      skills_observed: 12,
      pending_reviews: 2,
      attention_required: 4,
    },
  },
  settings: {
    remote_library: { configured: false, url: null },
    harnesses: [
      {
        id: "codex",
        name: "Codex",
        status: "connected",
        detected: true,
        connected: true,
        hooks_installed: true,
        detail: "Live hooks connected",
      },
      {
        id: "opencode",
        name: "OpenCode",
        status: "detected",
        detected: true,
        connected: false,
        hooks_installed: false,
        detail: "Setup needed",
      },
    ],
    schedule: {
      supported: true,
      jobs: [
        {
          id: "selftune-sync",
          label: "Sync telemetry",
          schedule: "*/30 * * * *",
          default_schedule: "*/30 * * * *",
          enabled: true,
          active: true,
        },
        {
          id: "selftune-status",
          label: "Daily health report",
          schedule: "0 8 * * *",
          default_schedule: "0 8 * * *",
          enabled: false,
          active: false,
        },
      ],
    },
  },
};

describe("desktop tray state", () => {
  it("summarizes health and harness connectivity", () => {
    expect(statusLabel(remoteState)).toBe("SelfTune: 3 reviews needed");
    expect(harnessSummary(remoteState.settings)).toBe("Harnesses: 1 connection");
    expect(remoteLibrarySummary(remoteState.settings)).toBe("Sync & Backup: Not configured");
    expect(
      remoteLibrarySummary({
        ...remoteState.settings,
        remote_library: { configured: true, url: "https://api.selftune.dev" },
      }),
    ).toBe("Sync & Backup: SelfTune Cloud");
    expect(
      remoteLibrarySummary({
        ...remoteState.settings,
        remote_library: { configured: true, url: "https://selftune.internal.example" },
      }),
    ).toBe("Sync & Backup: Self-hosted");
  });

  it("humanizes every supported schedule shape", () => {
    expect(humanizeSchedule("*/30 * * * *")).toBe("Every 30 minutes");
    expect(humanizeSchedule("0 */1 * * *")).toBe("Every hour");
    expect(humanizeSchedule("0 */6 * * *")).toBe("Every 6 hours");
    expect(humanizeSchedule("0 18 * * *")).toBe("Daily at 6:00 PM");
  });

  it("toggles one job while preserving every schedule", () => {
    expect(toggleScheduleJob(remoteState.settings, "selftune-status")).toEqual({
      jobs: [
        { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
        { id: "selftune-status", enabled: true, schedule: "0 8 * * *" },
      ],
    });
  });
});
