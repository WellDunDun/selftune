import { existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

const SIDECAR_SOURCE_PATHS = ["packages/harnesses"] as const;

export interface DevelopmentSidecarReloaderOptions {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly onError: (cause: unknown) => void;
  readonly restart: () => Promise<void>;
}

export function developmentSidecarSourceRoots(appPath: string): readonly string[] {
  const selfTuneRoot = resolve(appPath, "../..");
  return SIDECAR_SOURCE_PATHS.map((path) => resolve(selfTuneRoot, path));
}

export function isDevelopmentSidecarSource(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)(?:node_modules|dist|coverage|\.turbo)(?:\/|$)/.test(normalized)) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|json)$/.test(normalized);
}

export function startDevelopmentSidecarReloader(
  options: DevelopmentSidecarReloaderOptions,
): () => void {
  if (options.isPackaged) return () => undefined;

  const watchers: FSWatcher[] = [];
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let restartInFlight = false;
  let restartQueued = false;

  const restart = async (): Promise<void> => {
    if (closed) return;
    if (restartInFlight) {
      restartQueued = true;
      return;
    }
    restartInFlight = true;
    restartQueued = false;
    try {
      await options.restart();
    } catch (cause) {
      options.onError(cause);
    } finally {
      restartInFlight = false;
      if (restartQueued && !closed) scheduleRestart();
    }
  };

  const scheduleRestart = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void restart(), 750);
  };

  for (const sourceRoot of developmentSidecarSourceRoots(options.appPath)) {
    if (!existsSync(sourceRoot)) continue;
    try {
      const watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
        if (filename && isDevelopmentSidecarSource(filename)) scheduleRestart();
      });
      watcher.on("error", options.onError);
      watchers.push(watcher);
    } catch (cause) {
      options.onError(cause);
    }
  }

  return () => {
    closed = true;
    if (debounce) clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
  };
}
