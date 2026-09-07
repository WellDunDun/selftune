/* oxlint-disable no-console -- the command boundary owns the public JSON result */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type { UninstallOptions } from "../../commands/uninstall/types.js";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export type UninstallAction = (input: UninstallOptions) => Effect.Effect<void, CLIError>;

export const UNINSTALL_INTERNAL_HELP_FLAG = "selftune-internal-uninstall-help";
export const UNINSTALL_HELP = `selftune uninstall — Clean removal of all selftune data and configuration

Usage:
  selftune uninstall [options]

Options:
  --dry-run        Preview what would be removed without deleting anything
  --keep-logs      Preserve JSONL telemetry logs (remove everything else)
  --npm-uninstall  Also run 'npm uninstall -g selftune'
  --help           Show this help message

Removes:
  1. Persistent SelfTune background service
  2. Sync & Backup credential from the OS credential store
  3. Autonomy scheduling (launchd/cron/systemd)
  4. Selftune hooks from ~/.claude/settings.json (preserves user hooks)
  5. Selftune-managed Claude subagents from ~/.claude/agents/
  6. JSONL telemetry logs from ~/.claude/
  7. Selftune config directory (~/.selftune/)
  8. Ingest marker files
  9. npm global package (with --npm-uninstall)`;

const decodeFailureMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

function failureMessage(cause: unknown): string {
  const decoded = decodeFailureMessage(cause);
  if (Option.isSome(decoded)) return decoded.value.message;
  return cause instanceof Error ? cause.message : String(cause);
}

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load uninstall support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toUninstallCliError(cause: unknown): CLIError {
  return new CLIError(failureMessage(cause), "OPERATION_FAILED", "selftune uninstall --dry-run");
}

const runLiveUninstall = Effect.fn("selftune.cli.uninstall.live")(function* (
  input: UninstallOptions,
) {
  const { CredentialStoreLive } = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/credential-store"),
    catch: importFailure,
  });
  const { UninstallDependenciesLive } = yield* Effect.tryPromise({
    try: () => import("../../commands/uninstall/live-dependencies.js"),
    catch: importFailure,
  });
  const { runUninstallProgram } = yield* Effect.tryPromise({
    try: () => import("../../commands/uninstall/program.js"),
    catch: importFailure,
  });

  const result = yield* runUninstallProgram(input).pipe(
    Effect.provide(UninstallDependenciesLive.pipe(Layer.provide(CredentialStoreLive))),
    Effect.mapError(toUninstallCliError),
  );
  yield* Effect.sync(() => console.log(JSON.stringify(result, null, 2)));
});

export function makeUninstallCommand(action: UninstallAction = runLiveUninstall) {
  return Command.make(
    "uninstall",
    {
      internalHelp: Flag.boolean(UNINSTALL_INTERNAL_HELP_FLAG),
      dryRun: Flag.boolean("dry-run").pipe(
        Flag.withDescription("Preview what would be removed without deleting anything"),
      ),
      keepLogs: Flag.boolean("keep-logs").pipe(
        Flag.withDescription("Preserve legacy JSONL telemetry logs"),
      ),
      npmUninstall: Flag.boolean("npm-uninstall").pipe(
        Flag.withDescription("Also run 'npm uninstall -g selftune'"),
      ),
    },
    (input) => {
      if (input.internalHelp) return Console.log(UNINSTALL_HELP);
      return action({
        dryRun: input.dryRun,
        keepLogs: input.keepLogs,
        npmUninstall: input.npmUninstall,
      });
    },
  ).pipe(
    Command.withDescription(`Clean removal of all SelfTune data and configuration

Removes, in order:
  1. Persistent SelfTune background service
  2. Sync & Backup credential from the OS credential store
  3. Autonomy scheduling (launchd/cron/systemd)
  4. SelfTune hooks from ~/.claude/settings.json (preserves user hooks)
  5. SelfTune-managed Claude subagents from ~/.claude/agents/
  6. Legacy JSONL telemetry logs from ~/.claude/
  7. SelfTune config directory (~/.selftune/)
  8. Ingest marker files
  9. npm global package (with --npm-uninstall)`),
  );
}
