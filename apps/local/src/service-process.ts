import { execFile } from "node:child_process";
import { once } from "node:events";

import * as Effect from "effect/Effect";

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
  failure: (operation: string, cause: unknown) => E,
): Effect.Effect<ServiceProcessResult, E> {
  return Effect.callback<ServiceProcessResult, E>((resume) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          resume(Effect.fail(failure(command, `${error.code}: ${error.message}`)));
          return;
        }
        resume(
          Effect.succeed({
            code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          }),
        );
      },
    );
    return Effect.promise(() => terminateProcess(child));
  });
}
