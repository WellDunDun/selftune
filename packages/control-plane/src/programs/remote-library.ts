import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";

import { RemoteSnapshot, type RemoteArtifact } from "../domain";
import { RemoteLibrary } from "../services";

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function buildRemoteSnapshot(input: {
  parentSnapshotId: string | null;
  createdAt: string;
  artifacts: ReadonlyArray<RemoteArtifact>;
}): RemoteSnapshot {
  const artifacts = [...input.artifacts].sort((left, right) =>
    compareText(
      `${left.artifactType}\u0000${left.artifactId}\u0000${left.objectHash}`,
      `${right.artifactType}\u0000${right.artifactId}\u0000${right.objectHash}`,
    ),
  );
  const canonical = JSON.stringify({
    parentSnapshotId: input.parentSnapshotId,
    createdAt: input.createdAt,
    artifacts,
  });
  const snapshotId = sha256(new TextEncoder().encode(canonical));
  return RemoteSnapshot.make({ snapshotId, ...input, artifacts });
}

export const uploadRemoteObject = Effect.fn("RemoteLibrary.putObject")(function* (input: {
  objectHash: string;
  bytes: Uint8Array;
}) {
  const remote = yield* RemoteLibrary;
  yield* remote.putObject(input);
});

export const commitRemoteSnapshot = Effect.fn("RemoteLibrary.commitSnapshot")(function* (
  snapshot: RemoteSnapshot,
) {
  const remote = yield* RemoteLibrary;
  return yield* remote.commitSnapshot(snapshot);
});

export const diagnoseRemoteLibrary = Effect.fn("RemoteLibrary.diagnostics")(function* () {
  const remote = yield* RemoteLibrary;
  return yield* remote.diagnostics;
});
