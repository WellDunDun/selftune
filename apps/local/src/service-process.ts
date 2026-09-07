import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ProcessLaunchFailure = Schema.Struct({ code: Schema.String, message: Schema.String });
const ProcessExitFailure = Schema.Struct({ code: Schema.Number });

export interface ServiceProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function waitForClose(child: ReturnType<typeof execFile>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "close")
      .then(() => undefined)
      .catch(() => undefined),
    Bun.sleep(timeoutMs),
  ]);
}

async function terminateProcess(child: ReturnType<typeof execFile>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceful = waitForClose(child, 500);
  child.kill("SIGTERM");
  await graceful;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const forced = waitForClose(child, 1_000);
  child.kill("SIGKILL");
  await forced;
}

export function runServiceProcess<E>(
  command: string,
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> | undefined,
  failure: (operation: string, cause: string) => E,
): Effect.Effect<ServiceProcessResult, E> {
  return Effect.callback<ServiceProcessResult, E>((resume) => {
    const options: ExecFileOptionsWithStringEncoding = { encoding: "utf8" };
    if (environment) options.env = { ...process.env, ...environment };
    const child = execFile(command, [...args], options, (error, stdout, stderr) => {
      const launchFailure = Option.getOrNull(
        Schema.decodeUnknownOption(ProcessLaunchFailure)(error),
      );
      if (launchFailure) {
        resume(Effect.fail(failure(command, `${launchFailure.code}: ${launchFailure.message}`)));
        return;
      }
      resume(
        Effect.succeed({
          code:
            Option.getOrNull(Schema.decodeUnknownOption(ProcessExitFailure)(error))?.code ??
            (error ? 1 : 0),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        }),
      );
    });
    return Effect.promise(() => terminateProcess(child));
  });
}
