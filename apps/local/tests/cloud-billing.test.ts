import { describe, expect, test } from "bun:test";

import type { RemoteLibraryConfig } from "@selftune/library/remote/config";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { makeCloudBillingOperations } from "../src/cloud-billing.js";

const preferences = {
  releasedSkills: true,
  drafts: false,
  skillSets: true,
  metadata: true,
  decisionHistory: true,
};

function cloudConfig(url = "https://cloud.selftune.dev"): RemoteLibraryConfig {
  return {
    version: 2,
    url,
    apiKey: "remote-library-secret",
    credentialProvider: "file",
    preferences,
  };
}

const billingStatus = {
  plan: "free",
  subscriptionStatus: "none",
  currentPeriodEnd: null,
  trialEnd: null,
  seatCount: 1,
  hasStripeCustomer: false,
  canManageBilling: true,
  availablePlans: [],
};

describe("Cloud billing sidecar transport", () => {
  test("uses the stored credential server-side on each canonical billing endpoint", async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        workspaceId: "workspace-1",
        plan: "free",
        status: "none",
        currentPeriodEnd: null,
      });
    };
    const billing = makeCloudBillingOperations("/unused", {
      fetch,
      loadRemoteLibraryConfig: () => cloudConfig(),
    });

    await billing.status();
    await expect(billing.checkout({ plan: "team", seats: 3 })).resolves.toEqual({
      url: "https://cloud.selftune.dev/?billing=team",
    });
    await expect(billing.portal()).resolves.toEqual({
      url: "https://cloud.selftune.dev/?billing=portal",
    });
    await billing.finalize({ sessionId: "cs_test_123" });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["GET /api/v1/desktop/state", "GET /api/v1/desktop/state"],
    );
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer remote-library-secret",
      ),
    ).toBe(true);
  });

  test("maps unreachable and invalid Cloud responses to retryable operational errors", async () => {
    const unreachable = makeCloudBillingOperations("/unused", {
      fetch: async () => {
        throw new Error("offline");
      },
      loadRemoteLibraryConfig: () => cloudConfig(),
    });
    await expect(unreachable.status()).rejects.toMatchObject({
      code: "API_ERROR",
      retryable: true,
    } satisfies Partial<CLIError>);

    const invalid = makeCloudBillingOperations("/unused", {
      fetch: async () => Response.json({ plan: "not-a-plan" }),
      loadRemoteLibraryConfig: () => cloudConfig(),
    });
    await expect(invalid.status()).rejects.toMatchObject({
      code: "API_ERROR",
      retryable: true,
    } satisfies Partial<CLIError>);
  });

  test("explains when the connected Cloud deployment has no billing API", async () => {
    const missing = makeCloudBillingOperations("/unused", {
      fetch: async () => new Response("404 Not Found", { status: 404 }),
      loadRemoteLibraryConfig: () => cloudConfig(),
    });

    await expect(missing.status()).rejects.toMatchObject({
      code: "API_ERROR",
      message: "The connected SelfTune Cloud deployment does not expose billing yet.",
      suggestion: "Deploy the current Cloud API, then retry.",
      retryable: false,
    } satisfies Partial<CLIError>);
  });

  test("preserves structured Cloud billing failures", async () => {
    const unavailable = makeCloudBillingOperations("/unused", {
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "invalid_stripe_configuration",
              message: "Stripe billing is not configured",
              status: 503,
            },
          },
          { status: 503 },
        ),
      loadRemoteLibraryConfig: () => cloudConfig(),
    });

    await expect(unavailable.status()).rejects.toMatchObject({
      code: "API_ERROR",
      message: "Stripe billing is not configured",
      suggestion: "Retry in a moment.",
      retryable: true,
    } satisfies Partial<CLIError>);
  });

  test("rejects self-hosted Remote Library credentials before making a billing request", async () => {
    let called = false;
    const billing = makeCloudBillingOperations("/unused", {
      fetch: async () => {
        called = true;
        return Response.json(billingStatus);
      },
      loadRemoteLibraryConfig: () => cloudConfig("https://selftune.example.com"),
    });
    await expect(billing.status()).rejects.toMatchObject({ code: "CONFIG_MISSING" });
    expect(called).toBe(false);
  });
});
