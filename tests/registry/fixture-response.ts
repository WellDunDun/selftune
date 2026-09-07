import { Effect, Schema } from "effect";
import { RegistryResponseDecodeError } from "../../packages/runtime/registry/client.js";

export function decodeFixtureResponse<A>(
  schema: Schema.Decoder<A>,
  payload: typeof Schema.Json.Type,
) {
  return Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError((cause) =>
      RegistryResponseDecodeError.make({ status: 200, message: cause.message }),
    ),
  );
}
