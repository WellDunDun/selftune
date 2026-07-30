/* oxlint-disable no-await-in-loop -- replay-state bounds require sequential terminal attempts */
import { describe, expect, it } from "bun:test";

import {
  createDesktopInstallBootstrapController,
  parseDesktopInstallHandoff,
  type DesktopRecipientPreview,
} from "./desktop-install-bootstrap";

const TOKEN = "A".repeat(43);
const SECOND_TOKEN = "B".repeat(43);

const REMOTE_PREVIEW: DesktopRecipientPreview = {
  invitationId: "11111111-1111-4111-8111-111111111111",
  shareId: "22222222-2222-4222-8222-222222222222",
  distributionId: "33333333-3333-4333-8333-333333333333",
  sealedObjectId: "44444444-4444-4444-8444-444444444444",
  packagedSha256: "a".repeat(64),
  termsDisclosureSha256: "b".repeat(64),
  termsAcceptance: "accepted",
  contributorSignals: {
    _tag: "signals_unavailable",
    signalDisclosureSha256: "c".repeat(64),
    signalRecipientOrganizationId: null,
    allowedFields: [],
    capability: "not_capable",
    defaultState: "off",
    contributorConsent: "not_applicable",
    enabled: false,
  },
  status: "preview",
  expiresAt: "2026-07-21T12:00:00.000Z",
  supportedTargetAgents: ["codex", "claude_code"],
  targetAgentSelectionRequired: true,
  scopeChoices: ["project", "global"],
  scopeSelectionRequired: true,
  installModeDefault: "copy",
  conflictPolicyChoices: ["prompt", "replace", "keep_both"],
  conflictPolicyDefault: "prompt",
  customPathPolicy: "unsupported_v1",
  automaticDesktopInstall: "not_authorized",
  automaticSkillInstall: "not_authorized",
};

function controllerFixture() {
  let now = 1_000;
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const requests: string[] = [];
  let resolution:
    | { readonly status: "preview"; readonly preview: DesktopRecipientPreview }
    | { readonly status: "unauthenticated" }
    | {
        readonly status: "error";
        readonly code: "expired" | "replay" | "forbidden" | "invalid" | "unavailable";
        readonly message: string;
      } = { status: "preview", preview: REMOTE_PREVIEW };
  const controller = createDesktopInstallBootstrapController({
    trustedBuild: true,
    now: () => now,
    schedule: (_delay, callback) => {
      const entry = { callback, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    resolvePreview: async (token) => {
      requests.push(token);
      return resolution;
    },
    detectAgents: async () => [
      { agent: "codex", evidence: ["codex config"] },
      { agent: "claude_code", evidence: [] },
    ],
  });
  return {
    controller,
    requests,
    scheduled,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    expireTimers() {
      for (const entry of scheduled) if (!entry.cancelled) entry.callback();
    },
    setResolution(next: typeof resolution) {
      resolution = next;
    },
  };
}

describe("Desktop install bootstrap handoff", () => {
  it("accepts only the exact opaque-token deep-link form", () => {
    expect(parseDesktopInstallHandoff(`selftune://install/${TOKEN}`)).toEqual({ token: TOKEN });

    for (const input of [
      `selftune://install/${TOKEN}?next=/tmp/skill`,
      `selftune://install/${TOKEN}#fragment`,
      `selftune://user:secret@install/${TOKEN}`,
      `selftune://install/${TOKEN}/extra`,
      `selftune://install/${"A".repeat(42)}`,
      `selftune://install/${"A".repeat(44)}`,
      `selftune://install/${"A".repeat(8_192)}`,
      `selftune://install/%${TOKEN}`,
      `selftune:///install/${TOKEN}`,
      `/tmp/${TOKEN}`,
      `https://selftune.dev/${TOKEN}`,
    ]) {
      expect(parseDesktopInstallHandoff(input)).toBeNull();
    }
  });

  it("rejects overflow without evicting an earlier pending handoff", () => {
    const fixture = controllerFixture();
    for (const character of ["A", "B", "C", "D"]) {
      expect(fixture.controller.ingestUrl(`selftune://install/${character.repeat(43)}`)).toEqual({
        accepted: true,
      });
    }
    expect(fixture.controller.ingestUrl(`selftune://install/${"E".repeat(43)}`)).toEqual({
      accepted: false,
      reason: "queue_full",
    });
  });

  it("feeds cold-start and forwarded argv through one bounded deduplicating queue", () => {
    const fixture = controllerFixture();

    expect(fixture.controller.ingestArgv(["SelfTune", `selftune://install/${TOKEN}`])).toEqual({
      accepted: true,
    });
    expect(fixture.controller.ingestUrl(`selftune://install/${TOKEN}`)).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(
      fixture.controller.ingestArgv([
        "SelfTune",
        `selftune://install/${SECOND_TOKEN}`,
        `selftune://install/${"C".repeat(43)}`,
      ]),
    ).toEqual({ accepted: false, reason: "multiple" });
    expect(fixture.controller.publicState()).toEqual({ status: "pending", resume: "preview" });
    expect(fixture.requests).toEqual([]);
  });

  it("wipes a pending token when its in-memory TTL elapses", () => {
    const fixture = controllerFixture();
    fixture.controller.ingestUrl(`selftune://install/${TOKEN}`);
    fixture.advance(4 * 60 * 1_000);
    fixture.expireTimers();

    expect(fixture.controller.publicState()).toEqual({ status: "idle" });
  });

  it("clears an unauthenticated handoff and requires reopening it after login", async () => {
    const fixture = controllerFixture();
    fixture.setResolution({ status: "unauthenticated" });
    fixture.controller.ingestUrl(`selftune://install/${TOKEN}`);

    expect(await fixture.controller.preview()).toEqual({
      status: "login_required",
      pending: false,
      resume: "reopen_install_link",
    });
    expect(fixture.controller.publicState()).toEqual({ status: "idle" });
    expect(fixture.requests).toEqual([TOKEN]);
    fixture.setResolution({ status: "preview", preview: REMOTE_PREVIEW });
    expect(fixture.controller.ingestUrl(`selftune://install/${TOKEN}`)).toEqual({
      accepted: true,
    });
  });

  it("resolves a trusted handoff into exact remote and unselected local preview state", async () => {
    const fixture = controllerFixture();
    fixture.controller.ingestUrl(`selftune://install/${TOKEN}`);

    expect(await fixture.controller.preview()).toEqual({
      status: "ready",
      remote: REMOTE_PREVIEW,
      local: {
        agentSuggestions: [{ agent: "codex", evidence: ["codex config"], selected: false }],
        scopeChoices: ["project", "global"],
        selectedAgents: [],
        selectedScope: null,
        installMode: "copy",
        confirmationRequired: true,
      },
    });
    expect(fixture.controller.publicState()).toEqual({ status: "idle" });
  });

  it("shows terminal errors without retaining or reflecting the token", async () => {
    const fixture = controllerFixture();
    fixture.setResolution({
      status: "error",
      code: "expired",
      message: `Expired ${TOKEN}`,
    });
    fixture.controller.ingestUrl(`selftune://install/${TOKEN}`);

    expect(await fixture.controller.preview()).toEqual({
      status: "error",
      code: "expired",
      message: "Expired [redacted]",
    });
    expect(fixture.controller.publicState()).toEqual({ status: "idle" });
  });

  it("coalesces concurrent renderer previews for one handoff", async () => {
    const fixture = controllerFixture();
    fixture.controller.ingestUrl(`selftune://install/${TOKEN}`);

    const [first, second] = await Promise.all([
      fixture.controller.preview(),
      fixture.controller.preview(),
    ]);
    expect(first).toEqual(second);
    expect(fixture.requests).toEqual([TOKEN]);
  });

  it("bounds digest replay markers and cancels every terminal timer", async () => {
    const fixture = controllerFixture();
    fixture.setResolution({ status: "error", code: "invalid", message: "invalid" });
    for (let index = 0; index < 100; index += 1) {
      const token = index.toString(36).padStart(43, "A");
      expect(fixture.controller.ingestUrl(`selftune://install/${token}`)).toEqual({
        accepted: true,
      });
      await fixture.controller.preview();
    }
    expect(fixture.scheduled.filter(({ cancelled }) => cancelled)).toHaveLength(100);
    expect(fixture.controller.ingestUrl(`selftune://install/${"0".padStart(43, "A")}`)).toEqual({
      accepted: true,
    });
    expect(
      fixture.controller.ingestUrl(`selftune://install/${(99).toString(36).padStart(43, "A")}`),
    ).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });

  it("rejects every intake and preview on an untrusted build", async () => {
    let resolutions = 0;
    const controller = createDesktopInstallBootstrapController({
      trustedBuild: false,
      resolvePreview: async () => {
        resolutions += 1;
        return { status: "preview", preview: REMOTE_PREVIEW };
      },
      detectAgents: async () => [],
    });
    expect(controller.ingestUrl(`selftune://install/${TOKEN}`)).toEqual({
      accepted: false,
      reason: "untrusted_build",
    });
    expect(controller.publicState()).toEqual({ status: "unavailable", reason: "untrusted_build" });
    expect(await controller.preview()).toMatchObject({ status: "error", code: "unavailable" });
    expect(resolutions).toBe(0);
  });
});
