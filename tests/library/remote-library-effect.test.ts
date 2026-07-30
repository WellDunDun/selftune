import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteArtifact, RemoteLibraryMemory, sha256 } from "@selftune/control-plane";
import {
  diagnoseRemoteEffect,
  exportRemoteLibraryEffect,
  syncRemoteObjectsEffect,
} from "@selftune/library/remote/effect-sync";
import * as Effect from "effect/Effect";

import { restoreRemoteLibraryEffect } from "../../packages/runtime/remote-library/effect-restore.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-remote-effect-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Effect-native Remote Library workflows", () => {
  test("syncs, reuses, diagnoses, exports, and restores through one provided service", async () => {
    const root = temporaryRoot();
    const outputPath = join(root, "backup.json");
    const targetRoot = join(root, "restore");
    const bytes = new TextEncoder().encode('{"source":"effect"}');
    const objectHash = sha256(bytes);
    const artifact = RemoteArtifact.make({
      artifactId: "metadata/effect-runtime",
      artifactType: "metadata",
      objectHash,
      revisionHash: objectHash,
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* syncRemoteObjectsEffect({ objects: [{ artifact, bytes }] });
        const second = yield* syncRemoteObjectsEffect({ objects: [{ artifact, bytes }] });
        const diagnostics = yield* diagnoseRemoteEffect();
        const exported = yield* exportRemoteLibraryEffect({
          outputPath,
          now: new Date("2026-07-16T00:00:01.000Z"),
        });
        const restored = yield* restoreRemoteLibraryEffect({ targetRoot });
        return { first, second, diagnostics, exported, restored };
      }).pipe(Effect.provide(RemoteLibraryMemory)),
    );

    expect(result.first).toMatchObject({ uploaded: 1, unchanged: 0 });
    expect(result.second).toMatchObject({ uploaded: 0, unchanged: 1 });
    expect(result.second.snapshot.snapshotId).toBe(result.first.snapshot.snapshotId);
    expect(result.diagnostics).toMatchObject({ objectCount: 1, snapshotCount: 1 });
    expect(result.exported).toMatchObject({ outputPath, snapshots: 1, objects: 1 });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(result.restored).toMatchObject({ targetRoot, restored: 1 });
    expect(readFileSync(join(targetRoot, "remote-library-snapshot.json"), "utf8")).toBe(
      '{"source":"effect"}',
    );
  });
});
