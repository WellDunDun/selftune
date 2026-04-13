import { afterEach, describe, expect, mock, test } from "bun:test";

import type { QueueItem, QueueOperations } from "../../cli/selftune/alpha-upload-contract.js";
import { uploadPushPayload } from "../../cli/selftune/alpha-upload/client.js";
import { flushQueue } from "../../cli/selftune/alpha-upload/flush.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "2.0",
    push_id: "test-push-id",
    client_version: "0.2.7",
    normalizer_version: "1.0.0",
    canonical: {
      sessions: [],
      prompts: [],
      skill_invocations: [],
      execution_facts: [],
      normalization_runs: [],
      evolution_evidence: [],
    },
    ...overrides,
  };
}

function makeQueueItem(id: number, overrides?: Partial<QueueItem>): QueueItem {
  const payload = makePayload();
  return {
    id,
    payload_type: "push",
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    payload_json: JSON.stringify(payload),
    ...overrides,
  };
}

function createMockQueue(
  items: QueueItem[],
): QueueOperations & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    getPending: [],
    markSending: [],
    markSent: [],
    markFailed: [],
  };

  let pendingItems = [...items];

  return {
    calls,
    getPending(limit: number): QueueItem[] {
      calls.getPending.push([limit]);
      const result = pendingItems.filter((i) => i.status === "pending").slice(0, limit);
      pendingItems = pendingItems.filter((i) => !result.some((r) => r.id === i.id));
      return result;
    },
    markSending(id: number): boolean {
      calls.markSending.push([id]);
      return true;
    },
    markSent(id: number): boolean {
      calls.markSent.push([id]);
      return true;
    },
    markFailed(id: number, error?: string): boolean {
      calls.markFailed.push([id, error]);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// uploadPushPayload tests
// ---------------------------------------------------------------------------

describe("uploadPushPayload", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns success result on 200 response", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ success: true, push_id: "test-push-id", errors: [] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("treats 201 accepted cloud response as success", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            status: "accepted",
            push_id: "accepted-push-id",
            canonical_sessions_written: 1,
          }),
          { status: 201 },
        ),
    ) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(true);
    expect(result.push_id).toBe("accepted-push-id");
    expect(result.errors).toEqual([]);
    expect(result._status).toBe(201);
  });

  test("sends correct headers without API key", async () => {
    const payload = makePayload();
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await uploadPushPayload(payload, "https://api.example.com/api/v1/push");

    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["user-agent"]).toMatch(/^selftune\//);
    expect(capturedHeaders.authorization).toBeUndefined();
  });

  test("sends Authorization header when API key is provided", async () => {
    const payload = makePayload();
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await uploadPushPayload(payload, "https://api.example.com/api/v1/push", "my-secret-key");

    expect(capturedHeaders.authorization).toBe("Bearer my-secret-key");
  });

  test("sends POST with JSON body containing schema_version 2.0", async () => {
    const payload = makePayload();
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await uploadPushPayload(payload, "https://api.example.com/api/v1/push");

    expect(capturedMethod).toBe("POST");
    if (capturedBody === undefined) {
      throw new Error("fetch was not called - capturedBody is undefined");
    }
    const parsed = JSON.parse(capturedBody);
    expect(parsed.schema_version).toBe("2.0");
    expect(parsed.canonical).toBeDefined();
  });

  test("returns error result on invalid JSON response shape", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ success: "yes", errors: "nope" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Invalid JSON response shape");
  });

  test("returns error result on 4xx response", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(
      async () => new Response("Bad Request", { status: 400 }),
    ) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns error result on 5xx response", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(
      async () => new Response("Internal Server Error", { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns error result on network failure without throwing", async () => {
    const payload = makePayload();
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const result = await uploadPushPayload(payload, "https://api.example.com/api/v1/push");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Network unreachable");
  });
});

// ---------------------------------------------------------------------------
// flushQueue tests
// ---------------------------------------------------------------------------

describe("flushQueue", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns zero summary when queue is empty", async () => {
    const queue = createMockQueue([]);
    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push");
    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, skipped_unchanged: 0 });
  });

  test("uploads all pending items on success", async () => {
    const items = [makeQueueItem(1), makeQueueItem(2), makeQueueItem(3)];
    const queue = createMockQueue(items);

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push");

    expect(summary.sent).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(queue.calls.markSending.length).toBe(3);
    expect(queue.calls.markSent.length).toBe(3);
  });

  test("treats 409 (duplicate push_id) as success", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);

    globalThis.fetch = mock(
      async () => new Response("Conflict: duplicate push_id", { status: 409 }),
    ) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 3,
    });

    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(0);
    expect(queue.calls.markSent.length).toBe(1);
  });

  test("treats 401 as non-retryable auth error", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 3,
    });

    expect(summary.failed).toBe(1);
    expect(callCount).toBe(1); // No retries
    expect(queue.calls.markFailed.length).toBe(1);
    const firstFailure = queue.calls.markFailed[0];
    expect(firstFailure).toBeDefined();
    if (!firstFailure) {
      throw new Error("queue.markFailed was not called");
    }
    const errorMsg = firstFailure[1] as string;
    expect(errorMsg).toContain("Authentication failed");
    expect(errorMsg).toContain("API key");
  });

  test("treats 403 as non-retryable auth error", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 3,
    });

    expect(summary.failed).toBe(1);
    expect(callCount).toBe(1); // No retries
    const firstFailure = queue.calls.markFailed[0];
    expect(firstFailure).toBeDefined();
    if (!firstFailure) {
      throw new Error("queue.markFailed was not called");
    }
    const errorMsg = firstFailure[1] as string;
    expect(errorMsg).toContain("Authorization denied");
    expect(errorMsg).toContain("selftune doctor");
  });

  test("passes API key through to uploadPushPayload", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await flushQueue(queue, "https://api.example.com/api/v1/push", {
      apiKey: "test-api-key",
    });

    expect(capturedHeaders.authorization).toBe("Bearer test-api-key");
  });

  test("marks items as failed when upload fails", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);

    globalThis.fetch = mock(
      async () => new Response("Server Error", { status: 500 }),
    ) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 1,
    });

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(queue.calls.markFailed.length).toBeGreaterThanOrEqual(1);
  });

  test("skips items that already exceeded max attempts", async () => {
    const items = [makeQueueItem(1, { attempts: 5 })];
    const queue = createMockQueue(items);

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 5,
    });

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(queue.calls.markSending.length).toBe(0);
    expect(queue.calls.markFailed.length).toBe(1);
  });

  test("respects batchSize option", async () => {
    const items = [makeQueueItem(1), makeQueueItem(2), makeQueueItem(3)];
    const queue = createMockQueue(items);

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    await flushQueue(queue, "https://api.example.com/api/v1/push", { batchSize: 2 });

    expect(queue.calls.getPending[0]?.[0]).toBe(2);
  });

  test("dry-run mode does not make HTTP calls", async () => {
    const items = [makeQueueItem(1), makeQueueItem(2)];
    const queue = createMockQueue(items);
    let fetchCallCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      dryRun: true,
    });

    expect(fetchCallCount).toBe(0);
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(queue.calls.markSent.length).toBe(0);
    expect(queue.calls.markFailed.length).toBe(0);
  });

  test("retries with backoff on transient failure then succeeds", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 3,
    });

    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(0);
    expect(callCount).toBe(2);
  });

  test("does not retry on 4xx client errors (except 401/403/409)", async () => {
    const items = [makeQueueItem(1)];
    const queue = createMockQueue(items);
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    }) as unknown as typeof fetch;

    const summary = await flushQueue(queue, "https://api.example.com/api/v1/push", {
      maxRetries: 3,
    });

    expect(summary.failed).toBe(1);
    expect(callCount).toBe(1);
  });
});
