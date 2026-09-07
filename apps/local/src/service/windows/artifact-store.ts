import type * as Effect from "effect/Effect";

import type { WindowsServiceInstallationArtifactRecord } from "./installation/model.js";

export interface WindowsServiceArtifactRemoval {
  readonly artifact: WindowsServiceInstallationArtifactRecord;
  readonly generation: string;
}

export interface WindowsServiceInstallationArtifactStore<E = unknown> {
  readonly read: (path: string) => Effect.Effect<Uint8Array | null, E>;
  readonly removeMatching: (removal: WindowsServiceArtifactRemoval) => Effect.Effect<void, E>;
  readonly write: (path: string, contents: Uint8Array) => Effect.Effect<void, E>;
}

const SAFE_GENERATION_PATTERN = /^[A-Za-z0-9_-]+$/;

export function windowsServiceArtifactQuarantinePath(path: string, generation: string): string {
  if (!SAFE_GENERATION_PATTERN.test(generation)) {
    throw new Error("Windows service artifact quarantine requires a safe generation identifier.");
  }
  return `${path}.selftune-quarantine-${generation}`;
}
