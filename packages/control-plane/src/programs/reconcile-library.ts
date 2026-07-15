import * as Effect from "effect/Effect";

import type { LibraryObservation } from "../domain";
import { Catalog } from "../services";

export const reconcileLibrary = Effect.fn("Catalog.reconcile")(function* (
  observations: ReadonlyArray<LibraryObservation>,
) {
  const catalog = yield* Catalog;
  return yield* catalog.reconcile(observations);
});
