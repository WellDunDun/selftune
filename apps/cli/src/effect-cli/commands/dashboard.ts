import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  DEFAULT_DASHBOARD_PORT,
  type DashboardInput,
} from "@selftune/local/dashboard-cli-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export type DashboardAction = (input: DashboardInput) => Effect.Effect<void, CLIError>;

interface DashboardModule {
  readonly runDashboardProgram: (input: DashboardInput) => Effect.Effect<void, unknown>;
}

export interface DashboardActionDependencies {
  readonly loadModule: () => Promise<DashboardModule>;
}

const LIVE_DASHBOARD_DEPENDENCIES: DashboardActionDependencies = {
  loadModule: () => import("@selftune/local/dashboard"),
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function dashboardImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load dashboard support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toDashboardCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Dashboard failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune dashboard --help",
      );
}

export const runDashboardActionWithDependencies = Effect.fn("selftune.cli.dashboard")(function* (
  input: DashboardInput,
  dependencies: DashboardActionDependencies,
) {
  const dashboardModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: dashboardImportFailure,
  });
  const program = yield* Effect.try({
    try: () => dashboardModule.runDashboardProgram(input),
    catch: toDashboardCliError,
  });
  yield* program.pipe(Effect.mapError(toDashboardCliError));
});

export const runDashboardAction: DashboardAction = (input) =>
  runDashboardActionWithDependencies(input, LIVE_DASHBOARD_DEPENDENCIES);

export function makeDashboardCommand(action: DashboardAction = runDashboardAction) {
  return Command.make(
    "dashboard",
    {
      _noOperands: Argument.none.pipe(Argument.optional, Argument.withMetavar("")),
      port: Flag.integer("port").pipe(
        Flag.withDescription(`Listening port (default: ${DEFAULT_DASHBOARD_PORT})`),
        Flag.filter(
          (port) => port >= 1 && port <= 65_535,
          (port) => `Invalid port "${port}": must be an integer between 1 and 65535.`,
        ),
        Flag.withDefault(DEFAULT_DASHBOARD_PORT),
      ),
      restart: Flag.boolean("restart").pipe(
        Flag.withDescription("Restart an existing dashboard on the target port"),
      ),
      noOpen: Flag.boolean("no-open").pipe(Flag.withDescription("Start without opening a browser")),
      serve: Flag.boolean("serve").pipe(
        Flag.withDescription("Deprecated alias for the default behavior"),
      ),
    },
    (input) =>
      action({
        openBrowser: !input.noOpen,
        port: input.port,
        restart: input.restart,
        removedExport: false,
        removedOut: false,
        serve: input.serve,
      }),
  ).pipe(
    Command.withDescription("Start the local visual data dashboard"),
    Command.withExamples([
      { command: "selftune dashboard", description: "Start on port 3141 and open a browser" },
      {
        command: "selftune dashboard --port 8080 --no-open",
        description: "Start on a custom port without opening a browser",
      },
      {
        command: "selftune dashboard --restart",
        description: "Restart the dashboard on the target port",
      },
    ]),
  );
}
