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

export function makeCreatePublishCommand(actions: CreateCommandActions) {
  return Command.make(
    "publish",
    {
      internalHelp: Flag.boolean(CREATE_INTERNAL_HELP_FLAG),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
      watch: Flag.boolean("watch").pipe(
        Flag.withDescription("Start watch immediately after publish succeeds"),
      ),
      ignoreWatchAlerts: Flag.boolean("ignore-watch-alerts").pipe(
        Flag.withDescription("Bypass the publish-time watch gate"),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit the publish result as JSON")),
    },
    (input) => {
      if (input.internalHelp)
        return Console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createPublish));
      return actions.publish({
        skillPath: decodeCreateInternalValue(Option.getOrUndefined(input.skillPath)),
        watch: input.watch,
        ignoreWatchAlerts: input.ignoreWatchAlerts,
        json: input.json,
      });
    },
  ).pipe(Command.withDescription("Publish a validated package and optionally start watch"));
}
