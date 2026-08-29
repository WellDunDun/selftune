import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  runAutomaticRegistrySuggestionScan,
  type AutomaticRegistrySuggestionOptions,
} from "../../packages/runtime/registry/automatic-suggestions.js";
import {
  RegistryClient,
  RegistryHttpError,
  type RegistryClientService,
  type RegistryRequestOptions,
} from "../../packages/runtime/registry/client.js";
import {
  RegistryPlatform,
  type PreparedRegistryPush,
  type RegistryPlatformService,
} from "../../packages/runtime/registry/platform.js";
import type { RegistryStateEntry } from "../../packages/runtime/registry/registry-state.js";

const baseHash = "b".repeat(64);
const installedHash = "i".repeat(64);
const editedHash = "e".repeat(64);
const candidateHash = "c".repeat(64);

function managedEntry(overrides: Partial<RegistryStateEntry> = {}): RegistryStateEntry {
  return {
    entryId: "entry-1",
    name: "deploy",
    versionHash: baseHash,
    version: "1.0.0",
    versionId: "base-version-1",
    installPath: "/repo/.claude/skills/deploy",
    localContentHash: installedHash,
    installationId: "installation-1",
    ...overrides,
  };
}

function prepared(): PreparedRegistryPush {
  return {
    name: "deploy",
    description: "Deploy safely",
    version: "1.0.0.team.eeeeeeeeeeee",
    archiveBuffer: Buffer.from("candidate"),
    archiveHash: candidateHash,
    manifest: [{ path: "SKILL.md", hash: "f".repeat(64), size: 42 }],
  };
}

function harness(input?: {
  readonly entry?: RegistryStateEntry;
  readonly observedHash?: string;
  readonly request?: RegistryClientService["request"];
}) {
  let state = [input?.entry ?? managedEntry()];
  const packageDirectories: string[] = [];
  const requests: RegistryRequestOptions[] = [];
  const service: RegistryPlatformService = {
    deviceId: "device-1",
    computeInstalledContentHash: () => Effect.succeed(input?.observedHash ?? editedHash),
    computeArchiveContentHash: () =>
      Effect.die(new Error("computeArchiveContentHash was not expected")),
    findProtectedPaths: () => Effect.succeed([]),
    installArchive: () => Effect.die(new Error("installArchive was not expected")),
    installFromGithub: () => Effect.die(new Error("installFromGithub was not expected")),
    loadState: () => Effect.succeed(state),
    preparePackage: (directory) => {
      packageDirectories.push(directory);
      return Effect.succeed(prepared());
    },
    preparePush: () => Effect.die(new Error("preparePush was not expected")),
    resolveInstallTarget: () => Effect.die(new Error("resolveInstallTarget was not expected")),
    validatePersistedTarget: (installPath) =>
      Effect.succeed({ installRoot: "/repo/.claude/skills", targetDir: installPath }),
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
      if (input?.request) return input.request(schema, options);
      return Schema.decodeUnknownEffect(schema)({
        id: "contribution-1",
        status: "pending",
      });
    },
  };
  const layer = Layer.merge(
    Layer.succeed(RegistryPlatform, service),
    Layer.succeed(RegistryClient, client),
  );
  return { layer, packageDirectories, requests, state: () => state };
}

function scan(
  layer: ReturnType<typeof harness>["layer"],
  options: AutomaticRegistrySuggestionOptions,
) {
  return Effect.runPromise(runAutomaticRegistrySuggestionScan(options).pipe(Effect.provide(layer)));
}

describe("automatic Registry suggestions", () => {
  test("arms a stable edit, submits its exact directory, and persists dedupe", async () => {
    let now = 1_000;
    const subject = harness();

    const armed = await scan(subject.layer, { now: () => now, stableForMs: 5_000 });
    expect(armed).toMatchObject({ armed: 1, submitted: 0 });
    expect(subject.requests).toHaveLength(0);

    now = 6_000;
    const submitted = await scan(subject.layer, { now: () => now, stableForMs: 5_000 });
    expect(submitted).toMatchObject({ submitted: 1, failed: 0 });
    expect(subject.packageDirectories).toEqual(["/repo/.claude/skills/deploy"]);
    expect(subject.requests).toHaveLength(1);
    expect(subject.requests[0]?.path).toBe("/api/v1/collaboration/registry/entry-1/contributions");
    expect(subject.state()[0]?.automaticSuggestion).toBeUndefined();
    expect(subject.state()[0]?.lastSuggestion).toMatchObject({
      observedContentHash: editedHash,
      candidateContentHash: candidateHash,
      contributionId: "contribution-1",
    });

    now = 60_000;
    const deduplicated = await scan(subject.layer, { now: () => now, stableForMs: 5_000 });
    expect(deduplicated.submitted).toBe(0);
    expect(subject.requests).toHaveLength(1);
  });

  test("keeps legacy state untrusted instead of uploading or relabeling unknown bytes", async () => {
    const subject = harness({ entry: managedEntry({ localContentHash: undefined }) });
    const result = await scan(subject.layer, { now: () => 1_000 });

    expect(result).toMatchObject({ submitted: 0, deferred: 1 });
    expect(subject.requests).toHaveLength(0);
    expect(subject.packageDirectories).toHaveLength(0);
    expect(subject.state()[0]?.localContentHash).toBeUndefined();
  });

  test("backs off transport failures and retries permission failures after a bounded cooldown", async () => {
    let now = 1_000;
    let postAttempts = 0;
    const subject = harness({
      request: <A>(schema: Schema.Decoder<A>, options: RegistryRequestOptions) => {
        if (options.method === "GET") {
          return Schema.decodeUnknownEffect(schema)({ contributions: [] });
        }
        postAttempts += 1;
        if (postAttempts === 3) {
          return Schema.decodeUnknownEffect(schema)({ id: "contribution-1", status: "pending" });
        }
        return Effect.fail(
          RegistryHttpError.make({
            status: postAttempts === 1 ? 503 : 403,
            message: "unavailable",
          }),
        );
      },
    });

    await scan(subject.layer, { now: () => now, stableForMs: 0, retryBaseMs: 30_000 });
    await scan(subject.layer, { now: () => now, stableForMs: 0, retryBaseMs: 30_000 });
    expect(subject.state()[0]?.automaticSuggestion).toMatchObject({
      attemptCount: 1,
      nextAttemptAt: 31_000,
    });

    now = 30_000;
    await scan(subject.layer, { now: () => now, stableForMs: 0, retryBaseMs: 30_000 });
    expect(postAttempts).toBe(1);

    now = 31_000;
    await scan(subject.layer, {
      now: () => now,
      stableForMs: 0,
      retryBaseMs: 30_000,
      blockedRetryMs: 900_000,
    });
    expect(subject.state()[0]?.automaticSuggestion).toMatchObject({
      attemptCount: 2,
      nextAttemptAt: 931_000,
      lastFailure: { kind: "blocked", code: "http_403", at: 31_000 },
    });

    now = 930_999;
    await scan(subject.layer, {
      now: () => now,
      stableForMs: 0,
      retryBaseMs: 30_000,
      blockedRetryMs: 900_000,
    });
    expect(postAttempts).toBe(2);

    now = 931_000;
    const recovered = await scan(subject.layer, {
      now: () => now,
      stableForMs: 0,
      retryBaseMs: 30_000,
      blockedRetryMs: 900_000,
    });
    expect(recovered.submitted).toBe(1);
    expect(postAttempts).toBe(3);
  });
});
