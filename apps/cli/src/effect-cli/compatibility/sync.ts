import { parseArgs } from "node:util";

import { CLIError } from "@selftune/runtime/utils/cli-error";

export const SYNC_INTERNAL_HELP_FLAG = "selftune-internal-sync-help";

export const SYNC_HELP = `selftune sync — Source-truth telemetry sync

Usage:
  selftune sync [options]

Options:
  --projects-dir <dir>             Claude transcript directory (default: ~/.claude/projects)
  --codex-home <dir>               Codex home directory (default: ~/.codex)
  --opencode-data-dir <dir>        OpenCode data directory
  --openclaw-agents-dir <dir>      OpenClaw agents directory
  --pi-sessions-dir <dir>          Pi sessions directory
  --skill-log <path>               Raw skill usage log path
  --repaired-skill-log <path>      Repaired overlay log path
  --repaired-sessions-marker <p>   Repaired session marker path
  --since <date>                   Only sync sessions modified on/after date
  --dry-run                        Show summary without writing files
  --force                          Ignore per-source markers and rescan everything
  --no-claude                      Skip Claude transcript replay
  --no-codex                       Skip Codex rollout ingest
  --no-opencode                    Skip OpenCode ingest
  --no-openclaw                    Skip OpenClaw ingest
  --no-pi                          Skip Pi ingest
  --no-repair                      Skip rebuilt skill-usage overlay
  --json                           Output raw JSON instead of human-readable summary
  -h, --help                       Show this help`;

interface SyncValues {
  readonly "projects-dir"?: string;
  readonly "codex-home"?: string;
  readonly "opencode-data-dir"?: string;
  readonly "openclaw-agents-dir"?: string;
  readonly "pi-sessions-dir"?: string;
  readonly "skill-log"?: string;
  readonly "repaired-skill-log"?: string;
  readonly "repaired-sessions-marker"?: string;
  readonly since?: string;
  readonly "dry-run"?: boolean;
  readonly force?: boolean;
  readonly "no-claude"?: boolean;
  readonly "no-codex"?: boolean;
  readonly "no-opencode"?: boolean;
  readonly "no-openclaw"?: boolean;
  readonly "no-pi"?: boolean;
  readonly "no-repair"?: boolean;
  readonly json?: boolean;
  readonly help?: boolean;
}

export class SyncLegacyParseFailure extends Error {
  readonly _tag = "SyncLegacyParseFailure";

  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SyncLegacyParseFailure";
  }
}

function appendValue(target: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) target.push(flag, `:${value}`);
}

function appendBoolean(target: string[], flag: string, enabled: boolean | undefined): void {
  if (enabled) target.push(flag);
}

export function decodeSyncInternalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(":") ? value.slice(1) : value;
}

function parseLegacySyncValues(args: ReadonlyArray<string>): SyncValues {
  try {
    const { values } = parseArgs({
      args,
      options: {
        "projects-dir": { type: "string" },
        "codex-home": { type: "string" },
        "opencode-data-dir": { type: "string" },
        "openclaw-agents-dir": { type: "string" },
        "pi-sessions-dir": { type: "string" },
        "skill-log": { type: "string" },
        "repaired-skill-log": { type: "string" },
        "repaired-sessions-marker": { type: "string" },
        since: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "no-claude": { type: "boolean", default: false },
        "no-codex": { type: "boolean", default: false },
        "no-opencode": { type: "boolean", default: false },
        "no-openclaw": { type: "boolean", default: false },
        "no-pi": { type: "boolean", default: false },
        "no-repair": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    return values;
  } catch (cause) {
    throw new SyncLegacyParseFailure(cause);
  }
}

function validateSince(value: string | undefined): void {
  if (!value) return;
  if (!Number.isNaN(new Date(value).getTime())) return;
  throw new CLIError(
    `Invalid --since date: ${value}`,
    "INVALID_FLAG",
    "selftune sync --since 2026-01-01",
  );
}

export function prepareLegacySyncArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const values = parseLegacySyncValues(args);
  if (values.help) return [`--${SYNC_INTERNAL_HELP_FLAG}`];
  validateSince(values.since);

  const normalized: string[] = [];
  appendValue(normalized, "--projects-dir", values["projects-dir"]);
  appendValue(normalized, "--codex-home", values["codex-home"]);
  appendValue(normalized, "--opencode-data-dir", values["opencode-data-dir"]);
  appendValue(normalized, "--openclaw-agents-dir", values["openclaw-agents-dir"]);
  appendValue(normalized, "--pi-sessions-dir", values["pi-sessions-dir"]);
  appendValue(normalized, "--skill-log", values["skill-log"]);
  appendValue(normalized, "--repaired-skill-log", values["repaired-skill-log"]);
  appendValue(normalized, "--repaired-sessions-marker", values["repaired-sessions-marker"]);
  if (values.since) appendValue(normalized, "--since", values.since);
  appendBoolean(normalized, "--dry-run", values["dry-run"]);
  appendBoolean(normalized, "--force", values.force);
  appendBoolean(normalized, "--no-claude", values["no-claude"]);
  appendBoolean(normalized, "--no-codex", values["no-codex"]);
  appendBoolean(normalized, "--no-opencode", values["no-opencode"]);
  appendBoolean(normalized, "--no-openclaw", values["no-openclaw"]);
  appendBoolean(normalized, "--no-pi", values["no-pi"]);
  appendBoolean(normalized, "--no-repair", values["no-repair"]);
  appendBoolean(normalized, "--json", values.json);
  return normalized;
}
