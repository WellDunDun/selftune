import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";

export interface DurableArtifactRecord {
  readonly path: string;
  readonly sha256: string;
}

export type DurableArtifactState = "matching" | "mismatch" | "missing";
export type DurableArtifactSetState = "matching" | "mismatch" | "partially-missing";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export const inspectDurableArtifact = Effect.fn("SelfTuneService.authority.inspectArtifact")(
  function* <E>(
    read: (path: string) => Effect.Effect<Uint8Array | null, E>,
    artifact: DurableArtifactRecord,
  ) {
    const contents = yield* read(artifact.path);
    if (contents === null) return "missing";
    return sha256Hex(contents) === artifact.sha256 ? "matching" : "mismatch";
  },
);

export const inspectDurableArtifactSet = Effect.fn("SelfTuneService.authority.inspectArtifactSet")(
  function* <E>(
    read: (path: string) => Effect.Effect<Uint8Array | null, E>,
    artifacts: ReadonlyArray<DurableArtifactRecord>,
  ) {
    if (artifacts.length === 0) return "partially-missing";
    const states = yield* Effect.forEach(artifacts, (artifact) =>
      inspectDurableArtifact(read, artifact),
    );
    if (states.some((state) => state === "mismatch")) return "mismatch";
    return states.every((state) => state === "matching") ? "matching" : "partially-missing";
  },
);
