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
      actions: {
        updateOverviewWatchlist: vi.fn(),
      },
    };

    expect(
      resolveOverviewWatchlistChange(
        {
          initialSkills: [],
          onChange: explicit,
        },
        host as never,
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
          actions: {
            openUpgrade: vi.fn(),
            updateOverviewWatchlist: hostAction,
          },
        } as never,
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
          actions: {
            openUpgrade: vi.fn(),
          },
        } as never,
      ),
    ).toBeUndefined();
  });
});

describe("resolveOverviewWatchlistLoad", () => {
  it("returns the host adapter loader when present", () => {
    const hostLoader = vi.fn();

    expect(
      resolveOverviewWatchlistLoad({
        actions: {
          openUpgrade: vi.fn(),
          getOverviewWatchlist: hostLoader,
        },
      } as never),
    ).toBe(hostLoader);
  });

  it("returns undefined when the host does not provide a loader", () => {
    expect(
      resolveOverviewWatchlistLoad({
        actions: {
          openUpgrade: vi.fn(),
        },
      } as never),
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
