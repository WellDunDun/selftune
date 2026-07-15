import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { handleCLIError } from "../utils/cli-error.js";
import { computeCreateCheckResult, formatCreateCheckResult } from "./readiness.js";

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skill-path": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createCheck));
    process.exit(0);
  }

  const result = await computeCreateCheckResult(values["skill-path"] ?? "");

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCreateCheckResult(result));
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
