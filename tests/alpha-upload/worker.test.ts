import { describe, expect, test } from "bun:test";

import type { FlushSummary } from "../../packages/runtime/alpha-upload-contract.js";
import {
  createCompatibilityExportWorker,
  type CompatibilityExportTimer,
} from "../../packages/runtime/alpha-upload/worker.js";

const summary = (sent = 0): FlushSummary => ({
  sent,
  failed: 0,
  skipped: 0,
  skipped_unchanged: 0,
});

function deferred<A>(): {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
} {
  let resolve: ((value: A) => void) | undefined;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) throw new Error("deferred resolver was not initialized");
  return { promise, resolve };
}

function timerHarness(): {
  readonly timer: CompatibilityExportTimer;
  readonly runNext: () => void;
  readonly scheduled: () => number;
} {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    timer: {
      schedule(callback: () => void): number {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(handle: unknown): void {
        if (typeof handle === "number") callbacks.delete(handle);
      },
    },
    runNext(): void {
      const entry = callbacks.entries().next().value;
      if (entry === undefined) return;
      const [id, callback] = entry;
      callbacks.delete(id);
      callback();
    },
    scheduled: () => callbacks.size,
  };
}

describe("compatibility export worker", () => {
  test("shares a single bounded attempt across overlapping requests", async () => {
    const gate = deferred<FlushSummary>();
    let calls = 0;
    const worker = createCompatibilityExportWorker({
      flush: async () => {
        calls++;
        return await gate.promise;
      },
      timer: timerHarness().timer,
    });

    worker.start();
    const second = worker.requestFlush();
    expect(calls).toBe(1);
    expect(worker.status().state).toBe("flushing");

    gate.resolve(summary(1));
    expect(await second).toEqual(summary(1));
    expect(worker.status().state).toBe("idle");
    await worker.stop();
  });

  test("schedules only one later attempt and a completed batch is bounded", async () => {
    const harness = timerHarness();
    const batchSizes: number[] = [];
    const worker = createCompatibilityExportWorker({
      batchSize: 7,
      flush: async ({ batchSize }) => {
        batchSizes.push(batchSize);
        return summary();
      },
      timer: harness.timer,
    });

    worker.start();
    await worker.requestFlush();
    expect(batchSizes).toEqual([7]);
    expect(harness.scheduled()).toBe(1);

    harness.runNext();
    await worker.requestFlush();
    expect(batchSizes).toEqual([7, 7]);
    expect(harness.scheduled()).toBe(1);
    await worker.stop();
  });

  test("stop aborts an in-flight remote attempt and prevents a new schedule", async () => {
    const gate = deferred<FlushSummary>();
    const harness = timerHarness();
    let aborted = false;
    const worker = createCompatibilityExportWorker({
      flush: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          gate.resolve(summary());
        });
        return await gate.promise;
      },
      timer: harness.timer,
    });

    worker.start();
    await worker.stop();
    expect(aborted).toBe(true);
    expect(worker.status().state).toBe("stopped");
    expect(harness.scheduled()).toBe(0);
  });

  test("a transient worker failure is retained as status and later attempts continue", async () => {
    const harness = timerHarness();
    let calls = 0;
    const worker = createCompatibilityExportWorker({
      flush: async () => {
        calls++;
        if (calls === 1) throw new Error("network unavailable");
        return summary(1);
      },
      timer: harness.timer,
    });

    worker.start();
    await worker.requestFlush();
    expect(worker.status().lastError).toBe("network unavailable");
    expect(harness.scheduled()).toBe(1);

    harness.runNext();
    await Promise.resolve();
    expect(worker.status().lastSummary).toEqual(summary(1));
    await worker.stop();
  });
});
