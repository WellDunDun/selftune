import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DuckDbModuleResolutionOptions {
  readonly desktopResourceDirectory?: string;
  readonly executablePath?: string;
  readonly pathExists?: (path: string) => boolean;
}

export interface PackagedDuckDbModuleResolution {
  readonly modulePath: string;
  readonly resourceDirectory: string;
}

export function resolvePackagedDuckDbModule(
  options: DuckDbModuleResolutionOptions = {},
): PackagedDuckDbModuleResolution | undefined {
  const pathExists = options.pathExists ?? existsSync;
  const explicitResourceDirectory = options.desktopResourceDirectory?.trim();
  const candidates = [
    explicitResourceDirectory,
    options.executablePath ? dirname(options.executablePath) : undefined,
  ];

  for (const resourceDirectory of candidates) {
    if (!resourceDirectory) continue;
    const modulePath = join(resourceDirectory, "node_modules/@duckdb/node-api/lib/index.js");
    if (pathExists(modulePath)) return { modulePath, resourceDirectory };
  }
  return undefined;
}

export function resolvePackagedDuckDbModulePath(
  options: DuckDbModuleResolutionOptions = {},
): string | undefined {
  return resolvePackagedDuckDbModule(options)?.modulePath;
}
