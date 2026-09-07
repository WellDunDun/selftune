import { afterEach, expect, test } from "bun:test";
import { installFetchSpy } from "../helpers/fetch-spy.js";
import { runPostOrchestrateSideEffects } from "../../packages/orchestration/src/orchestrate/post-run.js";

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

test("post-orchestrate does not prepare telemetry when cloud credentials are unavailable", async () => {
  let fetchCalls = 0;
  restoreFetch = installFetchSpy(async () => {
    fetchCalls++;
    throw new Error("unexpected network");
  });
  const result = {};
  await runPostOrchestrateSideEffects({
    result,
    dryRun: false,
    readAlphaIdentity: () => ({
      enrolled: true,
      user_id: "test",
      consent_timestamp: "2026-09-05T00:00:00Z",
    }),
    resolveCloudCredential: () => {
      throw new Error("credential unavailable");
    },
  });
  expect(fetchCalls).toBe(0);
  expect(result).toEqual({});
});

test("unenrolled local orchestration does not resolve cloud credentials", async () => {
  let lookups = 0;
  const result = {};
  await runPostOrchestrateSideEffects({
    result,
    dryRun: false,
    readAlphaIdentity: () => null,
    resolveCloudCredential: () => {
      lookups++;
      return null;
    },
  });
  expect(lookups).toBe(0);
  expect(result).toEqual({});
});
