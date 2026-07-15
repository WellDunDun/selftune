import * as Schema from "effect/Schema";

export class CatalogUnavailable extends Schema.TaggedErrorClass<CatalogUnavailable>()(
  "CatalogUnavailable",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
