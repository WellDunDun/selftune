import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "@selftune/runtime/command-surface";

import {
  CREATE_INTERNAL_HELP_FLAG,
  decodeCreateInternalValue,
} from "../../compatibility/create.js";
import type { CreateCommandActions } from "./contracts.js";

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

export function makeCreateScaffoldingCommands(actions: CreateCommandActions) {
  const init = Command.make(
    "init",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      name: optionalString("name", "Display name for the new skill package (required)"),
      description: optionalString(
        "description",
        "Short routing description for the draft skill (required)",
      ),
      outputDir: optionalString("output-dir", "Parent directory for the new package"),
      force: Flag.boolean("force").pipe(
        Flag.withDescription("Overwrite scaffold files when the package already exists"),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the package summary as JSON")),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createInit));
      return actions.init({
        name: decodeCreateInternalValue(Option.getOrUndefined(input.name)),
        description: decodeCreateInternalValue(Option.getOrUndefined(input.description)),
        outputDir: decodeCreateInternalValue(Option.getOrUndefined(input.outputDir)),
        force: input.force,
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Initialize a new skill package scaffold"));

  const status = Command.make(
    "status",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      skillPath: optionalString("skill-path", "Path to a skill directory or SKILL.md"),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the readiness state as JSON")),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createStatus));
      return actions.status({
        skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Show current draft-package readiness"));

  const scaffold = Command.make(
    "scaffold",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      fromWorkflow: optionalString(
        "from-workflow",
        "Workflow ID or 1-based index from selftune workflows (required)",
      ),
      outputDir: optionalString("output-dir", "Parent directory for the new package"),
      skillName: optionalString("skill-name", "Override the generated skill name"),
      description: optionalString("description", "Override the routing description"),
      write: Flag.boolean("write").pipe(
        Flag.withDescription("Persist the package instead of previewing it"),
      ),
      force: Flag.boolean("force").pipe(
        Flag.withDescription("Overwrite scaffold files when the package already exists"),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the package summary as JSON")),
      minOccurrences: optionalString(
        "min-occurrences",
        "Minimum workflow frequency used for selection",
      ),
      skill: optionalString("skill", "Restrict discovery to workflows containing this skill"),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createScaffold));
      return actions.scaffold({
        fromWorkflow: decodeCreateInternalValue(Option.getOrUndefined(input.fromWorkflow)),
        outputDir: decodeCreateInternalValue(Option.getOrUndefined(input.outputDir)),
        skillName: decodeCreateInternalValue(Option.getOrUndefined(input.skillName)),
        description: decodeCreateInternalValue(Option.getOrUndefined(input.description)),
        write: input.write,
        force: input.force,
        json: input.json,
        minOccurrences: decodeCreateInternalValue(Option.getOrUndefined(input.minOccurrences)),
        skill: decodeCreateInternalValue(Option.getOrUndefined(input.skill)),
      });
    },
  ).pipe(Command.withDescription("Scaffold a package from an observed workflow"));

  const check = Command.make(
    "check",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      skillPath: optionalString("skill-path", "Path to a skill directory or SKILL.md"),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the readiness report as JSON")),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createCheck));
      return actions.check({
        skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Validate package readiness and recommend the next step"));

  return { init, status, scaffold, check };
}
