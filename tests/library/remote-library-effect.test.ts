import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
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
import { pullRemoteLibraryStateEffect } from "../../packages/runtime/remote-library/effect-pull.js";
import { SkillIntelligenceLearnedState } from "../../packages/runtime/skill-intelligence/learned-state.js";
import { loadSkillIntelligenceFeedback } from "../../packages/runtime/skill-intelligence/feedback.js";
import { openDb } from "@selftune/local-store";

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
  test.each(["{broken", "null", "{}", '{"version":1,"overrides":false}'])(
    "rejects malformed learned state without replacing the restore destination: %s",
    async (text) => {
      const root = temporaryRoot();
      const targetRoot = join(root, "restore");
      mkdirSync(targetRoot);
      const originalInode = statSync(targetRoot).ino;
      const bytes = new TextEncoder().encode(text);
      const artifact = RemoteArtifact.make({
        artifactId: "learned-state/client",
        artifactType: "learned_state",
        objectHash: sha256(bytes),
        revisionHash: null,
        updatedAt: "2026-09-06T10:00:00Z",
      });
      const destination = openDb(":memory:");
      try {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const synced = yield* syncRemoteObjectsEffect({ objects: [{ artifact, bytes }] });
            const pulled = yield* Effect.flip(
              pullRemoteLibraryStateEffect({
                configRoot: targetRoot,
                snapshot: synced.snapshot,
                db: destination,
                preferences: {
                  releasedSkills: false,
                  drafts: false,
                  skillSets: false,
                  metadata: false,
                  decisionHistory: true,
                },
              }),
            );
            const restored = yield* Effect.flip(restoreRemoteLibraryEffect({ targetRoot }));
            return { pulled, restored };
          }).pipe(Effect.provide(RemoteLibraryMemory)),
        );
        expect(result.pulled).toMatchObject({ code: "OPERATION_FAILED" });
        expect(result.restored).toMatchObject({ code: "OPERATION_FAILED" });
        expect(loadSkillIntelligenceFeedback(destination).classificationOverrides).toEqual([]);
        expect(statSync(targetRoot).ino).toBe(originalInode);
        expect(readdirSync(targetRoot)).toEqual([]);
        expect(readdirSync(root)).toEqual(["restore"]);
      } finally {
        destination.close();
      }
    },
  );

  test("merges a validated learned-state artifact through both pull and restore", async () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "restored");
    const state = SkillIntelligenceLearnedState.make({
      version: 1,
      exported_at: "2026-09-06T10:00:00Z",
      corrections: [],
      snapshots: [],
      reviews: [],
      outcomes: [],
      overrides: [
        {
          skill_id: "research",
          skill_name: "research",
          category: "research",
          inferred_category: "general",
          reason: null,
          algorithm_version: "test/v1",
          created_at: "2026-09-06T10:00:00Z",
          updated_at: "2026-09-06T10:00:00Z",
        },
      ],
    });
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    const artifact = RemoteArtifact.make({
      artifactId: "learned-state/client",
      artifactType: "learned_state",
      objectHash: sha256(bytes),
      revisionHash: null,
      updatedAt: state.exported_at,
    });
    const destination = openDb(":memory:");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const synced = yield* syncRemoteObjectsEffect({ objects: [{ artifact, bytes }] });
          yield* pullRemoteLibraryStateEffect({
            configRoot: join(root, "pull"),
            snapshot: synced.snapshot,
            db: destination,
            preferences: {
              releasedSkills: false,
              drafts: false,
              skillSets: false,
              metadata: false,
              decisionHistory: true,
            },
          });
          yield* restoreRemoteLibraryEffect({ targetRoot });
        }).pipe(Effect.provide(RemoteLibraryMemory)),
      );
      expect(loadSkillIntelligenceFeedback(destination).classificationOverrides).toEqual([
        ...state.overrides,
      ]);
      expect(existsSync(join(targetRoot, "selftune.db"))).toBe(true);
      const restored = openDb(join(targetRoot, "selftune.db"));
      try {
        expect(loadSkillIntelligenceFeedback(restored).classificationOverrides).toEqual([
          ...state.overrides,
        ]);
      } finally {
        restored.close();
      }
    } finally {
      destination.close();
    }
  });

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
