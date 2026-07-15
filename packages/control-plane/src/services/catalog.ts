import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { CatalogUnavailable, LibraryObservation, LibrarySnapshot } from "../domain";

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly reconcile: (
      observations: ReadonlyArray<LibraryObservation>,
    ) => Effect.Effect<LibrarySnapshot, CatalogUnavailable>;
    readonly snapshot: Effect.Effect<LibrarySnapshot, CatalogUnavailable>;
  }
>()("@selftune/control-plane/Catalog") {}
