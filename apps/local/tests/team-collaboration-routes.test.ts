import { describe, expect, test } from "bun:test";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Schema from "effect/Schema";
import { jsonRequest } from "../../../tests/helpers/json-request.js";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";
const snapshot = { entries: [], contributions: [], installations: [] };

function routeRequest(
  runtime: ManagedRuntime.ManagedRuntime<DashboardOperations, never>,
  path: string,
  method: "GET" | "PATCH" | "POST" = "GET",
  body?: typeof Schema.Json.Type,
  includeOrigin = true,
) {
  const request = jsonRequest(`${origin}${path}`, method, body, includeOrigin ? origin : undefined);
  return runtime.runPromise(
    handleDashboardApplicationRoute(request, new URL(request.url), {
      allowedOrigins: new Set([origin]),
    }),
  );
}

describe("Team collaboration application routes", () => {
  test("maps access, snapshot, rollout, and review actions through DashboardOperations", async () => {
    const calls: Array<{ action: string; id?: string; policy?: string }> = [];
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        teamCollaborationAccessLoader: () => ({ currentRole: "admin", readOnly: false }),
        teamCollaborationSnapshotLoader: () => snapshot,
        teamCollaborationRolloutPolicyUpdater: (entryId, policy) => {
          calls.push({ action: "rollout", id: entryId, policy });
          return { entryId, policy };
        },
        teamCollaborationContributionDecider: (contributionId, action) => {
          calls.push({ action, id: contributionId });
          return { id: contributionId, status: action === "rollback" ? "rolled_back" : "adopted" };
        },
      }),
    );

    try {
      const access = await routeRequest(runtime, "/api/v2/team-collaboration/access");
      const loaded = await routeRequest(runtime, "/api/v2/team-collaboration");
      const rollout = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/registry/entry%2Fone/rollout-policy",
        "PATCH",
        { policy: "automatic" },
      );
      const adopt = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/contributions/candidate%20one/adopt",
        "POST",
      );
      const reject = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/contributions/candidate%20one/reject",
        "POST",
      );
      const rollback = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/contributions/candidate%20one/rollback",
        "POST",
      );

      expect(await access?.json()).toEqual({ currentRole: "admin", readOnly: false });
      expect(await loaded?.json()).toEqual(snapshot);
      for (const response of [rollout, adopt, reject, rollback]) {
        expect(response?.status).toBe(200);
      }
      expect(calls).toEqual([
        { action: "rollout", id: "entry/one", policy: "automatic" },
        { action: "adopt", id: "candidate one" },
        { action: "reject", id: "candidate one" },
        { action: "rollback", id: "candidate one" },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("fails closed before invoking a collaboration mutation without same-origin proof", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        teamCollaborationContributionDecider: (id) => {
          called = true;
          return { id, status: "adopted" };
        },
      }),
    );

    try {
      const response = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/contributions/candidate/adopt",
        "POST",
        undefined,
        false,
      );
      expect(response?.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test("validates rollout policy before invoking the Cloud transport", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        teamCollaborationRolloutPolicyUpdater: (entryId, policy) => {
          called = true;
          return { entryId, policy };
        },
      }),
    );

    try {
      const response = await routeRequest(
        runtime,
        "/api/v2/team-collaboration/registry/entry/rollout-policy",
        "PATCH",
        { policy: "surprise" },
      );
      expect(response?.status).toBe(400);
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
