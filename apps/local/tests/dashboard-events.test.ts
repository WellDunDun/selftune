import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceUpdateResources } from "@selftune/runtime/dashboard-reactivity";

import { createDashboardEventHub } from "../src/dashboard-events.js";

describe("DashboardEventHub", () => {
  test("broadcasts the semantic resources changed by a source update", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-dashboard-events-"));
    const hub = createDashboardEventHub({
      databasePath: join(root, "selftune.db"),
      actionStreamPath: join(root, "actions.jsonl"),
    });
    const reader = hub.response().body?.getReader();

    try {
      expect(reader).toBeDefined();
      await reader?.read();

      hub.broadcastUpdate(sourceUpdateResources.apply);

      const update = await reader?.read();
      const payload = new TextDecoder().decode(update?.value);
      expect(payload).toContain("event: update");
      expect(payload).toContain(
        '"resources":["library-inventory","library-detail","skill-intelligence","overview"',
      );
      expect(payload).toContain('"source-update"');
      expect(payload).toContain('"projects"');
    } finally {
      await reader?.cancel();
      hub.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
