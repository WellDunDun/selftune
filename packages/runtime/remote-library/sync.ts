import type { Database } from "bun:sqlite";
import { resolve } from "node:path";

import type { RemoteArtifact, RemoteSnapshot, SyncPreferences } from "@selftune/control-plane";
import {
  diagnoseRemote,
  exportRemoteLibrary,
  previewRemoteObjects,
  syncRemoteObjects,
} from "@selftune/library/remote/sync";
import type { RemoteLibraryHandle } from "@selftune/library/remote/transport";
import { getDb } from "@selftune/local-store";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { LibraryCatalogOptions } from "../library/catalog.js";
import { collectLocalObjects } from "./collect.js";
import { pullRemoteLibraryState } from "./pull.js";

export { diagnoseRemote, exportRemoteLibrary };
export { encodePackageBundle } from "./package-bundle.js";
export { materializeSkillSetDependencies } from "./pull.js";
export { restoreRemoteLibrary } from "./restore.js";

export async function previewRemoteLibrarySync(options: {
  configRoot?: string;
  preferences: SyncPreferences;
  catalogOptions?: LibraryCatalogOptions;
  db?: Database;
}): Promise<{
  artifacts: Array<RemoteArtifact & { bytes: number; preview: unknown }>;
  totalBytes: number;
}> {
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const db = options.db ?? (configRoot === resolve(SELFTUNE_CONFIG_DIR) ? getDb() : undefined);
  const objects = await collectLocalObjects({
    configRoot,
    preferences: options.preferences,
    catalogOptions: options.catalogOptions,
    db,
  });
  return previewRemoteObjects(objects);
}

export async function syncRemoteLibrary(options: {
  handle: RemoteLibraryHandle;
  configRoot?: string;
  preferences: SyncPreferences;
  selectedSkillIds?: ReadonlyArray<string>;
  catalogOptions?: LibraryCatalogOptions;
  db?: Database;
  now?: Date;
}): Promise<{
  snapshot: RemoteSnapshot;
  uploaded: number;
  unchanged: number;
  syncedArtifacts: ReadonlyArray<RemoteArtifact>;
}> {
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const db = options.db ?? (configRoot === resolve(SELFTUNE_CONFIG_DIR) ? getDb() : undefined);
  const localObjects = await collectLocalObjects({
    configRoot,
    preferences: options.preferences,
    selectedSkillIds: options.selectedSkillIds,
    catalogOptions: options.catalogOptions,
    db,
  });
  const result = await syncRemoteObjects({
    handle: options.handle,
    objects: localObjects,
    now: options.now,
    onSnapshot: (snapshot) =>
      pullRemoteLibraryState({
        handle: options.handle,
        configRoot,
        snapshot,
        preferences: options.preferences,
        db,
      }),
  });
  return {
    ...result,
    syncedArtifacts: localObjects.map((object) => object.artifact),
  };
}
