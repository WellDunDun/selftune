import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { autoUpdate, isAutoUpdateSkipped } from "../../cli/selftune/auto-update.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.SELFTUNE_SKIP_AUTO_UPDATE;
  delete process.env.SELFTUNE_SKIP_UPDATE_CHECK;
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

describe("auto-update skip controls", () => {
  test("honors legacy source-smoke skip env", () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "1";

    expect(isAutoUpdateSkipped()).toBe(true);
  });

  test("honors explicit update-check skip env", () => {
    process.env.SELFTUNE_SKIP_UPDATE_CHECK = "true";

    expect(isAutoUpdateSkipped()).toBe(true);
  });

  test("treats false-like values as disabled", () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "0";
    process.env.SELFTUNE_SKIP_UPDATE_CHECK = "false";

    expect(isAutoUpdateSkipped()).toBe(false);
  });

  test("skip env avoids registry calls", async () => {
    process.env.SELFTUNE_SKIP_AUTO_UPDATE = "1";
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as typeof fetch;

    await autoUpdate();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
