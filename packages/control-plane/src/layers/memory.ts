import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { emptyLibrarySnapshot } from "../domain";
import { buildLibrarySnapshot } from "../reconcile";
import { Catalog } from "../services";

export const CatalogMemory = Layer.effect(
  Catalog,
  Effect.gen(function* () {
    const current = yield* Ref.make(emptyLibrarySnapshot);

    return Catalog.of({
      reconcile: Effect.fn("CatalogMemory.reconcile")(function* (observations) {
        const snapshot = buildLibrarySnapshot(observations);
        yield* Ref.set(current, snapshot);
        return snapshot;
      }),
      snapshot: Ref.get(current),
    });
  }),
);

export { CandidateStoreMemory } from "./candidate-memory";
