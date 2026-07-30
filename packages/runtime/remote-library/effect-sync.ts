import { resolve } from "node:path";
import type { Database } from "bun:sqlite";

import type { SyncPreferences } from "@selftune/control-plane";
import { LibraryError } from "@selftune/library/errors";
import {
  diagnoseRemoteEffect,
  exportRemoteLibraryEffect,
  syncRemoteObjectsEffect,
} from "@selftune/library/remote/effect-sync";
import { previewRemoteObjects } from "@selftune/library/remote/sync";
import { getDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { LibraryCatalogOptions } from "../library/catalog.js";
import { CLIError } from "../utils/cli-error.js";
import { collectLocalObjectsEffect } from "./collect.js";
import { pullRemoteLibraryStateEffect } from "./effect-pull.js";

export { diagnoseRemoteEffect, exportRemoteLibraryEffect };

export interface PreviewRemoteLibrarySyncEffectOptions {
  readonly configRoot?: string;
  readonly preferences: SyncPreferences;
  readonly selectedSkillIds?: ReadonlyArray<string>;
  readonly catalogOptions?: LibraryCatalogOptions;
  readonly db?: Database;
}

export interface SyncRemoteLibraryEffectOptions extends PreviewRemoteLibrarySyncEffectOptions {
  readonly now?: Date;
}

function localSyncFailure(operation: string, cause: unknown): CLIError | LibraryError {
  if (cause instanceof CLIError || cause instanceof LibraryError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CLIError(
    `Sync & Backup could not finish ${operation}: ${detail}`,
    "OPERATION_FAILED",
    "Review the local Library state and retry Sync & Backup.",
  );
}

const resolveLocalSyncState = Effect.fn("selftune.runtime.remoteLibrary.resolveLocalState")(
  function* (options: PreviewRemoteLibrarySyncEffectOptions) {
    const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
    const db =
      options.db ??
      (configRoot === resolve(SELFTUNE_CONFIG_DIR)
        ? yield* Effect.try({
            try: () => getDb(),
            catch: (cause) => localSyncFailure("opening the local database", cause),
          })
        : undefined);
    const objects = yield* collectLocalObjectsEffect({
      configRoot,
      preferences: options.preferences,
      selectedSkillIds: options.selectedSkillIds,
      catalogOptions: options.catalogOptions,
      db,
    }).pipe(
      Effect.mapError((cause) => localSyncFailure("collecting local Library objects", cause)),
    );
    return { configRoot, db, objects };
  },
);

export const previewRemoteLibrarySyncEffect = Effect.fn(
  "selftune.runtime.remoteLibrary.previewSync",
)(function* (options: PreviewRemoteLibrarySyncEffectOptions) {
  const state = yield* resolveLocalSyncState(options);
  return previewRemoteObjects(state.objects);
});

export const syncRemoteLibraryEffect = Effect.fn("selftune.runtime.remoteLibrary.sync")(function* (
  options: SyncRemoteLibraryEffectOptions,
) {
  const state = yield* resolveLocalSyncState(options);
  return yield* syncRemoteObjectsEffect({
    objects: state.objects,
    now: options.now,
    onSnapshot: (snapshot) =>
      pullRemoteLibraryStateEffect({
        configRoot: state.configRoot,
        snapshot,
        preferences: options.preferences,
        db: state.db,
      }),
  });
});
