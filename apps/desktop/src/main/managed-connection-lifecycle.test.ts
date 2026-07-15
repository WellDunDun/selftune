import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  replaceManagedConnection,
  type ManagedConnectionOperations,
  type ManagedConnectionTransitionFailure,
} from "./managed-connection-lifecycle";

interface FakeConnection {
  readonly id: string;
}

describe("managed desktop connection lifecycle", () => {
  it("detaches and awaits the current child before starting its replacement", async () => {
    const events: string[] = [];
    const previous = { id: "previous" };
    const replacement = { id: "replacement" };
    let current: FakeConnection | null = previous;

    const operations: ManagedConnectionOperations<FakeConnection, Error> = {
      current: Effect.sync(() => current),
      detach: (candidate) =>
        Effect.sync(() => {
          events.push(`detach:${candidate.id}`);
          if (current === candidate) current = null;
        }),
      stop: (candidate) =>
        Effect.promise(async () => {
          events.push(`stop:${candidate.id}:started`);
          await Promise.resolve();
          events.push(`stop:${candidate.id}:finished`);
        }),
      start: () =>
        Effect.suspend(() => {
          events.push("start:replacement");
          if (current !== null) return Effect.fail(new Error("singleton lock is still owned"));
          return Effect.succeed(replacement);
        }),
      activate: (candidate) =>
        Effect.sync(() => {
          events.push(`activate:${candidate.id}`);
          current = candidate;
        }),
    };

    const result = await Effect.runPromise(
      replaceManagedConnection(operations, {
        maxAttempts: 1,
        retryDelayMs: () => 0,
      }),
    );

    expect(result).toEqual({ attempt: 1, connection: replacement });
    expect(current).toBe(replacement);
    expect(events).toEqual([
      "stop:previous:started",
      "stop:previous:finished",
      "detach:previous",
      "start:replacement",
      "activate:replacement",
    ]);
  });

  it("retains ownership when the current child cannot be stopped", async () => {
    const previous = { id: "previous" };
    let current: FakeConnection | null = previous;
    let starts = 0;

    const operations: ManagedConnectionOperations<FakeConnection, Error> = {
      current: Effect.sync(() => current),
      detach: (candidate) =>
        Effect.sync(() => {
          if (current === candidate) current = null;
        }),
      stop: () => Effect.fail(new Error("child would not exit")),
      start: () =>
        Effect.sync(() => {
          starts += 1;
          return { id: "replacement" };
        }),
      activate: () => Effect.void,
    };

    await expect(
      Effect.runPromise(
        replaceManagedConnection(operations, {
          maxAttempts: 1,
          retryDelayMs: () => 0,
        }),
      ),
    ).rejects.toMatchObject({
      attempt: 0,
      phase: "stop-current",
      retryable: false,
    });
    expect(current).toBe(previous);
    expect(starts).toBe(0);
  });

  it("cleans up a failed candidate before a bounded recovery retry", async () => {
    const events: string[] = [];
    const failures: ManagedConnectionTransitionFailure[] = [];
    const previous = { id: "previous" };
    let current: FakeConnection | null = previous;
    let starts = 0;

    const operations: ManagedConnectionOperations<FakeConnection, Error> = {
      current: Effect.sync(() => current),
      detach: (candidate) =>
        Effect.sync(() => {
          events.push(`detach:${candidate.id}`);
          if (current === candidate) current = null;
        }),
      stop: (candidate) =>
        Effect.sync(() => {
          events.push(`stop:${candidate.id}`);
        }),
      start: () =>
        Effect.sync(() => {
          starts += 1;
          const candidate = { id: `candidate-${starts}` };
          events.push(`start:${candidate.id}`);
          return candidate;
        }),
      activate: (candidate) =>
        Effect.suspend(() => {
          events.push(`activate:${candidate.id}`);
          current = candidate;
          return candidate.id === "candidate-1"
            ? Effect.fail(new Error("window reload failed"))
            : Effect.void;
        }),
      onAttemptFailure: (failure) => Effect.sync(() => failures.push(failure)),
    };

    const result = await Effect.runPromise(
      replaceManagedConnection(operations, {
        maxAttempts: 3,
        retryDelayMs: () => 0,
      }),
    );

    expect(result.attempt).toBe(2);
    expect(current).toEqual({ id: "candidate-2" });
    expect(failures.map((failure) => [failure.attempt, failure.phase])).toEqual([[1, "activate"]]);
    expect(events).toEqual([
      "stop:previous",
      "detach:previous",
      "start:candidate-1",
      "activate:candidate-1",
      "stop:candidate-1",
      "detach:candidate-1",
      "start:candidate-2",
      "activate:candidate-2",
    ]);
  });

  it("stops after the configured recovery attempts", async () => {
    const previous = { id: "previous" };
    let current: FakeConnection | null = previous;
    let starts = 0;
    let stops = 0;

    const operations: ManagedConnectionOperations<FakeConnection, Error> = {
      current: Effect.sync(() => current),
      detach: (candidate) =>
        Effect.sync(() => {
          if (current === candidate) current = null;
        }),
      stop: () => Effect.sync(() => void (stops += 1)),
      start: () =>
        Effect.suspend(() => {
          starts += 1;
          return Effect.fail(new Error(`startup failed ${starts}`));
        }),
      activate: () => Effect.void,
    };

    await expect(
      Effect.runPromise(
        replaceManagedConnection(operations, {
          maxAttempts: 3,
          retryDelayMs: () => 0,
        }),
      ),
    ).rejects.toMatchObject({ attempt: 3, phase: "start", retryable: true });
    expect(starts).toBe(3);
    expect(stops).toBe(1);
    expect(current).toBeNull();
  });
});
