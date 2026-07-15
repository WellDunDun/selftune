import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  RemoteCapabilities,
  RemoteConflict,
  RemoteDiagnostics,
  RemoteIntegrityFailure,
  RemoteLibraryUnavailable,
  RemoteObjectMissing,
  RemoteSnapshot,
} from "../domain";

export type RemoteLibraryError =
  | RemoteConflict
  | RemoteIntegrityFailure
  | RemoteLibraryUnavailable
  | RemoteObjectMissing;

export class RemoteLibrary extends Context.Service<
  RemoteLibrary,
  {
    readonly capabilities: Effect.Effect<RemoteCapabilities, RemoteLibraryUnavailable>;
    readonly putObject: (input: {
      objectHash: string;
      bytes: Uint8Array;
    }) => Effect.Effect<void, RemoteIntegrityFailure | RemoteLibraryUnavailable>;
    readonly hasObject: (objectHash: string) => Effect.Effect<boolean, RemoteLibraryUnavailable>;
    readonly getObject: (
      objectHash: string,
    ) => Effect.Effect<
      Uint8Array,
      RemoteIntegrityFailure | RemoteObjectMissing | RemoteLibraryUnavailable
    >;
    readonly head: Effect.Effect<RemoteSnapshot | null, RemoteLibraryUnavailable>;
    readonly getSnapshot: (
      snapshotId: string,
    ) => Effect.Effect<RemoteSnapshot, RemoteObjectMissing | RemoteLibraryUnavailable>;
    readonly commitSnapshot: (
      snapshot: RemoteSnapshot,
    ) => Effect.Effect<
      RemoteSnapshot,
      RemoteConflict | RemoteObjectMissing | RemoteLibraryUnavailable
    >;
    readonly diagnostics: Effect.Effect<RemoteDiagnostics, RemoteLibraryUnavailable>;
  }
>()("@selftune/control-plane/RemoteLibrary") {}
