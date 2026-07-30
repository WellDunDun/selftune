import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Data, Effect, FileSystem, Schema } from "effect";

import { SelftuneFileConfig } from "./schema.js";

export class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

const encodeConfig = (path: string, config: SelftuneFileConfig) =>
  Schema.encodeUnknownEffect(SelftuneFileConfig)(config).pipe(
    Effect.mapError((cause) => new ConfigWriteError({ path, cause })),
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => `${JSON.stringify(encoded, null, 2)}\n`,
        catch: (cause) => new ConfigWriteError({ path, cause }),
      }),
    ),
  );

const writeTemporaryFile = Effect.fn("Config.writeTemporaryFile")(function* (
  path: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = new TextEncoder().encode(contents);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
    }),
  );
});

export const writeConfig = Effect.fn("Config.writeConfig")(function* (
  path: string,
  config: SelftuneFileConfig,
): Effect.fn.Return<void, ConfigWriteError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* encodeConfig(path, config);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

  const write = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    yield* writeTemporaryFile(temporaryPath, contents);
    yield* fs.rename(temporaryPath, path);
    yield* fs.chmod(path, 0o600);
  }).pipe(Effect.mapError((cause) => new ConfigWriteError({ path, cause })));

  yield* write.pipe(
    Effect.ensuring(
      fs.remove(temporaryPath, { force: true }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

export function writeConfigSync(path: string, config: SelftuneFileConfig): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    const encoded = Schema.encodeUnknownSync(SelftuneFileConfig)(config);
    const contents = `${JSON.stringify(encoded, null, 2)}\n`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (cause) {
    throw new ConfigWriteError({ path, cause });
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
