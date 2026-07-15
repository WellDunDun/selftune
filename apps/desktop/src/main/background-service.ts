import { execFile } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const BACKGROUND_SERVICE_PORT = 7888;
export const BACKGROUND_SERVICE_COMMAND_TIMEOUT_MS = 30_000;

export interface BackgroundServiceStatus {
  readonly detail: ReadonlyArray<string>;
  readonly pid: number | null;
  readonly platform: "darwin" | "linux" | "win32" | "unsupported";
  readonly registered: boolean;
  readonly running: boolean;
  readonly supported: boolean;
}

export interface BackgroundServiceOptions {
  readonly configDir: string;
  readonly executablePath: string;
  readonly resourceDir: string;
  readonly version: string;
}

type BackgroundServiceAction = "install" | "restart" | "start" | "status" | "stop" | "uninstall";

export class BackgroundServiceFailure extends Schema.TaggedErrorClass<BackgroundServiceFailure>()(
  "BackgroundServiceFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const ServiceStatusResponse = Schema.Struct({
  ok: Schema.Literal(true),
  action: Schema.Literals(["install", "restart", "start", "status", "stop", "uninstall"]),
  status: Schema.Struct({
    detail: Schema.Array(Schema.String),
    pid: Schema.NullOr(Schema.Number),
    platform: Schema.Literals(["darwin", "linux", "win32", "unsupported"]),
    registered: Schema.Boolean,
    running: Schema.Boolean,
  }),
});

function failure(operation: string, cause: unknown): BackgroundServiceFailure {
  return BackgroundServiceFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export function buildBackgroundServiceArgs(
  options: BackgroundServiceOptions,
  action: BackgroundServiceAction,
): ReadonlyArray<string> {
  return [
    "service",
    action,
    "--json",
    "--port",
    String(BACKGROUND_SERVICE_PORT),
    "--config-dir",
    options.configDir,
    "--executable",
    options.executablePath,
    "--resource-dir",
    options.resourceDir,
    "--owner",
    "desktop",
    "--version",
    options.version,
  ];
}

export function parseBackgroundServiceResponse(
  output: string,
): Omit<BackgroundServiceStatus, "supported"> {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .findLast(Boolean);
  if (!line) throw failure("parse-response", "The SelfTune CLI returned no response.");
  try {
    return Schema.decodeUnknownSync(ServiceStatusResponse)(JSON.parse(line)).status;
  } catch (cause) {
    throw failure("parse-response", cause);
  }
}

const runServiceCommand = Effect.fn("SelfTuneDesktop.serviceCommand")(function* (
  options: BackgroundServiceOptions,
  action: BackgroundServiceAction,
) {
  const output = yield* Effect.callback<string, BackgroundServiceFailure>((resume) => {
    const child = execFile(
      options.executablePath,
      [...buildBackgroundServiceArgs(options, action)],
      {
        cwd: options.resourceDir,
        encoding: "utf8",
        env: {
          ...process.env,
          SELFTUNE_DESKTOP: "1",
          SELFTUNE_RUNTIME_OWNER: "desktop",
          SELFTUNE_VERSION: options.version,
        },
        killSignal: "SIGTERM",
        timeout: BACKGROUND_SERVICE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              failure(
                action,
                stderr.trim() || stdout.trim() || error.message || "SelfTune CLI failed.",
              ),
            ),
          );
          return;
        }
        resume(Effect.succeed(stdout));
      },
    );
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
  });
  return yield* Effect.try({
    try: () => parseBackgroundServiceResponse(output),
    catch: (cause) => failure(action, cause),
  });
});

export const getBackgroundServiceStatus = Effect.fn("SelfTuneDesktop.serviceStatus")(function* (
  options: BackgroundServiceOptions,
) {
  const status = yield* runServiceCommand(options, "status");
  return {
    ...status,
    supported: status.platform !== "unsupported",
  } satisfies BackgroundServiceStatus;
});

export const installBackgroundService = Effect.fn("SelfTuneDesktop.serviceInstall")(function* (
  options: BackgroundServiceOptions,
) {
  yield* runServiceCommand(options, "install");
});

export const restartBackgroundService = Effect.fn("SelfTuneDesktop.serviceRestart")(function* (
  options: BackgroundServiceOptions,
) {
  yield* runServiceCommand(options, "restart");
});

export const startBackgroundService = Effect.fn("SelfTuneDesktop.serviceStart")(function* (
  options: BackgroundServiceOptions,
) {
  yield* runServiceCommand(options, "start");
});

export const stopBackgroundService = Effect.fn("SelfTuneDesktop.serviceStop")(function* (
  options: BackgroundServiceOptions,
) {
  yield* runServiceCommand(options, "stop");
});

export const uninstallBackgroundService = Effect.fn("SelfTuneDesktop.serviceUninstall")(function* (
  options: BackgroundServiceOptions,
) {
  yield* runServiceCommand(options, "uninstall");
});
