import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  buildRemoteSnapshot,
  commitRemoteSnapshot,
  diagnoseRemoteLibrary,
  makeRemoteLibraryHttpClient,
  RemoteArtifact,
  RemoteLibraryMemory,
  RemoteObjectMissing,
  sha256,
  uploadRemoteObject,
} from "../src/index";

const bytes = new TextEncoder().encode("immutable skill package");
const objectHash = sha256(bytes);

const artifact = RemoteArtifact.make({
  artifactId: "skill/research/revision/1",
  artifactType: "released_skill",
  objectHash,
  revisionHash: "a".repeat(64),
  updatedAt: "2026-07-15T08:00:00.000Z",
});

describe("Remote Library protocol", () => {
  it.layer(RemoteLibraryMemory)("integrity conformance", (layerIt) => {
    layerIt.effect("verifies object hashes before accepting bytes", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          uploadRemoteObject({ objectHash: "0".repeat(64), bytes }),
        );
        assert.strictEqual(failure._tag, "RemoteIntegrityFailure");
        const diagnostics = yield* diagnoseRemoteLibrary();
        assert.strictEqual(diagnostics.objectCount, 0);
      }),
    );
  });

  it.layer(RemoteLibraryMemory)("snapshot conformance", (layerIt) => {
    layerIt.effect("commits immutable snapshots with compare-and-swap parents", () =>
      Effect.gen(function* () {
        yield* uploadRemoteObject({ objectHash, bytes });
        const first = buildRemoteSnapshot({
          parentSnapshotId: null,
          createdAt: "2026-07-15T08:00:00.000Z",
          artifacts: [artifact],
        });
        yield* commitRemoteSnapshot(first);

        const stale = buildRemoteSnapshot({
          parentSnapshotId: null,
          createdAt: "2026-07-15T09:00:00.000Z",
          artifacts: [artifact],
        });
        const conflict = yield* Effect.flip(commitRemoteSnapshot(stale));
        assert.strictEqual(conflict._tag, "RemoteConflict");
      }),
    );
  });

  it.layer(RemoteLibraryMemory)("missing object conformance", (layerIt) => {
    layerIt.effect("blocks snapshots that reference missing objects", () =>
      Effect.gen(function* () {
        const snapshot = buildRemoteSnapshot({
          parentSnapshotId: null,
          createdAt: "2026-07-15T08:00:00.000Z",
          artifacts: [RemoteArtifact.make({ ...artifact, objectHash: "f".repeat(64) })],
        });
        const failure = yield* Effect.flip(commitRemoteSnapshot(snapshot));
        assert.instanceOf(failure, RemoteObjectMissing);
      }),
    );
  });

  it.layer(RemoteLibraryMemory)("diagnostics conformance", (layerIt) => {
    layerIt.effect("reports uploaded objects that are not referenced by a snapshot", () =>
      Effect.gen(function* () {
        yield* uploadRemoteObject({ objectHash, bytes });
        const diagnostics = yield* diagnoseRemoteLibrary();
        assert.deepStrictEqual(diagnostics.orphanedObjects, [objectHash]);
        assert.strictEqual(diagnostics.totalBytes, bytes.length);
      }),
    );
  });

  it.effect("excludes raw transcripts from the sync artifact contract", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Schema.decodeUnknownEffect(RemoteArtifact)({
          artifactId: "transcript/session-1",
          artifactType: "raw_transcript",
          objectHash,
          revisionHash: null,
          updatedAt: "2026-07-15T08:00:00.000Z",
        }),
      );
      assert.include(String(failure), "artifactType");
    }),
  );

  it("normalizes arbitrarily long trailing slash runs before HTTP requests", async () => {
    let requestedUrl = "";
    const fetchClient: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        protocol: "selftune.remote-library.v1",
        snapshot_schema: "selftune.remote-library.snapshot.v1",
        immutable_objects: true,
        compare_and_swap_heads: true,
        raw_transcripts_synced: false,
        max_object_bytes: 1_048_576,
      });
    };
    const client = makeRemoteLibraryHttpClient({
      baseUrl: `https://library.selftune.dev${"/".repeat(100_000)}`,
      apiKey: "secret",
      fetch: fetchClient,
    });

    try {
      const capabilities = await client.capabilities();
      assert.strictEqual(capabilities.protocolVersion, 1);
      assert.strictEqual(
        requestedUrl,
        "https://library.selftune.dev/api/v1/remote-library/capabilities",
      );
    } finally {
      await client.dispose();
    }
  });
});
