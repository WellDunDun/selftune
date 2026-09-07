import { expect, test } from "bun:test";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

const origin = "http://127.0.0.1:3141";

test.each([true, false])(
  "preserves Skill Set error status and headers (read-only=%s)",
  async (readOnly) => {
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer(
        readOnly ? { skillSetsLoader: () => ({ sets: [], receipts: [] }) } : {},
      ),
    );
    const request = new Request(`${origin}/api/v2/skill-sets/unknown`, {
      method: "POST",
      headers: { Origin: origin },
      body: "{}",
    });
    try {
      const response = await runtime.runPromise(
        handleDashboardApplicationRoute(request, new URL(request.url), {
          allowedOrigins: new Set([origin]),
        }),
      );
      expect(response?.status).toBe(readOnly ? 405 : 404);
      expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      if (readOnly) expect(response?.headers.get("Allow")).toBe("GET");
      expect(await response?.json()).toMatchObject({
        error: { code: readOnly ? "READ_ONLY_HOST" : "NOT_FOUND" },
      });
    } finally {
      await runtime.dispose();
    }
  },
);
