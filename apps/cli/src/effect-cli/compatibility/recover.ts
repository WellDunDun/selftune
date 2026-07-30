import { parseArgs } from "node:util";

import {
  CANONICAL_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  TELEMETRY_LOG,
} from "@selftune/runtime/constants";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export const RECOVER_INTERNAL_HELP_FLAG = "selftune-internal-recover-help";

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendStringValue(target: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value !== "-" && value.startsWith("-")) {
    target.push(`${flag}=${value}`);
    return;
  }
  target.push(flag, value);
}

export function prepareLegacyRecoverArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        full: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        since: { type: "string" },
        json: { type: "boolean", default: false },
        "canonical-log": { type: "string", default: CANONICAL_LOG },
        "telemetry-log": { type: "string", default: TELEMETRY_LOG },
        "evolution-audit-log": { type: "string", default: EVOLUTION_AUDIT_LOG },
        "evolution-evidence-log": { type: "string", default: EVOLUTION_EVIDENCE_LOG },
        "orchestrate-run-log": { type: "string", default: ORCHESTRATE_RUN_LOG },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    const normalized: string[] = [];
    if (values.full) normalized.push("--full");
    if (values.force) normalized.push("--force");
    if (values.json) normalized.push("--json");
    appendStringValue(normalized, "--since", values.since);
    appendStringValue(normalized, "--canonical-log", values["canonical-log"]);
    appendStringValue(normalized, "--telemetry-log", values["telemetry-log"]);
    appendStringValue(normalized, "--evolution-audit-log", values["evolution-audit-log"]);
    appendStringValue(normalized, "--evolution-evidence-log", values["evolution-evidence-log"]);
    appendStringValue(normalized, "--orchestrate-run-log", values["orchestrate-run-log"]);
    if (values.help) normalized.push(`--${RECOVER_INTERNAL_HELP_FLAG}`);
    return normalized;
  } catch (cause) {
    throw new CLIError(
      `Invalid arguments: ${failureMessage(cause)}`,
      "INVALID_FLAG",
      "selftune recover --help",
    );
  }
}
