import * as Console from "effect/Console";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { CREATE_INTERNAL_PARENT_HELP_FLAG } from "../compatibility/create.js";
import { liveCreateCommandActions } from "./create/actions.js";
import type { CreateCommandActions } from "./create/contracts.js";
import { makeCreateEvaluationCommands } from "./create/evaluation.js";
import { makeCreatePublishCommand } from "./create/publish.js";
import { makeCreateScaffoldingCommands } from "./create/scaffolding.js";

export type { CreateCommandActions } from "./create/contracts.js";

export const CREATE_HELP = `selftune create — Draft full skill packages

Usage:
  selftune create <subcommand> [options]

Subcommands:
  init          Initialize a new skill package scaffold
  status        Show current draft-package readiness
  scaffold      Scaffold a package from an observed workflow
  check         Validate package readiness and recommend the next step
  replay        Run replay validation for the current draft package
  baseline      Measure with-skill vs no-skill lift for the draft package
  report        Render a benchmark-style report for the current draft package
  publish       Publish a validated draft package and optionally start watch

Run 'selftune create <subcommand> --help' for subcommand-specific options.`;

export function makeCreateCommand(actions: CreateCommandActions = liveCreateCommandActions) {
  const scaffolding = makeCreateScaffoldingCommands(actions);
  const evaluation = makeCreateEvaluationCommands(actions);

  return Command.make(
    "create",
    { internalParentHelp: Flag.boolean(CREATE_INTERNAL_PARENT_HELP_FLAG) },
    () => Console.log(CREATE_HELP),
  ).pipe(
    Command.withSubcommands([
      scaffolding.init,
      scaffolding.status,
      scaffolding.scaffold,
      scaffolding.check,
      evaluation.replay,
      evaluation.baseline,
      evaluation.report,
      makeCreatePublishCommand(actions),
    ]),
    Command.withDescription(`Draft full skill packages

Subcommands:
  init          Initialize a new skill package scaffold
  status        Show current draft-package readiness
  scaffold      Scaffold a package from an observed workflow
  check         Validate package readiness and recommend the next step
  replay        Run replay validation for the current draft package
  baseline      Measure with-skill vs no-skill lift for the draft package
  report        Render a benchmark-style report for the current draft package
  publish       Publish a validated draft package and optionally start watch`),
  );
}
