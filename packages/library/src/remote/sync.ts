import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildRemoteSnapshot,
  RemoteConflict,
  sha256,
  type RemoteArtifact,
  type RemoteDiagnostics,
  type RemoteSnapshot,
} from "@selftune/control-plane";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { LibraryError } from "../errors.js";
import type { RemoteLibraryHandle } from "./transport.js";
import { RemoteLibraryBackup } from "./backup.js";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeFiles = Schema.decodeUnknownOption(Schema.Struct({ files: Schema.Array(Schema.Json) }));
const decodeFile = Schema.decodeUnknownOption(
  Schema.Struct({ path: Schema.String, contentBase64: Schema.String }),
);

export interface RemoteSyncObject {
  artifact: RemoteArtifact;
  bytes: Uint8Array;
}

function previewObject(bytes: Uint8Array) {
  const decoded = decodeJson(new TextDecoder().decode(bytes));
  if (Option.isNone(decoded)) return { format: "binary" };
  const bundle = decodeFiles(decoded.value);
  if (Option.isNone(bundle)) return decoded.value;
  return {
    files: bundle.value.files.flatMap((value) => {
      const file = decodeFile(value);
      if (Option.isNone(file)) return [];
      const contentBytes = Buffer.from(file.value.contentBase64, "base64");
      const content = contentBytes.toString("utf8");
      const binary = content.includes("\u0000");
      return [
        {
          path: file.value.path,
          bytes: contentBytes.length,
          sha256: sha256(contentBytes),
          text_preview: binary ? null : content.slice(0, 240),
          truncated: !binary && content.length > 240,
        },
      ];
    }),
  };
}

export function previewRemoteObjects(objects: ReadonlyArray<RemoteSyncObject>) {
  return {
    artifacts: objects.map((object) => ({
      ...object.artifact,
      bytes: object.bytes.byteLength,
      preview: previewObject(object.bytes),
    })),
    totalBytes: objects.reduce((total, object) => total + object.bytes.byteLength, 0),
  };
}

function artifactIdentity(artifact: RemoteArtifact) {
  return {
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    objectHash: artifact.objectHash,
    revisionHash: artifact.revisionHash,
  };
}

export async function syncRemoteObjects(options: {
  handle: RemoteLibraryHandle;
  objects: ReadonlyArray<RemoteSyncObject>;
  now?: Date;
  onSnapshot?: (snapshot: RemoteSnapshot) => Promise<void>;
}): Promise<{ snapshot: RemoteSnapshot; uploaded: number; unchanged: number }> {
  const uploads = await Promise.all(
    options.objects.map(async (object) => {
      if (await options.handle.hasObject(object.artifact.objectHash)) return false;
      await options.handle.putObject(object.artifact.objectHash, object.bytes);
      return true;
    }),
  );
  const uploaded = uploads.filter(Boolean).length;
  const unchanged = uploads.length - uploaded;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = await options.handle.head();
    const merged = new Map<string, RemoteArtifact>();
    for (const artifact of head?.artifacts ?? []) merged.set(artifact.artifactId, artifact);
    for (const object of options.objects) {
      const artifact = object.artifact;
      const existing = merged.get(artifact.artifactId);
      if (existing && existing.objectHash !== artifact.objectHash) {
        throw new LibraryError(
          `Sync & Backup conflict for ${artifact.artifactId}.`,
          "GUARD_BLOCKED",
          "Review both immutable revisions before choosing an active pointer.",
        );
      }
      merged.set(artifact.artifactId, artifact);
    }
    const artifacts = [...merged.values()].toSorted((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    const unchangedSnapshot =
      head &&
      JSON.stringify(
        head.artifacts
          .map(artifactIdentity)
          .toSorted((left, right) => left.artifactId.localeCompare(right.artifactId)),
      ) === JSON.stringify(artifacts.map(artifactIdentity));
    if (head && unchangedSnapshot) {
      await options.onSnapshot?.(head);
      return { snapshot: head, uploaded, unchanged };
    }

    const snapshot = buildRemoteSnapshot({
      parentSnapshotId: head?.snapshotId ?? null,
      createdAt: (options.now ?? new Date()).toISOString(),
      artifacts,
    });
    try {
      const committed = await options.handle.commitSnapshot(snapshot);
      await options.onSnapshot?.(committed);
      return { snapshot: committed, uploaded, unchanged };
    } catch (error) {
      if (!(error instanceof RemoteConflict) || attempt === 2) throw error;
    }
  }
  throw new LibraryError(
    "Sync & Backup could not advance the remote snapshot.",
    "OPERATION_FAILED",
  );
}

async function snapshotHistory(handle: RemoteLibraryHandle): Promise<RemoteSnapshot[]> {
  const history: RemoteSnapshot[] = [];
  let current = await handle.head();
  while (current) {
    history.push(current);
    current = current.parentSnapshotId ? await handle.getSnapshot(current.parentSnapshotId) : null;
  }
  return history;
}

export async function exportRemoteLibrary(options: {
  handle: RemoteLibraryHandle;
  outputPath: string;
  now?: Date;
}): Promise<{ outputPath: string; snapshots: number; objects: number }> {
  const snapshots = await snapshotHistory(options.handle);
  const hashes = [
    ...new Set(
      snapshots.flatMap((snapshot) => snapshot.artifacts.map((artifact) => artifact.objectHash)),
    ),
  ].toSorted();
  const objects = await Promise.all(
    hashes.map(async (objectHash) => ({
      objectHash,
      contentBase64: Buffer.from(await options.handle.getObject(objectHash)).toString("base64"),
    })),
  );
  const backup = RemoteLibraryBackup.make({
    version: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    headSnapshotId: snapshots[0]?.snapshotId ?? null,
    snapshots,
    objects,
  });
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { outputPath, snapshots: snapshots.length, objects: objects.length };
}

export function diagnoseRemote(handle: RemoteLibraryHandle): Promise<RemoteDiagnostics> {
  return handle.diagnostics();
}
