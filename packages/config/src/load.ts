import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { readFileSync } from "node:fs";

import { SelftuneFileConfig } from "./schema.js";

export class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export const loadConfig = Effect.fn("Config.loadConfig")(function* (
  path: string,
): Effect.fn.Return<
  SelftuneFileConfig | null,
  ConfigParseError | PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return null;

  const source = yield* fs.readFileString(path);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SelftuneFileConfig))(source).pipe(
    Effect.mapError(
      (error) =>
        new ConfigParseError({
          path,
          message: error.message,
        }),
    ),
  );
});

export function loadConfigSync(path: string): SelftuneFileConfig | null {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }

  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(SelftuneFileConfig))(source);
  } catch (cause) {
    throw new ConfigParseError({
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
