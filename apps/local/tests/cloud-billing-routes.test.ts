import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Schema from "effect/Schema";
import { jsonRequest } from "../../../tests/helpers/json-request.js";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";

const billingStatus = {
  plan: "free" as const,
  subscriptionStatus: "none" as const,
  currentPeriodEnd: null,
  trialEnd: null,
  seatCount: 1,
  hasStripeCustomer: false,
  canManageBilling: true,
  availablePlans: [],
};

describe("Cloud billing application routes", () => {
  test("maps status, checkout, portal, and finalize through DashboardOperations", async () => {
    const calls: Array<{ action: string; input?: unknown }> = [];
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        cloudBillingAction: (action, input) => {
          calls.push({ action, input });
          if (action === "status") return billingStatus;
          if (action === "checkout" || action === "portal") {
            return { url: "https://billing.stripe.test/session" };
          }
          return {
            finalized: true,
            billing: billingStatus,
            sessionStatus: "complete",
            paymentStatus: "paid",
          };
        },
      }),
    );
    const request = async (path: string, body?: typeof Schema.Json.Type) => {
      const next = jsonRequest(
        `${origin}${path}`,
        body === undefined ? "GET" : "POST",
        body,
        body === undefined ? undefined : origin,
      );
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* DashboardOperations;
          return yield* handleDashboardApplicationRoute(next, new URL(next.url), {
            allowedOrigins: new Set([origin]),
          });
        }),
      );
    };

    try {
      const status = await request("/api/v2/settings/billing/status");
      const checkout = await request("/api/v2/settings/billing/checkout", {
        plan: "team",
        seats: 7,
      });
      const portal = await request("/api/v2/settings/billing/portal", {});
      const finalize = await request("/api/v2/settings/billing/checkout/finalize", {
        session_id: "cs_test_123",
      });

      for (const response of [status, checkout, portal, finalize]) {
        expect(response).not.toBeNull();
        expect(response?.status).toBe(200);
      }
      expect(calls).toEqual([
        { action: "status", input: undefined },
        { action: "checkout", input: { plan: "team", seats: 7 } },
        { action: "portal", input: undefined },
        { action: "finalize", input: { sessionId: "cs_test_123" } },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("requires a same-origin request for billing mutations", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        cloudBillingAction: () => {
          called = true;
          return billingStatus;
        },
      }),
    );
    try {
      const request = new Request(`${origin}/api/v2/settings/billing/portal`, { method: "POST" });
      const response = await runtime.runPromise(
        Effect.gen(function* () {
          yield* DashboardOperations;
          return yield* handleDashboardApplicationRoute(request, new URL(request.url), {
            allowedOrigins: new Set([origin]),
          });
        }),
      );
      expect(response?.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
