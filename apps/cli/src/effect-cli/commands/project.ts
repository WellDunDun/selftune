import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export interface ProjectConfigurationInput {
  readonly projectRoot: string;
  readonly skillSetIds: ReadonlyArray<string>;
}

export type ProjectAction = (
  operation: "plan" | "configure" | "init",
  input: ProjectConfigurationInput,
  jsonRequested: boolean,
) => Effect.Effect<void, CLIError>;

interface ProjectModule {
  readonly planProjectConfiguration: (input: ProjectConfigurationInput) => unknown;
  readonly applyProjectConfiguration: (input: ProjectConfigurationInput) => Promise<unknown>;
  readonly initializeReactProject: (input: ProjectConfigurationInput) => Promise<unknown>;
}

const PROJECT_HELP = `selftune project — Set up project Skill Sets

Usage:
  selftune project plan --project <folder> --set <skill-set> [--set <skill-set>] [--json]
  selftune project configure --project <folder> --set <skill-set> [--set <skill-set>] [--json]
  selftune project init --project <new-folder> --set <skill-set> [--set <skill-set>] --yes [--json]

Plan is read-only. Configure applies every selected Skill Set only after the combined plan is conflict-free. Init scaffolds a Vite React TypeScript project, then configures it.`;

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Project ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        "OPERATION_FAILED",
        `selftune project ${operation} --help`,
      );
}

function format(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (typeof value === "object" && value !== null && "plan" in value) {
    const result = value as { plan: { creates: number; unchanged: number; conflicts: number } };
    return `Configured project: ${result.plan.creates} create, ${result.plan.unchanged} unchanged, ${result.plan.conflicts} conflicts.`;
  }
  const plan = value as {
    creates: number;
    unchanged: number;
    conflicts: number;
    missingDependencies: number;
  };
  return `${plan.creates} create, ${plan.unchanged} unchanged, ${plan.conflicts} conflicts, ${plan.missingDependencies} download${plan.missingDependencies === 1 ? "" : "s"}.`;
}

export function makeLiveProjectAction(): ProjectAction {
  return (operation, input, jsonRequested) =>
    Effect.gen(function* () {
      const runtime = (yield* Effect.tryPromise({
        try: () => import("@selftune/runtime/project-provisioning"),
        catch: (cause) => toCliError(operation, cause),
      })) as ProjectModule;
      const value = yield* operation === "plan"
        ? Effect.try({
            try: () => runtime.planProjectConfiguration(input),
            catch: (cause) => toCliError(operation, cause),
          })
        : Effect.tryPromise({
            try: () =>
              operation === "init"
                ? runtime.initializeReactProject(input)
                : runtime.applyProjectConfiguration(input),
            catch: (cause) => toCliError(operation, cause),
          });
      yield* Console.log(format(value, jsonRequested || process.stdout.isTTY !== true));
    });
}

function decode(value: Option.Option<string>): string | undefined {
  return Option.getOrUndefined(value);
}

export function makeProjectCommand(action: ProjectAction = makeLiveProjectAction()) {
  const project = Flag.string("project").pipe(Flag.optional);
  const sets = Flag.string("set").pipe(Flag.atLeast(0));
  const json = Flag.boolean("json");
  const makeInput = (input: { project: Option.Option<string>; sets: ReadonlyArray<string> }) => {
    const projectRoot = decode(input.project);
    if (!projectRoot?.trim()) {
      throw new CLIError("--project is required.", "MISSING_FLAG", "selftune project plan --help");
    }
    return { projectRoot, skillSetIds: input.sets };
  };
  const plan = Command.make("plan", { project, sets, json }, (input) =>
    action("plan", makeInput(input), input.json),
  );
  const configure = Command.make("configure", { project, sets, json }, (input) =>
    action("configure", makeInput(input), input.json),
  );
  const init = Command.make("init", { project, sets, json, yes: Flag.boolean("yes") }, (input) => {
    if (!input.yes) {
      return Effect.fail(
        new CLIError(
          "Project initialization requires --yes because it creates a new React project and installs Skill Sets.",
          "MISSING_FLAG",
          "Review the selected Skill Sets, then rerun with --yes.",
        ),
      );
    }
    return action("init", makeInput(input), input.json);
  });
  return Command.make("project", {}, () => Console.log(PROJECT_HELP)).pipe(
    Command.withSubcommands([plan, configure, init]),
    Command.withDescription("Plan and configure project Skill Sets"),
  );
}
