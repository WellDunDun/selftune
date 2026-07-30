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

function makeEvaluationFlags() {
  return {
    internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
    skillPath: optionalString("skill-path", "Path to a skill directory or SKILL.md"),
    mode: Flag.string("mode").pipe(
      Flag.withDescription("Evaluation scope: routing or package"),
      Flag.withDefault("routing"),
    ),
    agent: optionalString("agent", "Runtime agent to use"),
    evalSetPath: optionalString("eval-set", "Override the canonical eval-set path"),
    json: Flag.boolean("json").pipe(Flag.withDescription("Emit the evaluation result as JSON")),
  };
}

export function makeCreateEvaluationCommands(actions: CreateCommandActions) {
  const replay = Command.make("replay", makeEvaluationFlags(), (input) => {
    if (input.internalHelp)
      return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createReplay));
    return actions.replay({
      skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
      mode: decodeCreateInternalValue(input.mode) ?? "routing",
      agent: decodeCreateInternalValue(Option.getOrUndefined(input.agent)),
      evalSetPath: decodeCreateInternalValue(Option.getOrUndefined(input.evalSetPath)),
      json: input.json,
    });
  }).pipe(Command.withDescription("Run replay validation for the current draft package"));

  const baseline = Command.make("baseline", makeEvaluationFlags(), (input) => {
    if (input.internalHelp)
      return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createBaseline));
    return actions.baseline({
      skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
      mode: decodeCreateInternalValue(input.mode) ?? "routing",
      agent: decodeCreateInternalValue(Option.getOrUndefined(input.agent)),
      evalSetPath: decodeCreateInternalValue(Option.getOrUndefined(input.evalSetPath)),
      json: input.json,
    });
  }).pipe(Command.withDescription("Measure with-skill versus no-skill lift"));

  const report = Command.make(
    "report",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      skillPath: optionalString("skill-path", "Path to a skill directory or SKILL.md"),
      agent: optionalString("agent", "Runtime agent to use"),
      evalSetPath: optionalString("eval-set", "Override the canonical eval-set path"),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the evaluation result as JSON")),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createReport));
      return actions.report({
        skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
        agent: decodeCreateInternalValue(Option.getOrUndefined(input.agent)),
        evalSetPath: decodeCreateInternalValue(Option.getOrUndefined(input.evalSetPath)),
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Render a benchmark-style package report"));

  return { replay, baseline, report };
}
