import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import {
  createControlPlaneRuntime,
  type ControlPlaneRuntime,
} from "@selftune/runtime/control-plane-runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadLibraryCatalog, type LibraryCatalogOptions } from "@selftune/runtime/library-catalog";
import { resolveInstalledSkillMetadata } from "@selftune/runtime/skill-source-metadata";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";

export class DashboardLibraryService extends Context.Service<
  DashboardLibraryService,
  {
    readonly load: () => LibrarySnapshot | Promise<LibrarySnapshot>;
  }
>()("SelfTune/DashboardLibrary") {}

export function makeDashboardLibraryLayer(
  configRoot: string | undefined,
  loader?: () => LibrarySnapshot | Promise<LibrarySnapshot>,
) {
  return Layer.effect(DashboardLibraryService)(
    Effect.gen(function* () {
      const controlPlane = yield* Effect.acquireRelease(
        Effect.sync(createControlPlaneRuntime),
        (runtime) => Effect.promise(() => runtime.dispose()),
      );
      return { load: loader ?? makeLibraryReportLoader(configRoot, controlPlane) };
    }),
  );
}

export function loadLibraryReport(
  configRoot: string | undefined,
  controlPlane: ControlPlaneRuntime,
  options: Pick<
    LibraryCatalogOptions,
    "searchDirs" | "quarantineRoot" | "usageRows" | "workspacePaths"
  > = {},
): Promise<LibrarySnapshot> {
  return loadLibraryCatalog(
    {
      ...options,
      skillSetConfigRoot: configRoot,
      sourceMetadata: { updateMode: "cache-first" },
    },
    controlPlane,
  );
}

export function makeLibraryReportLoader(
  configRoot: string | undefined,
  controlPlane: ControlPlaneRuntime,
): () => Promise<LibrarySnapshot> {
  let metadataRefresh: Promise<void> | null = null;
  let nextMetadataRefreshAt = 0;

  const scheduleMetadataRefresh = (): void => {
    const now = Date.now();
    if (metadataRefresh || now < nextMetadataRefreshAt) return;
    nextMetadataRefreshAt = now + 6 * 60 * 60 * 1_000;
    metadataRefresh = Bun.sleep(1_000)
      .then(() =>
        resolveInstalledSkillMetadata(findInstalledSkillPackages(getDefaultSkillSearchDirs())),
      )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        metadataRefresh = null;
      });
  };

  return async () => {
    const snapshot = await loadLibraryReport(configRoot, controlPlane);
    scheduleMetadataRefresh();
    return snapshot;
  };
}
