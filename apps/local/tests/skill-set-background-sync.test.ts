import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { DashboardOperations, makeDashboardOperationsLayer } from "../src/dashboard-operations.js";
import { handleDashboardApplicationRoute } from "../src/routes/application.js";

describe("Skill Set background backup", () => {
  test("requests Sync & Backup only after local creation succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-sync-"));
    const runtime = ManagedRuntime.make(
      makeDashboardOperationsLayer({ skillSetConfigRoot: join(root, "config") }),
    );
    const skillPackage = join(root, "skills", "research");
    mkdirSync(skillPackage, { recursive: true });
    writeFileSync(
      join(skillPackage, "SKILL.md"),
      "---\nname: research\ndescription: Research a topic.\n---\n",
    );
    let syncRequests = 0;
    const origin = "http://127.0.0.1:3141";

    try {
      const request = new Request(`${origin}/api/v2/skill-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          name: "Cloud backed set",
          description: "Back this up after creation.",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: skillPackage }],
        }),
      });
      const response = await runtime.runPromise(
        Effect.gen(function* () {
          yield* DashboardOperations;
          return yield* handleDashboardApplicationRoute(request, new URL(request.url), {
            allowedOrigins: new Set([origin]),
            onSkillSetChanged: () => {
              syncRequests += 1;
            },
          });
        }),
      );

      expect(response).not.toBeNull();
      if (!response) throw new Error("Expected the Skill Set create route to respond.");
      expect(response.status).toBe(200);
      expect((await response.json()).name).toBe("Cloud backed set");
      expect(syncRequests).toBe(1);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
