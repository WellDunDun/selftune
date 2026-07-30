import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export type TelemetryAction = "status" | "enable" | "disable";

export type TelemetryCommandAction = (action: TelemetryAction) => Effect.Effect<void, CLIError>;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load telemetry support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export const runTelemetryAction = Effect.fn("selftune.cli.telemetry")(function* (
  action: TelemetryAction,
) {
  const analytics = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/analytics"),
    catch: importFailure,
  });
  yield* Effect.try({
    try: () => {
      switch (action) {
        case "status":
          analytics.showTelemetryStatus();
          break;
        case "enable":
          analytics.enableTelemetry();
          break;
        case "disable":
          analytics.disableTelemetry();
          break;
      }
    },
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(
            `Telemetry operation failed: ${failureMessage(cause)}`,
            "OPERATION_FAILED",
            "selftune telemetry --help",
          ),
  });
});

export function makeTelemetryCommand(runAction: TelemetryCommandAction = runTelemetryAction) {
  const telemetryStatusCommand = Command.make("status", {}, () => runAction("status")).pipe(
    Command.withDescription("Show current telemetry status"),
  );
  const telemetryEnableCommand = Command.make("enable", {}, () => runAction("enable")).pipe(
    Command.withDescription("Enable anonymous usage analytics"),
  );
  const telemetryDisableCommand = Command.make("disable", {}, () => runAction("disable")).pipe(
    Command.withDescription("Disable anonymous usage analytics"),
  );

  return Command.make("telemetry", {}, () => runAction("status")).pipe(
    Command.withSubcommands([
      telemetryStatusCommand,
      telemetryEnableCommand,
      telemetryDisableCommand,
    ]),
    Command.withDescription(
      "Manage anonymous, non-identifying usage analytics. No PII, usernames, emails, " +
        "file paths, repository names, or session IDs are collected. Set " +
        "SELFTUNE_NO_ANALYTICS=1 to disable analytics via the environment. Privacy details: " +
        "https://github.com/selftune-dev/selftune#telemetry",
    ),
    Command.withExamples([
      { command: "selftune telemetry", description: "Show current telemetry status" },
      { command: "selftune telemetry enable", description: "Enable anonymous analytics" },
      { command: "selftune telemetry disable", description: "Disable anonymous analytics" },
    ]),
  );
}
