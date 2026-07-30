import { describe, expect, it } from "bun:test";

import {
  createDesktopRecipientPreviewResolver,
  loadSecureDesktopCloudSession,
} from "./desktop-recipient-preview";
import type { DesktopRecipientPreview } from "./desktop-install-bootstrap";

const TOKEN = "A".repeat(43);
const PREVIEW: DesktopRecipientPreview = {
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
  supportedTargetAgents: ["codex"],
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

describe("Desktop recipient preview client", () => {
  it("sends the opaque token only to the authenticated configured HTTPS SelfTune origin", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const resolve = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://api.selftune.dev", accessToken: "secret-key" }),
      fetch: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return Response.json(PREVIEW);
      },
    });

    expect(await resolve(TOKEN)).toEqual({ status: "preview", preview: PREVIEW });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.selftune.dev/api/v1/recipient-actions/desktop/preview",
    );
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer secret-key");
    expect(requests[0]?.init.redirect).toBe("manual");
    expect(requests[0]?.init.credentials).toBe("omit");
    expect(requests[0]?.init.body).toBe(JSON.stringify({ bootstrapToken: TOKEN }));
  });

  it("fails closed on redirect, non-SelfTune origins, and response shape drift", async () => {
    const redirect = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://api.selftune.dev", accessToken: "secret-key" }),
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    });
    expect(await redirect(TOKEN)).toMatchObject({ status: "error", code: "unavailable" });

    const wrongOrigin = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://selftune.dev.evil.test", accessToken: "secret-key" }),
      fetch: async () => Response.json(PREVIEW),
    });
    expect(await wrongOrigin(TOKEN)).toMatchObject({ status: "error", code: "unavailable" });

    const drift = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://api.selftune.dev", accessToken: "secret-key" }),
      fetch: async () => Response.json({ ...PREVIEW, bootstrapToken: TOKEN }),
    });
    expect(await drift(TOKEN)).toMatchObject({ status: "error", code: "invalid" });

    const oversized = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://api.selftune.dev", accessToken: "secret-key" }),
      fetch: async () => new Response("x".repeat(64 * 1_024 + 1)),
    });
    expect(await oversized(TOKEN)).toMatchObject({ status: "error", code: "unavailable" });
  });

  it("loads cloud credentials only through supported OS secure stores", () => {
    const baseConfig = {
      alpha: {
        enrolled: true,
        user_id: "user",
        consent_timestamp: "2026-07-21T00:00:00.000Z",
        cloud_api_url: "https://api.selftune.dev",
        credential: { provider: "macos-keychain" as const, account: "account" },
      },
    };
    const getCalls: string[] = [];
    expect(
      loadSecureDesktopCloudSession("/config/config.json", {
        loadConfig: () => baseConfig,
        getCredential: (reference) => {
          getCalls.push(reference.account);
          return "secret-key";
        },
      }),
    ).toEqual({ origin: "https://api.selftune.dev", accessToken: "secret-key" });
    expect(getCalls).toEqual(["account"]);

    expect(
      loadSecureDesktopCloudSession("/config/config.json", {
        loadConfig: () => ({
          ...baseConfig,
          alpha: {
            ...baseConfig.alpha,
            credential: { provider: "file" as const, account: "plain-file" },
          },
        }),
        getCredential: () => "must-not-be-read",
      }),
    ).toBeNull();
  });

  it("reports missing or rejected authentication without retrying", async () => {
    const missing = createDesktopRecipientPreviewResolver({
      loadSession: () => null,
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(await missing(TOKEN)).toEqual({ status: "unauthenticated" });

    const rejected = createDesktopRecipientPreviewResolver({
      loadSession: () => ({ origin: "https://api.selftune.dev", accessToken: "stale" }),
      fetch: async () => Response.json({}, { status: 401 }),
    });
    expect(await rejected(TOKEN)).toEqual({ status: "unauthenticated" });
  });
});
