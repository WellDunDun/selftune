import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildRemoteSnapshot,
  sha256,
  type RemoteArtifact,
  type RemoteDiagnostics,
  type RemoteSnapshot,
} from "@selftune/control-plane";
import * as Schema from "effect/Schema";

import { LibraryError } from "../errors.js";
import type { RemoteLibraryHandle } from "./transport.js";

const BackupObject = Schema.Struct({ objectHash: Schema.String, contentBase64: Schema.String });
const RemoteLibraryBackup = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  headSnapshotId: Schema.NullOr(Schema.String),
  snapshots: Schema.Array(Schema.Unknown),
  objects: Schema.Array(BackupObject),
});

export interface RemoteSyncObject {
  artifact: RemoteArtifact;
  bytes: Uint8Array;
}

export function previewRemoteObjects(objects: ReadonlyArray<RemoteSyncObject>): {
  artifacts: Array<RemoteArtifact & { bytes: number; preview: unknown }>;
  totalBytes: number;
} {
  return {
    artifacts: objects.map((object) => {
      let preview: unknown;
      try {
        const decoded: unknown = JSON.parse(new TextDecoder().decode(object.bytes));
        const files =
          decoded && typeof decoded === "object" && "files" in decoded ? decoded.files : null;
        preview = Array.isArray(files)
          ? {
              files: files.flatMap((file) => {
                if (
                  !file ||
                  typeof file !== "object" ||
                  !("path" in file) ||
                  typeof file.path !== "string" ||
                  !("contentBase64" in file) ||
                  typeof file.contentBase64 !== "string"
                ) {
                  return [];
                }
                const bytes = Buffer.from(file.contentBase64, "base64");
                const content = bytes.toString("utf8");
                return [
                  {
                    path: file.path,
                    bytes: bytes.length,
                    sha256: sha256(bytes),
                    text_preview: content.includes("\u0000") ? null : content.slice(0, 240),
                    truncated: !content.includes("\u0000") && content.length > 240,
                  },
                ];
              }),
            }
          : decoded;
      } catch {
        preview = { format: "binary" };
      }
      return { ...object.artifact, bytes: object.bytes.byteLength, preview };
    }),
    totalBytes: objects.reduce((total, object) => total + object.bytes.byteLength, 0),
  };
}

function artifactIdentity(artifact: RemoteArtifact): {
  artifactId: string;
  artifactType: RemoteArtifact["artifactType"];
  objectHash: string;
  revisionHash: string | null;
} {
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
      const isConflict =
        error !== null &&
        typeof error === "object" &&
        "_tag" in error &&
        error._tag === "RemoteConflict";
      if (!isConflict || attempt === 2) throw error;
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
