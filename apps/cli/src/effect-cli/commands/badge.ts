import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type { BadgeInput } from "@selftune/runtime/badge/badge";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import { BADGE_INTERNAL_HELP_FLAG } from "../compatibility/badge.js";

export type BadgeAction = (input: BadgeInput) => Effect.Effect<void, CLIError>;

export const BADGE_HELP = `selftune badge — Generate skill health badges

Usage: selftune badge --skill <name> [options]

Options:
  --skill <name>    Skill name (required)
  --format <type>   Output format: svg, markdown, url (default: svg)
  --output <path>   Write to file instead of stdout
  --help            Show this help`;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function badgeImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load badge support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toBadgeCliError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Badge generation failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune badge --help",
      );
}

export const runBadgeAction = Effect.fn("selftune.cli.badge")(function* (input: BadgeInput) {
  const badge = yield* Effect.tryPromise({
    try: () => import("@selftune/runtime/badge/badge"),
    catch: badgeImportFailure,
  });
  yield* Effect.tryPromise({
    try: () => badge.runBadgeProgram(input),
    catch: toBadgeCliError,
  });
});

export function makeBadgeCommand(action: BadgeAction = runBadgeAction) {
  return Command.make(
    "badge",
    {
      _noOperands: Argument.none.pipe(Argument.optional, Argument.withMetavar("")),
      internalHelp: Flag.boolean(BADGE_INTERNAL_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.withDescription("Skill name (required)")),
      format: Flag.choice("format", ["svg", "markdown", "url"]).pipe(
        Flag.withDescription("Output format: svg, markdown, or url"),
        Flag.withDefault("svg"),
      ),
      output: Flag.string("output").pipe(
        Flag.withDescription("Write to a file instead of stdout"),
        Flag.optional,
      ),
    },
    (input) => {
      if (input.internalHelp) return Console.log(BADGE_HELP);
      return action({
        skill: input.skill,
        format: input.format,
        output: Option.getOrUndefined(input.output),
      });
    },
  ).pipe(
    Command.withDescription("Generate a skill health badge for a README"),
    Command.withExamples([
      { command: "selftune badge --skill my-skill", description: "Print an SVG badge" },
      {
        command: "selftune badge --skill my-skill --format markdown",
        description: "Print Markdown embedding a hosted badge",
      },
      {
        command: "selftune badge --skill my-skill --output badge.svg",
        description: "Write the badge to a file",
      },
    ]),
  );
}
