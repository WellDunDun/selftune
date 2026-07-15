import { resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class PackageBuildFailure extends Schema.TaggedErrorClass<PackageBuildFailure>()(
  "PackageBuildFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const repositoryRoot = resolve(import.meta.dirname, "..");
type InterruptSignal = "SIGINT" | "SIGTERM";
let interruptedSignal: InterruptSignal | undefined;
let cancelActiveCommand: (() => void) | undefined;

function failure(operation: string, cause: unknown): PackageBuildFailure {
  return PackageBuildFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const runCommand = Effect.fn("SelfTune.PackageBuild.runCommand")(function* (
  operation: string,
  command: string[],
  allowAfterSignal = false,
) {
  if (interruptedSignal && !allowAfterSignal) {
    return yield* PackageBuildFailure.make({
      operation,
      message: `Interrupted by ${interruptedSignal}.`,
    });
  }
  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(command, {
        cwd: repositoryRoot,
        stderr: "pipe",
        stdout: "pipe",
      });
      cancelActiveCommand = () => {
        try {
          child.kill();
        } catch {
          // The command already exited.
        }
      };
      try {
        const [exitCode, stderr, stdout] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        return { exitCode, stderr, stdout };
      } finally {
        cancelActiveCommand = undefined;
      }
    },
    catch: (cause) => failure(operation, cause),
  });

  if (result.exitCode !== 0) {
    return yield* PackageBuildFailure.make({
      operation,
      message: `${command.join(" ")} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    });
  }
  return result;
});

const restorePackage = () =>
  runCommand(
    "restore package manifests",
    ["node", "scripts/publish-package-json.cjs", "restore"],
    true,
  );

const preparePackage = runCommand("prepare package manifests", [
  "node",
  "scripts/publish-package-json.cjs",
  "prepare",
]).pipe(
  Effect.catch((error) =>
    restorePackage().pipe(
      Effect.orDie,
      Effect.flatMap(() => Effect.fail(error)),
    ),
  ),
);

const preparedPackage = Effect.acquireRelease(preparePackage, () =>
  restorePackage().pipe(Effect.orDie),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* preparedPackage;
    const result = yield* runCommand("pack npm artifact", [
      "npm",
      "pack",
      "--ignore-scripts",
      ...process.argv.slice(2),
    ]);
    yield* Effect.sync(() => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    });
  }),
);

const interrupt = (signal: InterruptSignal): void => {
  interruptedSignal ??= signal;
  cancelActiveCommand?.();
};
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);

Effect.runPromise(program)
  .catch((cause) => {
    if (interruptedSignal) {
      return;
    }
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (interruptedSignal) process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  });
