// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAsyncAction } from "./loading-button";
import { useSortableRows } from "./sortable-table";

afterEach(cleanup);

describe("shared async actions", () => {
  it("accepts a typed result and prevents duplicate execution while pending", async () => {
    const completion = Promise.withResolvers<{ refreshed: number }>();
    const action = vi.fn(() => completion.promise);
    const { result } = renderHook(() => useAsyncAction({ action }));
    await act(async () => {
      result.current.run();
      result.current.run();
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("pending");
    await act(async () => {
      completion.resolve({ refreshed: 3 });
    });
    expect(result.current.status).toBe("success");
    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");
  });

  it("preserves a rejected cause and permits an explicit retry", async () => {
    const cause = new Error("Refresh failed");
    const onError = vi.fn();
    const action = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(7);
    const { result } = renderHook(() => useAsyncAction({ action, onError }));
    await act(async () => result.current.run());
    expect(result.current.status).toBe("error");
    expect(onError).toHaveBeenCalledWith(cause);
    await act(async () => result.current.run());
    expect(result.current.status).toBe("success");
  });
});

describe("column-owned sorting", () => {
  it("sorts signed decimal numbers numerically and leaves missing values last in both directions", () => {
    const rows = [
      { id: "missing", score: null },
      { id: "positive", score: 1.2 },
      { id: "negative", score: -2.5 },
      { id: "small", score: 1.11 },
      { id: "zero", score: 0 },
    ];
    const { result } = renderHook(() =>
      useSortableRows({
        rows,
        getRowId: (row) => row.id,
        columns: [{ id: "score", header: "Score", numeric: true, value: (row) => row.score }],
        defaultSort: { columnId: "score", direction: "asc" },
      }),
    );
    expect(result.current.ordered.map((entry) => entry.id)).toEqual([
      "negative",
      "zero",
      "small",
      "positive",
      "missing",
    ]);
    act(() => result.current.toggle("score"));
    expect(result.current.ordered.map((entry) => entry.id)).toEqual([
      "positive",
      "small",
      "zero",
      "negative",
      "missing",
    ]);
    act(() => result.current.toggle("score"));
    expect(result.current.ordered.map((entry) => entry.id)).toEqual(rows.map((row) => row.id));
  });

  it("sorts text naturally and retains original order for equal keys", () => {
    const rows = [
      { id: "ten", name: "Skill 10" },
      { id: "two-a", name: "Skill 2" },
      { id: "two-b", name: "Skill 2" },
    ];
    const { result } = renderHook(() =>
      useSortableRows({
        rows,
        getRowId: (row) => row.id,
        columns: [{ id: "name", header: "Name", value: (row) => row.name }],
        defaultSort: { columnId: "name", direction: "asc" },
      }),
    );
    expect(result.current.ordered.map((entry) => entry.id)).toEqual(["two-a", "two-b", "ten"]);
  });
});
