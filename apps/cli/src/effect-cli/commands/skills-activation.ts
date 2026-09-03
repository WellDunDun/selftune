import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { LibraryError } from "@selftune/library";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import {
  activateSkills,
  activeSkills,
  deactivateSkills,
  loadSkill,
  previewActivation,
  previewDeactivation,
  type SkillSelection,
} from "@selftune/runtime/skill-search/activation";

const execute = Effect.fn("selftune.skills.activation")(function* <A>(run: () => A) {
  const result = yield* Effect.try({
    try: run,
    catch: (error) =>
      error instanceof CLIError
        ? error
        : error instanceof LibraryError
          ? new CLIError(error.message, error.code, error.suggestion, error.exitCode)
          : new CLIError(
              error instanceof Error ? error.message : String(error),
              "OPERATION_FAILED",
              "selftune skills active --json",
            ),
  });
  yield* Console.log(JSON.stringify(result, null, 2));
});

export function makeSkillsActivationCommands() {
  const project = Flag.string("project").pipe(Flag.withDefault("."));
  const json = Flag.boolean("json");
  const task = Flag.string("task");
  const approval = { yes: Flag.boolean("yes"), dryRun: Flag.boolean("dry-run") };
  const lookup = { searchDirs: Flag.string("search-dir").pipe(Flag.atLeast(0)) };
  const activate = Command.make(
    "activate",
    {
      project,
      task,
      json,
      ...approval,
      ...lookup,
      ids: Flag.string("id").pipe(Flag.atLeast(0)),
      set: Flag.string("set").pipe(Flag.optional),
      harness: Flag.choice("harness", ["codex", "claude_code", "opencode", "openclaw", "pi"]),
    },
    (input) =>
      execute(() => {
        const setId = Option.getOrUndefined(input.set);
        if ((setId !== undefined) === input.ids.length > 0)
          throw new CLIError(
            "Choose --id (repeatable) or --set, but not both.",
            "INVALID_ARGUMENT",
          );
        const selection: SkillSelection = setId === undefined ? { ids: input.ids } : { setId };
        const options = {
          project: input.project,
          task: input.task,
          harness: input.harness,
          selection,
          searchDirs: input.searchDirs.length ? input.searchDirs : undefined,
        };
        return !input.yes || input.dryRun
          ? { status: "preview", plan: previewActivation(options) }
          : { status: "active", receipt: activateSkills(options) };
      }),
  ).pipe(
    Command.withDescription(
      "Temporarily activate selected local skills for a task; previews unless --yes.",
    ),
  );
  const active = Command.make(
    "active",
    { project, json, task: task.pipe(Flag.optional) },
    (input) =>
      execute(() => ({
        activations: activeSkills({
          project: input.project,
          task: Option.getOrUndefined(input.task),
        }),
      })),
  ).pipe(Command.withDescription("List unfinished temporary skill activations in this project."));
  const deactivate = Command.make(
    "deactivate",
    {
      project,
      json,
      ...approval,
      task: task.pipe(Flag.optional),
      receipt: Flag.string("receipt").pipe(Flag.optional),
    },
    (input) =>
      execute(() => {
        const taskId = Option.getOrUndefined(input.task);
        const receiptId = Option.getOrUndefined(input.receipt);
        if ((taskId === undefined) === (receiptId === undefined))
          throw new CLIError("Choose --task or --receipt, but not both.", "INVALID_ARGUMENT");
        const owner = taskId !== undefined ? { task: taskId } : { receipt: receiptId ?? "" };
        const options = { project: input.project, owner };
        return !input.yes || input.dryRun
          ? { status: "preview", plans: previewDeactivation(options) }
          : { status: "cleaned", receipts: deactivateSkills(options) };
      }),
  ).pipe(
    Command.withDescription(
      "Remove only this task's temporary project paths; previews unless --yes.",
    ),
  );
  const load = Command.make("load", { id: Flag.string("id"), json, ...lookup }, (input) =>
    execute(() =>
      loadSkill(input.id, { searchDirs: input.searchDirs.length ? input.searchDirs : undefined }),
    ),
  ).pipe(
    Command.withDescription(
      "Read one exact local skill revision without installing or executing it.",
    ),
  );
  return [activate, active, deactivate, load];
}
