import { describe, expect, it } from "vitest";

import { BillingCheckoutInput, BillingStatus, createCloudApiClient, decodeUnknown } from "../index";

const billingStatus = {
  plan: "free",
  subscriptionStatus: "none",
  currentPeriodEnd: null,
  trialEnd: null,
  seatCount: 1,
  hasStripeCustomer: false,
  canManageBilling: true,
  availablePlans: [
    {
      id: "free",
      name: "Community",
      price: "$0",
      period: "forever",
      description: "For individual developers",
      features: ["Five skills"],
      highlighted: false,
      seats: null,
    },
    {
      id: "team",
      name: "Team",
      price: "$49",
      period: "/month",
      description: "For teams",
      features: ["Unlimited skills"],
      highlighted: true,
      seats: { minimum: 1, label: "Seats" },
    },
  ],
};

function jsonFetch(
  respond: (request: Request) => Response | Promise<Response>,
  requests: Request[],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
}

describe("billing contract", () => {
  it("rejects invalid Stripe states and non-positive seat counts", () => {
    expect(
      decodeUnknown(BillingStatus, { ...billingStatus, subscriptionStatus: "pending" }).success,
    ).toBe(false);
    expect(decodeUnknown(BillingStatus, { ...billingStatus, seatCount: 0 }).success).toBe(false);
    expect(decodeUnknown(BillingCheckoutInput, { plan: "enterprise" }).success).toBe(false);
    expect(decodeUnknown(BillingCheckoutInput, { plan: "team", seats: 0 }).success).toBe(false);
    expect(
      decodeUnknown(BillingStatus, {
        ...billingStatus,
        availablePlans: [
          { ...billingStatus.availablePlans[1], seats: { minimum: 0, label: null } },
        ],
      }).success,
    ).toBe(false);
  });

  it("wires billing methods through the generated client with validated responses", async () => {
    const requests: Request[] = [];
    const finalized = {
      finalized: true,
      billing: billingStatus,
      sessionStatus: "complete",
      paymentStatus: "paid",
    };
    const client = createCloudApiClient({
      baseUrl: "https://cloud.selftune.dev",
      fetch: jsonFetch((request) => {
        if (request.url.endsWith("/status")) return Response.json(billingStatus);
        if (request.url.endsWith("/checkout/finalize")) {
          return Response.json(finalized);
        }
        return Response.json({ url: "https://checkout.stripe.com/session" });
      }, requests),
    });

    await expect(client.billingStatus()).resolves.toEqual(billingStatus);
    await expect(client.createBillingCheckout({ plan: "team", seats: 3 })).resolves.toEqual({
      url: "https://checkout.stripe.com/session",
    });
    await expect(client.createBillingPortal()).resolves.toEqual({
      url: "https://checkout.stripe.com/session",
    });
    await expect(client.finalizeBillingCheckout({ sessionId: "cs_test_123" })).resolves.toEqual(
      expect.objectContaining(finalized),
    );

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v1/cloud/billing/status",
      "POST /api/v1/cloud/billing/checkout",
      "POST /api/v1/cloud/billing/portal",
      "POST /api/v1/cloud/billing/checkout/finalize",
    ]);
    await expect(requests[1]?.json()).resolves.toEqual({ plan: "team", seats: 3 });
    await expect(requests[3]?.json()).resolves.toEqual({ sessionId: "cs_test_123" });
  });
});
