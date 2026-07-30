import {
  reconcileLibrary,
  type LibraryObservation,
  type LibrarySnapshot,
} from "@selftune/control-plane";
import {
  collectCatalogObservations,
  type CatalogSkillPackage,
  type CatalogUsageObservation,
} from "@selftune/library/catalog";
import { getDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { createControlPlaneRuntime, type ControlPlaneRuntime } from "../control-plane-runtime.js";
import {
  queryKnownWorkspacePaths,
  queryTrustedSkillObservationRows,
  type TrustedSkillObservationRow,
} from "../localdb/queries.js";
import { listQuarantinedSkills, QUARANTINE_DIR } from "../skill-portfolio/quarantine.js";
import {
  resolveInstalledSkillMetadataEffect,
  type SkillSourceMetadataOptions,
} from "../source-management/metadata-adapter.js";
import {
  computeSkillVersionHash,
  extendSkillSearchDirsForWorkspaces,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "../utils/skill-discovery.js";
import { inferSkillHarness } from "../utils/skill-harness.js";
import { CLIError } from "../utils/cli-error.js";

export interface LibraryCatalogOptions {
  searchDirs?: string[];
  additionalSearchDirs?: ReadonlyArray<string>;
  skillSetConfigRoot?: string;
  quarantineRoot?: string;
  usageRows?: ReadonlyArray<TrustedSkillObservationRow>;
  sourceMetadata?: SkillSourceMetadataOptions;
  versionHashLoader?: (skillPath: string) => string | undefined;
  workspacePaths?: ReadonlyArray<string>;
}

function loadTrustedUsageRows(): TrustedSkillObservationRow[] {
  try {
    return queryTrustedSkillObservationRows(getDb());
  } catch {
    return [];
  }
}

function loadKnownWorkspacePaths(): string[] {
  try {
    return queryKnownWorkspacePaths(getDb());
  } catch {
    return [];
  }
}

function resolveCatalogSearchDirs(options: LibraryCatalogOptions): string[] {
  const base =
    options.searchDirs ??
    extendSkillSearchDirsForWorkspaces(
      getDefaultSkillSearchDirs(),
      options.workspacePaths ?? loadKnownWorkspacePaths(),
    );
  return [
    ...new Set([...base, ...(options.additionalSearchDirs ?? [])].map((path) => resolve(path))),
  ];
}

function catalogCollectionFailure(cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CLIError(
    `Library catalog collection failed: ${detail}`,
    "OPERATION_FAILED",
    "Review local skill sources and retry selftune library list.",
  );
}

export const collectLibraryObservationsEffect = Effect.fn(
  "selftune.runtime.library.collectObservations",
)(function* (options: LibraryCatalogOptions = {}) {
  const { configRoot, installedPackages } = yield* Effect.try({
    try: () => ({
      configRoot: resolve(options.skillSetConfigRoot ?? SELFTUNE_CONFIG_DIR),
      installedPackages: findInstalledSkillPackages(resolveCatalogSearchDirs(options)),
    }),
    catch: catalogCollectionFailure,
  });
  const installedMetadata = yield* resolveInstalledSkillMetadataEffect(
    installedPackages,
    options.sourceMetadata,
  ).pipe(Effect.mapError(catalogCollectionFailure));
  return yield* Effect.try({
    try: () =>
      collectCatalogObservations({
        configRoot,
        installedPackages,
        installedMetadata,
        usageRows: (options.usageRows ??
          loadTrustedUsageRows()) satisfies ReadonlyArray<CatalogUsageObservation>,
        quarantinedSkills: listQuarantinedSkills(options.quarantineRoot ?? QUARANTINE_DIR),
        findPackages: (searchDirs): CatalogSkillPackage[] => findInstalledSkillPackages(searchDirs),
        inferHarness: inferSkillHarness,
        versionHashLoader: options.versionHashLoader ?? computeSkillVersionHash,
      }),
    catch: catalogCollectionFailure,
  });
});

export function collectLibraryObservations(
  options: LibraryCatalogOptions = {},
): Promise<LibraryObservation[]> {
  return Effect.runPromise(collectLibraryObservationsEffect(options));
}

export const loadLibraryCatalogEffect = Effect.fn("selftune.runtime.library.loadCatalog")(
  function* (options: LibraryCatalogOptions = {}) {
    const observations = yield* collectLibraryObservationsEffect(options);
    return yield* reconcileLibrary(observations);
  },
);

export async function loadLibraryCatalog(
  options: LibraryCatalogOptions = {},
  runtime?: ControlPlaneRuntime,
): Promise<LibrarySnapshot> {
  const ownedRuntime = runtime ?? createControlPlaneRuntime();
  try {
    return await ownedRuntime.reconcile(await collectLibraryObservations(options));
  } finally {
    if (!runtime) await ownedRuntime.dispose();
  }
}

export async function cliMain(): Promise<void> {
  const snapshot = await loadLibraryCatalog();
  console.log(JSON.stringify(snapshot, null, 2));
}
