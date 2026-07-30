import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { runPostOrchestrateSideEffects } from "../../packages/orchestration/src/orchestrate/post-run.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("post-orchestrate prepares locally while export credentials and fetch are unavailable", async () => {
  const database = new Database(":memory:");
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    return new Promise<Response>(() => undefined);
  };
  const result = {};

  try {
    await runPostOrchestrateSideEffects({
      result,
      database,
      dryRun: false,
      readAlphaIdentity: () => ({
        enrolled: true,
        user_id: "post-orchestrate-test-user",
        consent_timestamp: "2026-07-23T00:00:00.000Z",
      }),
      resolveCloudCredential: () => {
        throw new Error("credential store must not block compatibility preparation");
      },
      prepareCompatibilityExport: () => ({ enqueued: 1, withheld_unsupported_platform: 0 }),
    });

    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({
      uploadSummary: { enrolled: true, prepared: 1, sent: 0, failed: 0, skipped: 0 },
    });
  } finally {
    database.close();
  }
});
