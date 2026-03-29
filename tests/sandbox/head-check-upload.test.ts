/**
 * Tests for HEAD-check-before-upload optimization in the alpha upload pipeline.
 *
 * Covers: headRecord() in client.ts, HEAD-based skip logic in flush.ts,
 * and skipped_unchanged count in FlushSummary.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import type { QueueItem, QueueOperations } from "../../cli/selftune/alpha-upload-contract.js";
import { headRecord } from "../../cli/selftune/alpha-upload/client.js";
import { flushQueue } from "../../cli/selftune/alpha-upload/flush.js";

// ---------------------------------------------------------------------------
// headRecord unit tests
// ---------------------------------------------------------------------------

describe("headRecord", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns exists=true, unchanged=false on 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as typeof fetch;

    const result = await headRecord("https://api.example.com/api/v2/canonical", "rec-1");
    expect(result).toEqual({ exists: true, unchanged: false });
  });

  it("returns exists=true, unchanged=true on 304", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 304 })),
    ) as typeof fetch;

    const result = await headRecord(
      "https://api.example.com/api/v2/canonical",
      "rec-1",
      "abc123sha",
    );
    expect(result).toEqual({ exists: true, unchanged: true });
  });

  it("returns exists=false, unchanged=false on 404", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as typeof fetch;

    const result = await headRecord("https://api.example.com/api/v2/canonical", "rec-1");
    expect(result).toEqual({ exists: false, unchanged: false });
  });

  it("returns exists=false, unchanged=false on network error (fail-open)", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;

    const result = await headRecord("https://api.example.com/api/v2/canonical", "rec-1");
    expect(result).toEqual({ exists: false, unchanged: false });
  });

  it("sends If-None-Match header when sha256 is provided", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;

    await headRecord("https://api.example.com/api/v2/canonical", "rec-1", "sha256value");
    expect(capturedHeaders?.get("If-None-Match")).toBe('"sha256value"');
  });

  it("uses HEAD method", async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;

    await headRecord("https://api.example.com/api/v2/canonical", "rec-1");
    expect(capturedMethod).toBe("HEAD");
  });

  it("returns exists=false on unexpected status like 500 (fail-open)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    ) as typeof fetch;

    const result = await headRecord("https://api.example.com/api/v2/canonical", "rec-1");
    expect(result).toEqual({ exists: false, unchanged: false });
  });
});

// ---------------------------------------------------------------------------
// flushQueue HEAD-check integration tests
// ---------------------------------------------------------------------------

describe("flushQueue with HEAD check", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeQueueItem(id: number, pushId: string): QueueItem {
    return {
      id,
      payload_type: "push",
      payload_json: JSON.stringify({ push_id: pushId, records: [] }),
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    };
  }

  function makeQueueOps(
    items: QueueItem[],
  ): QueueOperations & { sentIds: number[]; failedIds: number[] } {
    const sentIds: number[] = [];
    const failedIds: number[] = [];
    return {
      sentIds,
      failedIds,
      getPending: (limit: number) => items.slice(0, limit),
      markSending: () => true,
      markSent: (id: number) => {
        sentIds.push(id);
        return true;
      },
      markFailed: (id: number) => {
        failedIds.push(id);
        return true;
      },
    };
  }

  it("skips records that exist and are unchanged via HEAD check", async () => {
    const items = [makeQueueItem(1, "push-existing"), makeQueueItem(2, "push-new")];
    const ops = makeQueueOps(items);

    // HEAD for push-existing returns 304 (unchanged), HEAD for push-new returns 404
    // POST for push-new returns 200 success
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (init?.method === "HEAD") {
        if (url.includes("push-existing")) {
          return Promise.resolve(new Response(null, { status: 304 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      // POST
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, push_id: "push-new", errors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const summary = await flushQueue(ops, "https://api.example.com/api/v1/push", {
      headCheckEndpoint: "https://api.example.com/api/v2/canonical",
    });

    expect(summary.skipped_unchanged).toBe(1);
    expect(summary.sent).toBe(1);
    // Item 1 should be marked sent (skipped via HEAD), item 2 should be sent via POST
    expect(ops.sentIds).toContain(1);
    expect(ops.sentIds).toContain(2);
  });

  it("pushes all records when HEAD check fails (fail-open)", async () => {
    const items = [makeQueueItem(1, "push-1")];
    const ops = makeQueueOps(items);

    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, push_id: "push-1", errors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const summary = await flushQueue(ops, "https://api.example.com/api/v1/push", {
      headCheckEndpoint: "https://api.example.com/api/v2/canonical",
    });

    expect(summary.skipped_unchanged).toBe(0);
    expect(summary.sent).toBe(1);
  });

  it("does not run HEAD checks when headCheckEndpoint is not provided", async () => {
    const items = [makeQueueItem(1, "push-1")];
    const ops = makeQueueOps(items);

    let headCalled = false;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        headCalled = true;
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, push_id: "push-1", errors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const summary = await flushQueue(ops, "https://api.example.com/api/v1/push");

    expect(headCalled).toBe(false);
    expect(summary.sent).toBe(1);
    expect(summary.skipped_unchanged).toBe(0);
  });

  it("handles batch with mix of existing, unchanged, and new records", async () => {
    const items = [
      makeQueueItem(1, "push-unchanged"),
      makeQueueItem(2, "push-exists-changed"),
      makeQueueItem(3, "push-new"),
    ];
    const ops = makeQueueOps(items);

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (init?.method === "HEAD") {
        if (url.includes("push-unchanged")) {
          return Promise.resolve(new Response(null, { status: 304 }));
        }
        if (url.includes("push-exists-changed")) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      // POST
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, errors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const summary = await flushQueue(ops, "https://api.example.com/api/v1/push", {
      headCheckEndpoint: "https://api.example.com/api/v2/canonical",
    });

    // Only push-unchanged (304) should be skipped
    expect(summary.skipped_unchanged).toBe(1);
    // push-exists-changed (200 but not 304) and push-new (404) should be pushed
    expect(summary.sent).toBe(2);
  });
});
