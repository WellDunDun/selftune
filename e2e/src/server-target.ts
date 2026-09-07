import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";

import {
  Artifacts,
  Browser,
  CapabilityUnavailable,
  capabilityUnavailable,
  FixtureData,
  LocalApi,
  RuntimeRestart,
  ScenarioFailure,
  Target,
  type TrackedUpdateFixture,
} from "./services";
import { BrowserCapabilityUnavailable, driveLibraryUpdateInBrowser } from "./local-target";

const LibraryPayload = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      updateStatus: Schema.Literals(["available", "current", "unknown", "untracked"]),
      revisions: Schema.Array(Schema.Struct({ contentHash: Schema.String })),
    }),
  ),
});

const CloudSourceSummary = Schema.Struct({
  id: Schema.String,
  skillId: Schema.NullOr(Schema.String),
  sourceType: Schema.Literals(["upload", "github", "cloud_draft"]),
  status: Schema.String,
  label: Schema.String,
  currentSnapshotId: Schema.NullOr(Schema.String),
  currentCapabilityStatus: Schema.NullOr(
    Schema.Literals(["cloud_ready", "cloud_limited", "cloud_blocked"]),
  ),
  repoFullName: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const CloudSourceDetail = Schema.Struct({ source: CloudSourceSummary });

const BrowserStorageState = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      domain: Schema.String,
      path: Schema.String,
      expires: Schema.optional(Schema.Number),
      secure: Schema.optional(Schema.Boolean),
    }),
  ),
});

function failure(step: string, cause: unknown): ScenarioFailure {
  return ScenarioFailure.make({
    step,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

class ServerCapabilityUnavailable extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = "ServerCapabilityUnavailable";
    this.capability = capability;
  }
}

function unavailable(cause: BrowserCapabilityUnavailable | ServerCapabilityUnavailable) {
  return CapabilityUnavailable.make({ capability: cause.capability, reason: cause.message });
}

export interface AttachedServerTargetOptions {
  target: "cloud" | "selfhost";
  dashboardUrl: string | null;
  runDirectory: string;
  fixture: TrackedUpdateFixture | null;
  token?: string;
  storageState?: string;
  restartUrl?: string;
  libraryItemId?: string;
  mutationContract?: "local-v2";
}

function resolveRequestHeaders(options: AttachedServerTargetOptions, dashboardUrl: string | null) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (!options.storageState || !dashboardUrl || !existsSync(options.storageState)) {
    return { headers: Object.keys(headers).length > 0 ? headers : undefined, error: null };
  }

  try {
    const state = Schema.decodeUnknownSync(BrowserStorageState)(
      JSON.parse(readFileSync(options.storageState, "utf8")),
    );
    const target = new URL(dashboardUrl);
    const now = Date.now() / 1_000;
    const cookies = state.cookies.filter((cookie) => {
      const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
      const domainMatches =
        target.hostname === domain ||
        (cookie.domain.startsWith(".") && target.hostname.endsWith(`.${domain}`));
      const live = cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > now;
      const secure = cookie.secure !== true || target.protocol === "https:";
      return domainMatches && live && secure && "/api/v1/cloud-sources".startsWith(cookie.path);
    });
    if (cookies.length > 0) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    }
    return { headers: Object.keys(headers).length > 0 ? headers : undefined, error: null };
  } catch (error) {
    return { headers: Object.keys(headers).length > 0 ? headers : undefined, error };
  }
}

function verifyCloudLibraryContract(
  options: AttachedServerTargetOptions,
  dashboardUrl: string,
  headers: Record<string, string> | undefined,
) {
  return Effect.tryPromise({
    try: async () => {
      const inventoryResponse = await fetch(new URL("/api/v1/cloud-sources", dashboardUrl), {
        headers,
      });
      if (inventoryResponse.status === 404 || inventoryResponse.status === 405) {
        throw new ServerCapabilityUnavailable(
          "library-inventory",
          "SelfTune Cloud does not expose the cloud source inventory contract.",
        );
      }
      if (!inventoryResponse.ok) {
        throw new Error(`Cloud source inventory returned ${inventoryResponse.status}.`);
      }
      const inventory = Schema.decodeUnknownSync(Schema.Array(CloudSourceSummary))(
        await inventoryResponse.json(),
      );
      const selected = options.libraryItemId
        ? inventory.find((source) => source.id === options.libraryItemId)
        : inventory[0];
      if (!selected) {
        throw new ServerCapabilityUnavailable(
          "library-detail-fixture",
          options.libraryItemId
            ? `Cloud source ${options.libraryItemId} is missing from the inventory.`
            : "Cloud source inventory is empty.",
        );
      }

      const detailResponse = await fetch(
        new URL(`/api/v1/cloud-sources/${encodeURIComponent(selected.id)}`, dashboardUrl),
        { headers },
      );
      if (detailResponse.status === 404 || detailResponse.status === 405) {
        throw new ServerCapabilityUnavailable(
          "library-detail",
          "SelfTune Cloud does not expose the cloud source detail contract.",
        );
      }
      if (!detailResponse.ok) {
        throw new Error(`Cloud source detail returned ${detailResponse.status}.`);
      }
      const detail = Schema.decodeUnknownSync(CloudSourceDetail)(await detailResponse.json());
      if (detail.source.id !== selected.id) {
        throw new Error(
          `Cloud source detail returned ${detail.source.id} for inventory source ${selected.id}.`,
        );
      }

      writeFileSync(
        join(options.runDirectory, "library-contract.json"),
        `${JSON.stringify(
          {
            target: options.target,
            contract: "cloud-sources-v1",
            inventory_count: inventory.length,
            inventory_id: selected.id,
            detail_id: detail.source.id,
            detail_label: detail.source.label,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    },
    catch: (cause) =>
      cause instanceof ServerCapabilityUnavailable
        ? unavailable(cause)
        : failure("verify Cloud Library inventory/detail contract", cause),
  });
}

export function attachedServerTargetLayer(options: AttachedServerTargetOptions) {
  const dashboardUrl = options.dashboardUrl;
  const restartUrl = options.restartUrl;
  const requestHeaders = resolveRequestHeaders(options, dashboardUrl);
  const headers = requestHeaders.headers;
  const mutationContract =
    options.mutationContract ?? (options.target === "selfhost" ? "local-v2" : null);
  const api = Layer.succeed(LocalApi, {
    skillState: (skillName: string) =>
      !dashboardUrl
        ? capabilityUnavailable(
            "server-endpoint",
            `Set SELFTUNE_E2E_${options.target.toUpperCase()}_URL for this target.`,
          )
        : mutationContract !== "local-v2"
          ? capabilityUnavailable(
              "source-update-review",
              `${options.target} does not expose the Local source-update state contract.`,
            )
          : Effect.tryPromise({
              try: async () => {
                const response = await fetch(new URL("/api/v2/library", dashboardUrl), { headers });
                if (response.status === 404 || response.status === 405) {
                  throw new ServerCapabilityUnavailable(
                    "library-inspection",
                    `${options.target} does not expose the attached Library inspection contract.`,
                  );
                }
                if (!response.ok) throw new Error(`Library API returned ${response.status}.`);
                const payload = Schema.decodeUnknownSync(LibraryPayload)(await response.json());
                const skill = payload.skills.find((candidate) => candidate.name === skillName);
                if (!skill) throw new Error(`${skillName} is missing from the Library.`);
                return {
                  name: skill.name,
                  update_status: skill.updateStatus,
                  installed_hash: skill.revisions[0]?.contentHash ?? null,
                };
              },
              catch: (cause) =>
                cause instanceof ServerCapabilityUnavailable
                  ? unavailable(cause)
                  : failure(`inspect ${options.target} Library API`, cause),
            }),
  });

  return Layer.mergeAll(
    Layer.succeed(Target, { id: options.target, worktree: dashboardUrl ?? "unconfigured" }),
    Layer.succeed(FixtureData, {
      trackedUpdate: () =>
        Effect.gen(function* () {
          if (!dashboardUrl) {
            return yield* capabilityUnavailable(
              "server-endpoint",
              `Set SELFTUNE_E2E_${options.target.toUpperCase()}_URL for this target.`,
            );
          }
          if (options.target === "cloud") {
            if (options.storageState && !existsSync(options.storageState)) {
              return yield* capabilityUnavailable(
                "browser-authentication",
                `Storage state ${options.storageState} does not exist.`,
              );
            }
            if (requestHeaders.error) {
              return yield* Effect.fail(
                failure("load browser authentication storage state", requestHeaders.error),
              );
            }
            yield* verifyCloudLibraryContract(options, dashboardUrl, headers);
          }
          if (mutationContract !== "local-v2") {
            return yield* capabilityUnavailable(
              "source-update-review",
              "SelfTune Cloud exposes cloud source inventory and detail, but not Local source-update review. Point the runner at a deliberate test instance and set SELFTUNE_E2E_CLOUD_SOURCE_UPDATE_CONTRACT=local-v2 to exercise mutation.",
            );
          }
          if (!restartUrl) {
            return yield* capabilityUnavailable(
              "runtime-restart",
              `${options.target} did not provide an isolated restart endpoint.`,
            );
          }
          return options.fixture
            ? options.fixture
            : yield* capabilityUnavailable(
                "fixture-data",
                `Set SELFTUNE_E2E_${options.target.toUpperCase()}_FIXTURE to a tracked-update fixture.`,
              );
        }),
    }),
    api,
    Layer.succeed(Browser, {
      reviewAndApplyLibraryUpdate: (skillName) =>
        !dashboardUrl
          ? capabilityUnavailable(
              "server-endpoint",
              `Set SELFTUNE_E2E_${options.target.toUpperCase()}_URL for this target.`,
            )
          : mutationContract !== "local-v2"
            ? capabilityUnavailable(
                "source-update-review",
                `${options.target} does not expose the Local source-update review contract.`,
              )
            : options.storageState && !existsSync(options.storageState)
              ? capabilityUnavailable(
                  "browser-authentication",
                  `Storage state ${options.storageState} does not exist.`,
                )
              : existsSync(chromium.executablePath())
                ? Effect.tryPromise({
                    try: () =>
                      driveLibraryUpdateInBrowser({
                        dashboardUrl,
                        skillName,
                        runDirectory: options.runDirectory,
                        headers,
                        storageState: options.storageState,
                      }),
                    catch: (cause) =>
                      cause instanceof BrowserCapabilityUnavailable
                        ? unavailable(cause)
                        : failure(`drive ${options.target} Library`, cause),
                  })
                : capabilityUnavailable("browser", "Chromium is not installed for this target."),
    }),
    Layer.succeed(RuntimeRestart, {
      restart: () =>
        restartUrl
          ? Effect.tryPromise({
              try: async () => {
                const response = await fetch(restartUrl, { method: "POST", headers });
                if (!response.ok) throw new Error(`Restart endpoint returned ${response.status}.`);
              },
              catch: (cause) => failure(`restart ${options.target}`, cause),
            })
          : capabilityUnavailable(
              "runtime-restart",
              `${options.target} did not provide an isolated restart endpoint.`,
            ),
    }),
    Layer.succeed(Artifacts, {
      runDirectory: options.runDirectory,
      log: (message) =>
        Effect.sync(() =>
          appendFileSync(join(options.runDirectory, "logs", "journey.log"), `${message}\n`),
        ),
    }),
  );
}
