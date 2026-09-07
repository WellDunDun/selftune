import { describe, expect, test } from "bun:test";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Schema from "effect/Schema";
import { jsonRequest } from "../../../tests/helpers/json-request.js";

import type {
  PluginInventoryModel,
  PluginManagementInputModel,
} from "@selftune/dashboard-core/models";
import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";
const inventory: PluginInventoryModel = {
  hosts: [],
  plugins: [],
  totalPlugins: 0,
  managedPlugins: 0,
  refreshedAt: "2026-08-11T09:30:00.000Z",
};

function routeRequest(
  runtime: ManagedRuntime.ManagedRuntime<DashboardOperations, never>,
  path: string,
  body?: typeof Schema.Json.Type,
  includeOrigin = true,
) {
  const request = jsonRequest(
    `${origin}${path}`,
    body === undefined ? "GET" : "POST",
    body,
    includeOrigin ? origin : undefined,
  );
  return runtime.runPromise(
    handleDashboardApplicationRoute(request, new URL(request.url), {
      allowedOrigins: new Set([origin]),
    }),
  );
}

describe("Plugin management application routes", () => {
  test("keeps CORS on malformed JSON errors without invoking the host", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        pluginManager: (input) => {
          called = true;
          return { ...input, completedAt: "2026-08-11T09:31:00.000Z", inventory };
        },
      }),
    );
    const request = new Request(`${origin}/api/v2/plugins/manage`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{",
    });
    try {
      const response = await runtime.runPromise(
        handleDashboardApplicationRoute(request, new URL(request.url), {
          allowedOrigins: new Set([origin]),
        }),
      );
      expect(response?.status).toBe(400);
      expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test("loads inventory and maps an explicit host action", async () => {
    const calls: PluginManagementInputModel[] = [];
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        pluginInventoryLoader: () => inventory,
        pluginManager: (input) => {
          calls.push(input);
          return {
            ...input,
            completedAt: "2026-08-11T09:31:00.000Z",
            inventory,
          };
        },
      }),
    );

    try {
      const loaded = await routeRequest(runtime, "/api/v2/plugins");
      const managed = await routeRequest(runtime, "/api/v2/plugins/manage", {
        host: "claude",
        plugin_id: "paper-desktop@paper",
        action: "disable",
      });

      expect(await loaded?.json()).toEqual(inventory);
      expect(managed?.status).toBe(200);
      expect(loaded?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(managed?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(calls).toEqual([
        { host: "claude", pluginId: "paper-desktop@paper", action: "disable" },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  test("rejects a plugin mutation without same-origin proof", async () => {
    let called = false;
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({
        pluginManager: (input) => {
          called = true;
          return { ...input, completedAt: "2026-08-11T09:31:00.000Z", inventory };
        },
      }),
    );

    try {
      const response = await routeRequest(
        runtime,
        "/api/v2/plugins/manage",
        { host: "codex", plugin_id: "paper-desktop@paper", action: "remove" },
        false,
      );
      expect(response?.status).toBe(403);
      expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(called).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
