import { join } from "node:path";

import { resolveLoginShellPath } from "@selftune/runtime/login-shell-path";

import type { ServiceDescriptor } from "./service-contract.js";

export interface ServiceProgramArgumentOptions {
  readonly installationNonce?: string;
}

export function serviceProgramArguments(
  descriptor: ServiceDescriptor,
  options: ServiceProgramArgumentOptions = {},
): ReadonlyArray<string> {
  return [
    descriptor.executablePath,
    ...descriptor.executableArgsPrefix,
    "daemon",
    "run",
    "--foreground",
    "--supervised",
    "--owner",
    descriptor.owner,
    "--port",
    String(descriptor.port),
    "--hostname",
    "127.0.0.1",
    "--runtime-mode",
    "standalone",
    ...(descriptor.resourceDir ? ["--spa-dir", join(descriptor.resourceDir, "dashboard")] : []),
    ...(options.installationNonce
      ? ["--service-installation-nonce", options.installationNonce]
      : []),
  ];
}

export function serviceEnvironment(descriptor: ServiceDescriptor): Record<string, string> {
  return {
    PATH: resolveLoginShellPath(),
    SELFTUNE_CONFIG_DIR: descriptor.configDir,
    SELFTUNE_DESKTOP: descriptor.resourceDir ? "1" : "0",
    SELFTUNE_RUNTIME_OWNER: descriptor.owner,
    SELFTUNE_SUPERVISED: "1",
    SELFTUNE_VERSION: descriptor.version,
    SELFTUNE_SERVICE_VERSION: descriptor.version,
    SELFTUNE_BIN_PATH: descriptor.executablePath,
    ...(descriptor.resourceDir
      ? {
          SELFTUNE_DESKTOP_RESOURCE_DIR: descriptor.resourceDir,
          NODE_PATH: join(descriptor.resourceDir, "node_modules"),
        }
      : {}),
  };
}
