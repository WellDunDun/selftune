import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemoteSnapshot,
  RemoteArtifact,
  RemoteConflict,
  RemoteLibrary,
  RemoteLibraryMemory,
  sha256,
} from "@selftune/control-plane";
import { Effect, ManagedRuntime, Schema } from "effect";
import { RemoteLibraryBackup } from "../../packages/library/src/remote/backup.js";
import {
  previewRemoteObjects,
  syncRemoteObjects,
  exportRemoteLibrary,
} from "@selftune/library/remote/sync";
import type { RemoteLibraryHandle } from "@selftune/library/remote/transport";

const handles: RemoteLibraryHandle[] = [];
const roots: string[] = [];
const now = new Date("2026-09-06T10:00:00Z");

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function object(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    artifact: RemoteArtifact.make({
      artifactId: "metadata/test",
      artifactType: "metadata",
      objectHash: sha256(bytes),
      revisionHash: null,
      updatedAt: now.toISOString(),
    }),
  };
}

function memoryHandle(): RemoteLibraryHandle {
  const runtime = ManagedRuntime.make(RemoteLibraryMemory);
  const service = <A, E>(use: (remote: RemoteLibrary["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* RemoteLibrary);
      }),
    );
  const handle: RemoteLibraryHandle = {
    capabilities: () => service((remote) => remote.capabilities),
    putObject: (objectHash, bytes) => service((remote) => remote.putObject({ objectHash, bytes })),
    hasObject: (objectHash) => service((remote) => remote.hasObject(objectHash)),
    getObject: (objectHash) => service((remote) => remote.getObject(objectHash)),
    head: () => service((remote) => remote.head),
    getSnapshot: (snapshotId) => service((remote) => remote.getSnapshot(snapshotId)),
    commitSnapshot: (snapshot) => service((remote) => remote.commitSnapshot(snapshot)),
    diagnostics: () => service((remote) => remote.diagnostics),
    dispose: () => runtime.dispose(),
  };
  handles.push(handle);
  return handle;
}

describe("backup previews", () => {
  test.each([
    "null",
    "false",
    "42",
    '"hello"',
    '[1,"two"]',
    '{"preferences":{"drafts":false}}',
    '{"files":"metadata"}',
  ])("preserves arbitrary JSON metadata: %s", (text) => {
    const item = object(text);
    expect(previewRemoteObjects([item])).toEqual({
      artifacts: [{ ...item.artifact, bytes: item.bytes.byteLength, preview: JSON.parse(text) }],
      totalBytes: item.bytes.byteLength,
    });
  });

  test.each(["{broken", "\u0000binary"])("labels non-JSON objects as binary: %s", (text) => {
    expect(previewRemoteObjects([object(text)]).artifacts[0]?.preview).toEqual({
      format: "binary",
    });
  });

  test("previews valid bundle entries while omitting malformed entries", () => {
    const text = "é".repeat(241);
    const binary = Buffer.from([0, 1, 2]);
    const item = object(
      JSON.stringify({
        files: [
          null,
          42,
          {},
          { path: false, contentBase64: "" },
          { path: "missing-content" },
          { path: "SKILL.md", contentBase64: Buffer.from(text).toString("base64") },
          { path: "asset.bin", contentBase64: binary.toString("base64") },
        ],
      }),
    );
    expect(previewRemoteObjects([item]).artifacts[0]?.preview).toEqual({
      files: [
        {
          path: "SKILL.md",
          bytes: Buffer.byteLength(text),
          sha256: sha256(Buffer.from(text)),
          text_preview: text.slice(0, 240),
          truncated: true,
        },
        {
          path: "asset.bin",
          bytes: 3,
          sha256: sha256(binary),
          text_preview: null,
          truncated: false,
        },
      ],
    });
  });
});

describe("remote snapshot contracts", () => {
  test("retries a real compare-and-swap conflict and calls the completed snapshot callback once", async () => {
    const handle = memoryHandle();
    const commit = handle.commitSnapshot;
    let attempts = 0;
    const competing = buildRemoteSnapshot({
      parentSnapshotId: null,
      createdAt: now.toISOString(),
      artifacts: [],
    });
    handle.commitSnapshot = async (snapshot) => {
      attempts += 1;
      if (attempts === 1) await commit(competing);
      return commit(snapshot);
    };
    let callbacks = 0;
    const result = await syncRemoteObjects({
      handle,
      objects: [object("{}")],
      now,
      onSnapshot: async () => {
        callbacks += 1;
      },
    });
    expect(result.snapshot.parentSnapshotId).toBe(competing.snapshotId);
    expect(attempts).toBe(2);
    expect(callbacks).toBe(1);
    expect(result.uploaded).toBe(1);
  });

  test("bounds retries to three attempts", async () => {
    const handle = memoryHandle();
    let attempts = 0;
    const conflict = new RemoteConflict({ expectedParentId: null, actualParentId: "changed" });
    handle.commitSnapshot = async () => {
      attempts += 1;
      throw conflict;
    };
    await expect(syncRemoteObjects({ handle, objects: [object("{}")], now })).rejects.toBe(
      conflict,
    );
    expect(attempts).toBe(3);
  });

  test.each([new Error("Unavailable"), { _tag: "RemoteConflict" }])(
    "does not retry an unrelated or malformed thrown error: %j",
    async (failure) => {
      const handle = memoryHandle();
      let attempts = 0;
      handle.commitSnapshot = async () => {
        attempts += 1;
        throw failure;
      };
      await expect(syncRemoteObjects({ handle, objects: [object("{}")], now })).rejects.toBe(
        failure,
      );
      expect(attempts).toBe(1);
    },
  );

  test("exports the complete snapshot contract and never overwrites an existing backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-backup-contract-"));
    roots.push(root);
    const outputPath = join(root, "backup.json");
    const handle = memoryHandle();
    const item = object('{"drafts":false}');
    const synced = await syncRemoteObjects({ handle, objects: [item], now });
    await exportRemoteLibrary({ handle, outputPath, now });
    const bytes = readFileSync(outputPath, "utf8");
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(RemoteLibraryBackup))(bytes)).toEqual({
      version: 1,
      exportedAt: now.toISOString(),
      headSnapshotId: synced.snapshot.snapshotId,
      snapshots: [synced.snapshot],
      objects: [
        {
          objectHash: item.artifact.objectHash,
          contentBase64: Buffer.from(item.bytes).toString("base64"),
        },
      ],
    });
    await expect(exportRemoteLibrary({ handle, outputPath, now })).rejects.toThrow();
    expect(readFileSync(outputPath, "utf8")).toBe(bytes);
  });

  test("rejects malformed snapshots in backup JSON", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: now.toISOString(),
      headSnapshotId: "snapshot",
      snapshots: [{ snapshotId: "snapshot" }],
      objects: [],
    });
    expect(() =>
      Schema.decodeUnknownSync(Schema.fromJsonString(RemoteLibraryBackup))(text),
    ).toThrow();
  });
});
