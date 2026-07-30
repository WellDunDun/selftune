import type { LibrarySnapshot } from "@selftune/runtime/dashboard-contract";
import { type ControlPlaneRuntime } from "@selftune/runtime/control-plane-runtime";
import { loadLibraryCatalog } from "@selftune/runtime/library-catalog";
import { resolveInstalledSkillMetadata } from "@selftune/runtime/skill-source-metadata";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";

export function loadLibraryReport(
  configRoot: string | undefined,
  controlPlane: ControlPlaneRuntime,
): Promise<LibrarySnapshot> {
  return loadLibraryCatalog(
    {
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
