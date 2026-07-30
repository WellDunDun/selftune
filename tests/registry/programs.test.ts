import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  RegistryClient,
  type RegistryClientService,
  type RegistryRequestOptions,
} from "../../packages/runtime/registry/client.js";
import {
  RegistryPlatform,
  type RegistryPlatformService,
} from "../../packages/runtime/registry/platform.js";
import { runRegistryProgram } from "../../packages/runtime/registry/programs.js";

function clientLayer(payload: unknown) {
  const service: RegistryClientService = {
    download: () => Effect.die("download was not expected"),
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
  installArchive: () => Effect.die("installArchive was not expected"),
  installFromGithub: () => Effect.die("installFromGithub was not expected"),
  loadState: () => Effect.die("loadState was not expected"),
  preparePush: () => Effect.die("preparePush was not expected"),
  resolveInstallTarget: () => Effect.die("resolveInstallTarget was not expected"),
  validatePersistedTarget: () => Effect.die("validatePersistedTarget was not expected"),
  withStateTransaction: () => Effect.die("withStateTransaction was not expected"),
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
    const installPlatform: RegistryPlatformService = {
      ...unusedPlatform,
      loadState: () => Effect.succeed([]),
      resolveInstallTarget: () =>
        Effect.succeed({
          installRoot: "/repo/.claude/skills",
          targetDir: "/repo/.claude/skills/deploy",
        }),
      installArchive: () => Effect.void,
      withStateTransaction: (use) => use([]).pipe(Effect.map((decision) => decision.value)),
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
                {},
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
});
