import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface ManagedConnectionOperations<Connection, Error> {
  readonly activate: (connection: Connection) => Effect.Effect<void, Error>;
  readonly current: Effect.Effect<Connection | null>;
  readonly detach: (connection: Connection) => Effect.Effect<void>;
  readonly onAttemptFailure?: (failure: ManagedConnectionTransitionFailure) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<Connection, Error>;
  readonly stop: (connection: Connection) => Effect.Effect<void, Error>;
}

export interface ManagedConnectionReplacementOptions {
  readonly maxAttempts: number;
  readonly retryDelayMs: (failedAttempt: number) => number;
}

export interface ManagedConnectionReplacementResult<Connection> {
  readonly attempt: number;
  readonly connection: Connection;
}

export class ManagedConnectionTransitionFailure extends Schema.TaggedErrorClass<ManagedConnectionTransitionFailure>()(
  "ManagedConnectionTransitionFailure",
  {
    attempt: Schema.Number,
    message: Schema.String,
    phase: Schema.Literals(["stop-current", "start", "activate", "cleanup-candidate"]),
    retryable: Schema.Boolean,
  },
) {}

function transitionFailure(
  phase: ManagedConnectionTransitionFailure["phase"],
  attempt: number,
  cause: unknown,
  retryable: boolean,
): ManagedConnectionTransitionFailure {
  return ManagedConnectionTransitionFailure.make({
    attempt,
    message: cause instanceof Error ? cause.message : String(cause),
    phase,
    retryable,
  });
}

function runPhase<Value, Error>(
  phase: ManagedConnectionTransitionFailure["phase"],
  attempt: number,
  retryable: boolean,
  operation: Effect.Effect<Value, Error>,
) {
  return operation.pipe(
    Effect.mapError((cause) => transitionFailure(phase, attempt, cause, retryable)),
  );
}

const startAndActivate = Effect.fn("SelfTuneDesktop.startAndActivateManagedConnection")(function* <
  Connection,
  Error,
>(operations: ManagedConnectionOperations<Connection, Error>, attempt: number) {
  const started = yield* runPhase("start", attempt, true, operations.start());
  const activation = yield* Effect.result(
    runPhase("activate", attempt, true, operations.activate(started)),
  );
  if (Result.isSuccess(activation)) return started;

  const cleanup = yield* Effect.result(
    runPhase("cleanup-candidate", attempt, false, operations.stop(started)),
  );
  if (Result.isFailure(cleanup)) {
    return yield* Effect.fail(
      transitionFailure(
        "cleanup-candidate",
        attempt,
        `${activation.failure.message} Candidate cleanup also failed: ${cleanup.failure.message}`,
        false,
      ),
    );
  }
  yield* operations.detach(started);
  return yield* Effect.fail(activation.failure);
});

export const replaceManagedConnection = Effect.fn("SelfTuneDesktop.replaceManagedConnection")(
  function* <Connection, Error>(
    operations: ManagedConnectionOperations<Connection, Error>,
    options: ManagedConnectionReplacementOptions,
  ) {
    const activeConnection = yield* operations.current;
    if (activeConnection !== null) {
      yield* runPhase("stop-current", 0, false, operations.stop(activeConnection));
      yield* operations.detach(activeConnection);
    }

    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
    let lastFailure = transitionFailure("start", 0, "No replacement attempt ran.", false);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = yield* Effect.result(startAndActivate(operations, attempt));
      if (Result.isSuccess(result)) {
        return {
          attempt,
          connection: result.success,
        } satisfies ManagedConnectionReplacementResult<Connection>;
      }

      lastFailure = result.failure;
      if (operations.onAttemptFailure) yield* operations.onAttemptFailure(lastFailure);
      if (!lastFailure.retryable || attempt === maxAttempts) break;

      const delayMs = Math.max(0, options.retryDelayMs(attempt));
      if (delayMs > 0) yield* Effect.sleep(delayMs);
    }
    return yield* Effect.fail(lastFailure);
  },
);
