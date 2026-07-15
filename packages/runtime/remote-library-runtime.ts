import {
  RemoteLibrary,
  RemoteLibraryHttp,
  type RemoteCapabilities,
  type RemoteDiagnostics,
  type RemoteSnapshot,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

export interface RemoteLibraryHandle {
  capabilities: () => Promise<RemoteCapabilities>;
  putObject: (objectHash: string, bytes: Uint8Array) => Promise<void>;
  hasObject: (objectHash: string) => Promise<boolean>;
  getObject: (objectHash: string) => Promise<Uint8Array>;
  head: () => Promise<RemoteSnapshot | null>;
  getSnapshot: (snapshotId: string) => Promise<RemoteSnapshot>;
  commitSnapshot: (snapshot: RemoteSnapshot) => Promise<RemoteSnapshot>;
  diagnostics: () => Promise<RemoteDiagnostics>;
  dispose: () => Promise<void>;
}

export function createRemoteLibraryHandle(options: {
  baseUrl: string;
  apiKey: string;
}): RemoteLibraryHandle {
  const runtime = ManagedRuntime.make(RemoteLibraryHttp(options));
  const run = <A, E>(effect: Effect.Effect<A, E, RemoteLibrary>): Promise<A> =>
    runtime.runPromise(effect);

  return {
    capabilities: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).capabilities;
        }),
      ),
    putObject: (objectHash, bytes) =>
      run(
        Effect.gen(function* () {
          yield* (yield* RemoteLibrary).putObject({ objectHash, bytes });
        }),
      ),
    hasObject: (objectHash) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).hasObject(objectHash);
        }),
      ),
    getObject: (objectHash) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).getObject(objectHash);
        }),
      ),
    head: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).head;
        }),
      ),
    getSnapshot: (snapshotId) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).getSnapshot(snapshotId);
        }),
      ),
    commitSnapshot: (snapshot) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).commitSnapshot(snapshot);
        }),
      ),
    diagnostics: () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* RemoteLibrary).diagnostics;
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}
