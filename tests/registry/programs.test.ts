import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  RegistryClient,
  RegistryHttpError,
  type RegistryClientService,
  type RegistryRequestOptions,
} from "../../packages/runtime/registry/client.js";
import {
  RegistryPlatform,
  type RegistryPlatformService,
} from "../../packages/runtime/registry/platform.js";
import { runRegistryProgram } from "../../packages/runtime/registry/programs.js";
import { flushRegistryOutbox } from "../../packages/runtime/registry/registry-outbox.js";
import type { RegistryStateEntry } from "../../packages/runtime/registry/registry-state.js";
import { runRegistrySync } from "../../packages/runtime/registry/sync.js";

function clientLayer(payload: unknown) {
  const service: RegistryClientService = {
    download: () => Effect.die(new Error("download was not expected")),
    request: <A>(schema: Schema.Decoder<A>) => Schema.decodeUnknownEffect(schema)(payload),
  };
  return Layer.succeed(RegistryClient, service);
}

function recordingClientLayer(
  payloads: ReadonlyArray<unknown>,
  requests: RegistryRequestOptions[],
  download = Effect.succeed(new Uint8Array()),
) {
  let index = 0;
  const service: RegistryClientService = {
    download: () => download,
    request: <A>(schema: Schema.Decoder<A>, options: RegistryRequestOptions) => {
      requests.push(options);
      return Schema.decodeUnknownEffect(schema)(payloads[index++]);
    },
  };
  return Layer.succeed(RegistryClient, service);
}

function platformLayer(state: RegistryPlatformService) {
  return Layer.succeed(RegistryPlatform, state);
}

const unusedPlatform: RegistryPlatformService = {
  deviceId: "test-device",
  computeInstalledContentHash: () => Effect.succeed("local-content-hash"),
  computeArchiveContentHash: () => Effect.succeed("archive-content-hash"),
  findProtectedPaths: () => Effect.succeed([]),
  installArchive: () => Effect.die(new Error("installArchive was not expected")),
  installFromGithub: () => Effect.die(new Error("installFromGithub was not expected")),
  loadState: () => Effect.die(new Error("loadState was not expected")),
  preparePackage: () => Effect.die(new Error("preparePackage was not expected")),
  preparePush: () => Effect.die(new Error("preparePush was not expected")),
  resolveInstallTarget: () => Effect.die(new Error("resolveInstallTarget was not expected")),
  validatePersistedTarget: () => Effect.die(new Error("validatePersistedTarget was not expected")),
  withStateTransaction: () => Effect.die(new Error("withStateTransaction was not expected")),
};

describe("runRegistryProgram", () => {
  test("runs list against an injected typed client without ambient config or fetch", async () => {
    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "list" }).pipe(
        Effect.provide(
          Layer.merge(
            clientLayer({
              entries: [
                {
                  name: "deploy",
                  entry_type: "skill",
                  description: null,
                  current_version: null,
                  pass_rate: null,
                  eval_count: 0,
                },
              ],
            }),
            platformLayer(unusedPlatform),
          ),
        ),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout[0] ?? "")).toEqual({
      entries: [
        {
          name: "deploy",
          type: "skill",
          version: "—",
          pass_rate: null,
          eval_count: 0,
          description: null,
        },
      ],
      total: 1,
    });
  });

  test("reads local state from an injected platform before requesting status", async () => {
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () =>
        Effect.succeed([
          {
            entryId: "entry-1",
            name: "deploy",
            versionHash: "old-hash",
            installPath: "/repo/.claude/skills/deploy",
          },
        ]),
    };
    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "status" }).pipe(
        Effect.provide(
          Layer.merge(
            clientLayer({
              entries: [
                {
                  entry_id: "entry-1",
                  name: "deploy",
                  has_update: true,
                  latest_version: "2.0.0",
                  current_version: "1.0.0",
                },
              ],
            }),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(JSON.parse(result.stdout[0] ?? "")).toEqual({
      installations: [{ name: "deploy", installed: "1.0.0", latest: "2.0.0", status: "behind" }],
      total: 1,
      updates_available: 1,
    });
  });

  test("percent-encodes server-returned entry IDs in every route segment", async () => {
    const entryId = "entry/../other?target=x#fragment";
    const encodedId = encodeURIComponent(entryId);

    const historyRequests: RegistryRequestOptions[] = [];
    await Effect.runPromise(
      runRegistryProgram({ operation: "history", name: "deploy" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [{ entries: [{ id: entryId }] }, { versions: [] }],
              historyRequests,
            ),
            platformLayer(unusedPlatform),
          ),
        ),
      ),
    );
    expect(historyRequests[1]?.path).toBe(`/${encodedId}/versions`);

    const rollbackRequests: RegistryRequestOptions[] = [];
    await Effect.runPromise(
      runRegistryProgram({ operation: "rollback", name: "deploy" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer([{ entries: [{ id: entryId }] }, {}], rollbackRequests),
            platformLayer(unusedPlatform),
          ),
        ),
      ),
    );
    expect(rollbackRequests[1]?.path).toBe(`/${encodedId}/rollback`);

    const pushRequests: RegistryRequestOptions[] = [];
    const pushPlatform: RegistryPlatformService = {
      ...unusedPlatform,
      preparePush: () =>
        Effect.succeed({
          name: "deploy",
          description: "Deploy safely",
          version: "1.0.0",
          archiveBuffer: Buffer.from("archive"),
          archiveHash: "archive-hash",
          manifest: [],
        }),
    };
    await Effect.runPromise(
      runRegistryProgram({ operation: "push" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer([{ entries: [{ id: entryId }] }, {}], pushRequests),
            platformLayer(pushPlatform),
          ),
        ),
      ),
    );
    expect(pushRequests[1]?.path).toBe(`/${encodedId}/versions`);

    const installRequests: RegistryRequestOptions[] = [];
    let installState: RegistryStateEntry[] = [];
    const installPlatform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed(installState),
      resolveInstallTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => Effect.void,
      withStateTransaction: (use) =>
        use(installState).pipe(
          Effect.map((decision) => {
            if (decision._tag === "Commit") installState = [...decision.state];
            return decision.value;
          }),
        ),
    };
    await Effect.runPromise(
      runRegistryProgram({ operation: "install", target: "deploy", global: false }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                { entries: [{ id: entryId, name: "deploy" }] },
                {
                  entry: { id: entryId, name: "deploy" },
                  versions: [
                    {
                      id: "version-1",
                      version: "1.0.0",
                      content_hash: "archive-hash",
                      is_current: true,
                    },
                  ],
                },
                {
                  entries: [
                    {
                      download_url: "https://objects.test/archive",
                      latest_version: "1.0.0",
                      latest_content_hash: "archive-hash",
                    },
                  ],
                },
                { data: { id: "installation-1" } },
              ],
              installRequests,
            ),
            platformLayer(installPlatform),
          ),
        ),
      ),
    );
    expect(installRequests[1]?.path).toBe(`/${encodedId}`);
    expect(installRequests[3]?.path).toBe(`/${encodedId}/install`);
  });

  test("does not install or overwrite state when an install changes during download", async () => {
    const requests: RegistryRequestOptions[] = [];
    let archiveInstalls = 0;
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed([]),
      resolveInstallTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => {
        archiveInstalls++;
        return Effect.void;
      },
      withStateTransaction: (use) =>
        use([
          {
            entryId: "entry-1",
            name: "deploy",
            versionHash: "newer-hash",
            installPath: "/repo/.claude/skills/deploy",
          },
        ]).pipe(Effect.map((decision) => decision.value)),
    };

    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "install", target: "deploy", global: false }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                { entries: [{ id: "entry-1", name: "deploy" }] },
                {
                  entry: { id: "entry-1", name: "deploy" },
                  versions: [
                    {
                      id: "version-1",
                      version: "1.0.0",
                      content_hash: "archive-hash",
                      is_current: true,
                    },
                  ],
                },
                {
                  entries: [
                    {
                      download_url: "https://objects.test/archive",
                      latest_version: "1.0.0",
                      latest_content_hash: "archive-hash",
                    },
                  ],
                },
              ],
              requests,
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr[0]).toContain("changed while the archive was downloading");
    expect(archiveInstalls).toBe(0);
    expect(requests).toHaveLength(3);
  });

  test("does not apply a sync update over a newer local state entry", async () => {
    const requests: RegistryRequestOptions[] = [];
    let archiveInstalls = 0;
    const local = {
      entryId: "entry-1",
      name: "deploy",
      versionHash: "old-hash",
      installPath: "/repo/.claude/skills/deploy",
      localContentHash: "local-content-hash",
    };
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed([local]),
      validatePersistedTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => {
        archiveInstalls++;
        return Effect.void;
      },
      withStateTransaction: (use) =>
        use([{ ...local, versionHash: "newer-hash" }]).pipe(
          Effect.map((decision) => decision.value),
        ),
    };

    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "sync" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                {
                  entries: [
                    {
                      entry_id: "entry-1",
                      name: "deploy",
                      has_update: true,
                      latest_version: "2.0.0",
                      latest_content_hash: "update-hash",
                      current_version: "1.0.0",
                      download_url: "https://objects.test/archive",
                    },
                  ],
                },
              ],
              requests,
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(archiveInstalls).toBe(0);
    expect(result.stderr[0]).toContain("changed while its update was downloading");
    expect(JSON.parse(result.stdout.at(-1) ?? "")).toEqual({ synced: 0, failed: 1, total: 1 });
  });

  test("blocks a remote rollout before download when protected local paths exist", async () => {
    const requests: RegistryRequestOptions[] = [];
    let downloads = 0;
    let archiveInstalls = 0;
    const local: RegistryStateEntry = {
      entryId: "entry-1",
      name: "deploy",
      versionHash: "old-hash",
      version: "1.0.0",
      installPath: "/repo/.claude/skills/deploy",
      localContentHash: "local-content-hash",
    };
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed([local]),
      findProtectedPaths: () => Effect.succeed([".env.local", ".git", "node_modules"]),
      validatePersistedTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => {
        archiveInstalls += 1;
        return Effect.void;
      },
    };

    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "sync" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                {
                  entries: [
                    {
                      entry_id: "entry-1",
                      name: "deploy",
                      has_update: true,
                      latest_version: "2.0.0",
                      latest_content_hash: "update-hash",
                      current_version: "1.0.0",
                      download_url: "https://objects.test/archive",
                    },
                  ],
                },
              ],
              requests,
              Effect.sync(() => {
                downloads += 1;
                return new Uint8Array([1, 2, 3]);
              }),
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(downloads).toBe(0);
    expect(archiveInstalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(result.stderr[0]).toContain("Protected local paths");
  });

  test("reconciles a completed two-phase rollout after a crash without replacing files again", async () => {
    const requests: RegistryRequestOptions[] = [];
    let downloads = 0;
    let archiveInstalls = 0;
    const installedHash = "installed-update-hash";
    let state: RegistryStateEntry[] = [
      {
        entryId: "entry-1",
        name: "deploy",
        versionHash: "old-hash",
        version: "1.0.0",
        versionId: "old-version-id",
        installPath: "/repo/.claude/skills/deploy",
        localContentHash: "old-installed-hash",
        pendingUpdate: {
          receiptId: "stable-receipt-id",
          targetVersionHash: "update-hash",
          targetVersion: "2.0.0",
          targetVersionId: "new-version-id",
          previousVersionId: "old-version-id",
          observedContentHashBefore: "old-installed-hash",
          expectedInstalledContentHash: installedHash,
        },
      },
    ];
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed(state),
      computeInstalledContentHash: () => Effect.succeed(installedHash),
      validatePersistedTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => {
        archiveInstalls += 1;
        return Effect.void;
      },
      withStateTransaction: (use) =>
        use(state).pipe(
          Effect.map((decision) => {
            if (decision._tag === "Commit") state = [...decision.state];
            return decision.value;
          }),
        ),
    };

    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "sync" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                {
                  entries: [
                    {
                      entry_id: "entry-1",
                      name: "deploy",
                      has_update: true,
                      latest_version: "2.0.0",
                      latest_version_id: "new-version-id",
                      latest_content_hash: "update-hash",
                      current_version: "1.0.0",
                    },
                  ],
                },
              ],
              requests,
              Effect.sync(() => {
                downloads += 1;
                return new Uint8Array([1, 2, 3]);
              }),
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(result.stderr).toEqual([]);
    expect(downloads).toBe(0);
    expect(archiveInstalls).toBe(0);
    expect(state[0]?.pendingUpdate).toBeUndefined();
    expect(state[0]).toMatchObject({
      versionHash: "update-hash",
      version: "2.0.0",
      versionId: "new-version-id",
      localContentHash: installedHash,
      receiptId: "stable-receipt-id",
    });
  });

  test("applies the canonical archive when the workspace adopted the exact local suggestion", async () => {
    const requests: RegistryRequestOptions[] = [];
    const candidateHash = "a".repeat(64);
    const observedHash = "c".repeat(64);
    let archiveInstalls = 0;
    let downloads = 0;
    const local = {
      entryId: "entry-1",
      name: "deploy",
      versionHash: "b".repeat(64),
      version: "1.0.0",
      versionId: "base-version",
      installPath: "/repo/.claude/skills/deploy",
      localContentHash: "d".repeat(64),
      lastSuggestion: {
        observedContentHash: observedHash,
        candidateContentHash: candidateHash,
        baseVersionHash: "b".repeat(64),
        baseVersionId: "base-version",
        contributionId: "contribution-1",
        submittedAt: "2026-08-01T00:00:00.000Z",
      },
    };
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed([local]),
      computeInstalledContentHash: () => Effect.succeed(observedHash),
      validatePersistedTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => {
        archiveInstalls += 1;
        return Effect.void;
      },
      withStateTransaction: (use) => use([local]).pipe(Effect.map((decision) => decision.value)),
    };

    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "sync" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                {
                  entries: [
                    {
                      entry_id: "entry-1",
                      name: "deploy",
                      has_update: true,
                      latest_version: "1.0.1",
                      latest_version_id: "adopted-version",
                      latest_content_hash: candidateHash,
                      current_version: "1.0.0",
                      download_url: "https://objects.test/archive",
                    },
                  ],
                },
              ],
              requests,
              Effect.sync(() => {
                downloads += 1;
                return new Uint8Array([1, 2, 3]);
              }),
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(result.stderr).toEqual([]);
    expect(archiveInstalls).toBe(0);
    expect(downloads).toBe(0);
    expect(JSON.parse(result.stdout.at(-1) ?? "")).toEqual({ synced: 1, failed: 0, total: 1 });
  });

  test("scheduled automatic sync never submits local edits without an explicit suggestion", async () => {
    const requests: RegistryRequestOptions[] = [];
    const observedHash = "c".repeat(64);
    const candidateHash = "a".repeat(64);
    let state: RegistryStateEntry[] = [
      {
        entryId: "entry-1",
        name: "deploy",
        versionHash: "b".repeat(64),
        version: "1.0.0",
        versionId: "base-version",
        installPath: "/repo/.claude/skills/deploy",
        localContentHash: "d".repeat(64),
      },
    ];
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed(state),
      computeInstalledContentHash: () => Effect.succeed(observedHash),
      preparePackage: () =>
        Effect.succeed({
          name: "deploy",
          description: "Deploy safely",
          version: "1.0.0.team.cccccccccccc",
          archiveBuffer: Buffer.from("candidate"),
          archiveHash: candidateHash,
          manifest: [{ path: "SKILL.md", hash: "e".repeat(64), size: 42 }],
        }),
      validatePersistedTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      withStateTransaction: (use) =>
        use(state).pipe(
          Effect.map((decision) => {
            if (decision._tag === "Commit") state = [...decision.state];
            return decision.value;
          }),
        ),
    };

    const result = await Effect.runPromise(
      runRegistrySync({ automaticOnly: true }).pipe(
        Effect.provide(
          Layer.merge(recordingClientLayer([{ entries: [] }], requests), platformLayer(platform)),
        ),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map((request) => request.path)).toEqual(["/sync"]);
    expect(state[0]?.lastSuggestion).toBeUndefined();
  });

  test("submits the exact local candidate against its installed base without mutating state", async () => {
    const requests: RegistryRequestOptions[] = [];
    const candidateHash = "a".repeat(64);
    const baseHash = "b".repeat(64);
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () =>
        Effect.succeed([
          {
            entryId: "entry-1",
            name: "deploy",
            versionHash: baseHash,
            installPath: "/repo/.claude/skills/deploy",
          },
        ]),
      preparePush: () =>
        Effect.succeed({
          name: "deploy",
          description: "Deploy safely",
          version: "1.0.1",
          archiveBuffer: Buffer.from("exact-candidate"),
          archiveHash: candidateHash,
          manifest: [{ path: "SKILL.md", hash: "c".repeat(64), size: 42 }],
        }),
    };
    const result = await Effect.runPromise(
      runRegistryProgram({ operation: "suggest", summary: "Handle rollback failures" }).pipe(
        Effect.provide(
          Layer.merge(
            recordingClientLayer(
              [
                { entries: [{ id: "entry-1", name: "deploy" }] },
                {
                  entry: { id: "entry-1", name: "deploy" },
                  versions: [
                    {
                      id: "base-version-id",
                      version: "1.0.0",
                      content_hash: baseHash,
                      is_current: false,
                    },
                    {
                      id: "head-version-id",
                      version: "2.0.0",
                      content_hash: "d".repeat(64),
                      is_current: true,
                    },
                  ],
                },
                { id: "contribution-1", status: "pending" },
              ],
              requests,
            ),
            platformLayer(platform),
          ),
        ),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(requests[2]?.path).toBe("/api/v1/collaboration/registry/entry-1/contributions");
    const metadata = JSON.parse(String(requests[2]?.formData?.get("metadata")));
    expect(metadata).toMatchObject({
      baseVersionId: "base-version-id",
      candidateVersion: "1.0.1",
      candidateContentHash: candidateHash,
      summary: "Handle rollback failures",
    });
    expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject({
      contribution_id: "contribution-1",
      base_version: "1.0.0",
      status: "pending",
    });
  });

  test("keeps registration and rollout receipts in a durable outbox until delivery succeeds", async () => {
    let offline = true;
    const requests: RegistryRequestOptions[] = [];
    let state: RegistryStateEntry[] = [
      {
        entryId: "entry-1",
        name: "deploy",
        versionHash: "version-hash",
        version: "2.0.0",
        installPath: "/repo/.claude/skills/deploy",
        localContentHash: "installed-hash",
        pendingRegistration: {
          receiptId: "registration-receipt",
          installPath: "/repo/.claude/skills/deploy",
          installedContentHash: "installed-hash",
        },
        pendingReceipts: [
          {
            receiptId: "update-receipt",
            installedVersion: "2.0.0",
            installedContentHash: "installed-hash",
            previousVersionId: "version-1",
            status: "updated",
          },
        ],
      },
    ];
    const platform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed(state),
      withStateTransaction: (use) =>
        use(state).pipe(
          Effect.map((decision) => {
            if (decision._tag === "Commit") state = [...decision.state];
            return decision.value;
          }),
        ),
    };
    const client: RegistryClientService = {
      download: () => Effect.die(new Error("download was not expected")),
      request: <A>(schema: Schema.Decoder<A>, options: RegistryRequestOptions) => {
        requests.push(options);
        if (offline) {
          return Effect.fail(
            RegistryHttpError.make({ status: 503, message: "temporarily offline" }),
          );
        }
        return Schema.decodeUnknownEffect(schema)(
          options.path.endsWith("/install") ? { data: { id: "installation-1" } } : {},
        );
      },
    };
    const layer = Layer.merge(
      Layer.succeed(RegistryPlatform, platform),
      Layer.succeed(RegistryClient, client),
    );

    await Effect.runPromise(flushRegistryOutbox().pipe(Effect.provide(layer)));
    expect(state[0]?.pendingRegistration?.receiptId).toBe("registration-receipt");
    expect(state[0]?.pendingReceipts?.[0]?.receiptId).toBe("update-receipt");

    offline = false;
    await Effect.runPromise(flushRegistryOutbox().pipe(Effect.provide(layer)));
    expect(state[0]?.installationId).toBe("installation-1");
    expect(state[0]?.pendingRegistration).toBeUndefined();
    expect(state[0]?.pendingReceipts).toBeUndefined();
    expect(requests.map((request) => request.path)).toEqual([
      "/entry-1/install",
      "/entry-1/install",
      "/api/v1/collaboration/registry/entry-1/installations/installation-1/receipt",
    ]);
    expect(requests[1]?.body).toMatchObject({ receipt_id: "registration-receipt" });
    expect(requests[2]?.body).toMatchObject({ receiptId: "update-receipt" });
  });
});
