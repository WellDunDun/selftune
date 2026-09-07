import { describe, expect, it, vi } from "vitest";

import {
  getOverviewWatchlistSyncKey,
  resolveOverviewWatchlistChange,
  resolveOverviewWatchlistLoad,
} from "./OverviewComparisonSurface";

describe("resolveOverviewWatchlistChange", () => {
  it("prefers an explicit watchlist change handler", () => {
    const explicit = vi.fn();
    const host = {
      mutations: {
        updateOverviewWatchlist: vi.fn(),
      },
    };

    expect(
      resolveOverviewWatchlistChange(
        {
          initialSkills: [],
          onChange: explicit,
        },
        host,
      ),
    ).toBe(explicit);
  });

  it("falls back to the host adapter watchlist action", () => {
    const hostAction = vi.fn();

    expect(
      resolveOverviewWatchlistChange(
        {
          initialSkills: ["selftune"],
        },
        {
          mutations: {
            updateOverviewWatchlist: hostAction,
          },
        },
      ),
    ).toBe(hostAction);
  });

  it("returns undefined when no mutation handler exists", () => {
    expect(resolveOverviewWatchlistChange(undefined, null)).toBeUndefined();
    expect(
      resolveOverviewWatchlistChange(
        {
          initialSkills: [],
        },
        {
          mutations: {},
        },
      ),
    ).toBeUndefined();
  });
});

describe("resolveOverviewWatchlistLoad", () => {
  it("returns the host adapter loader when present", () => {
    const hostLoader = vi.fn();

    expect(
      resolveOverviewWatchlistLoad({
        mutations: {
          getOverviewWatchlist: hostLoader,
        },
      }),
    ).toBe(hostLoader);
  });

  it("returns undefined when the host does not provide a loader", () => {
    expect(
      resolveOverviewWatchlistLoad({
        mutations: {},
      }),
    ).toBeUndefined();
  });
});

describe("getOverviewWatchlistSyncKey", () => {
  it("stays stable for value-equal arrays across rerenders", () => {
    expect(getOverviewWatchlistSyncKey(["alpha", "beta"])).toBe(
      getOverviewWatchlistSyncKey(["alpha", "beta"]),
    );
  });

  it("changes when the actual initial watchlist contents change", () => {
    expect(getOverviewWatchlistSyncKey(["alpha", "beta"])).not.toBe(
      getOverviewWatchlistSyncKey(["alpha", "gamma"]),
    );
  });
});
