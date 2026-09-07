import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export function serviceFromLayer<I, S, E>(key: Context.Service<I, S>, layer: Layer.Layer<I, E>): S {
  return Effect.runSync(Effect.service(key).pipe(Effect.provide(layer)));
}
