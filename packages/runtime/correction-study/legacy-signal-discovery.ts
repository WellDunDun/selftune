import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import * as Schema from "effect/Schema";

const MAX_CANDIDATES = 128;
const MAX_REDACTED_QUERY_LENGTH = 512;

type LegacySignalRow = {
  readonly id: number;
  readonly timestamp: string;
  readonly session_id: string;
  readonly query: string;
  readonly mentioned_skill: string | null;
};

type InvocationRow = {
  readonly skill_invocation_id: string;
  readonly skill_name: string;
  readonly skill_path: string | null;
};

export interface LegacyCorrectionSignal {
  readonly candidate_id: string;
  readonly kind: "legacy_correction_signal";
  readonly review_status: "deferred";
  readonly dry_run: true;
  readonly evidence_level: "E0";
  readonly reason:
    | "legacy_correction_missing_revision_evidence"
    | "legacy_correction_missing_skill_attribution"
    | "legacy_correction_ambiguous_skill_attribution";
  readonly skill: {
    readonly name: string;
    readonly pre_revision: null;
    readonly post_revision: null;
  };
  readonly source: {
    readonly harness: "legacy-improvement-signals";
    readonly session_id: string;
    readonly prompt_id: string;
    readonly skill_invocation_id: string;
    readonly raw_source_ref_digest: null;
  };
  readonly raw_edit_digest: null;
  readonly deferred_skill_names: readonly string[] | null;
  readonly correction_intent: string;
}

export interface LegacyCorrectionSignalPageInput {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface LegacyCorrectionSignalPage {
  readonly items: readonly LegacyCorrectionSignal[];
  readonly next_cursor: string | null;
}

const SignalCursor = Schema.Struct({
  timestamp: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
type SignalCursor = typeof SignalCursor.Type;

export class LegacyCorrectionSignalCursorError extends Error {
  constructor() {
    super("The legacy correction signal cursor is invalid.");
    this.name = "LegacyCorrectionSignalCursorError";
  }
}

function redactedText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]")
    .slice(0, MAX_REDACTED_QUERY_LENGTH);
}

function cursorFor(row: LegacySignalRow): string {
  return Buffer.from(JSON.stringify({ timestamp: row.timestamp, id: row.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | null | undefined): SignalCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new LegacyCorrectionSignalCursorError();
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(SignalCursor))(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
  } catch (error) {
    if (error instanceof LegacyCorrectionSignalCursorError) throw error;
    throw new LegacyCorrectionSignalCursorError();
  }
}

function skillId(skillName: string): string {
  return `skill-${createHash("sha256").update(skillName).digest("hex").slice(0, 32)}`;
}

function attribution(database: Database, row: LegacySignalRow) {
  if (!row.mentioned_skill) return [];
  return database
    .query<InvocationRow, [string, string]>(
      `SELECT DISTINCT skill_invocation_id, skill_name, skill_path
       FROM skill_invocations
       WHERE session_id = ?
         AND triggered = 1
         AND lower(skill_name) = lower(?)
       ORDER BY skill_invocation_id ASC`,
    )
    .all(row.session_id, row.mentioned_skill);
}

function toCandidate(database: Database, row: LegacySignalRow): LegacyCorrectionSignal {
  const matches = attribution(database, row);
  const matchedNames = [...new Set(matches.map((match) => match.skill_name))];
  const uniqueMatch = matches.length === 1 ? matches[0] : null;
  const reason = uniqueMatch
    ? "legacy_correction_missing_revision_evidence"
    : matches.length > 1
      ? "legacy_correction_ambiguous_skill_attribution"
      : "legacy_correction_missing_skill_attribution";
  const name = uniqueMatch?.skill_name ?? row.mentioned_skill ?? "unattributed";
  return {
    candidate_id: `legacy-correction-${row.id}`,
    kind: "legacy_correction_signal",
    review_status: "deferred",
    dry_run: true,
    evidence_level: "E0",
    reason,
    skill: { name, pre_revision: null, post_revision: null },
    source: {
      harness: "legacy-improvement-signals",
      session_id: row.session_id,
      prompt_id: `legacy-signal-${row.id}`,
      skill_invocation_id: uniqueMatch?.skill_invocation_id ?? "unattributed",
      raw_source_ref_digest: null,
    },
    raw_edit_digest: null,
    deferred_skill_names: uniqueMatch || matchedNames.length === 0 ? null : matchedNames.toSorted(),
    correction_intent: redactedText(row.query),
  };
}

/** Read-only, cursor-paged discovery over legacy correction signals only. */
export function discoverLegacyCorrectionSignalPage(
  database: Database,
  input: LegacyCorrectionSignalPageInput = {},
): LegacyCorrectionSignalPage {
  const limit = Math.min(Math.max(1, input.limit ?? 25), MAX_CANDIDATES);
  const cursor = decodeCursor(input.cursor);
  const predicate = cursor ? "AND (timestamp < ? OR (timestamp = ? AND id > ?))" : "";
  const query = `SELECT id, timestamp, session_id, query, mentioned_skill
    FROM improvement_signals
    WHERE signal_type = 'correction'
      ${predicate}
    ORDER BY timestamp DESC, id ASC
    LIMIT ?`;
  const rows = cursor
    ? database
        .query<LegacySignalRow, [string, string, number, number]>(query)
        .all(cursor.timestamp, cursor.timestamp, cursor.id, limit + 1)
    : database.query<LegacySignalRow, [number]>(query).all(limit + 1);
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map((row) => toCandidate(database, row)),
    next_cursor: rows.length > limit ? cursorFor(pageRows.at(-1)!) : null,
  };
}

/** Deterministic namespace for durable orchestration checkpointing. */
export const LEGACY_CORRECTION_SIGNAL_CHECKPOINT_NAMESPACE = "legacy-improvement-signals-v1";

/** Stable local identifier retained for consumers that need an attributed skill id. */
export function legacyCorrectionSignalSkillId(skillName: string): string {
  return skillId(skillName);
}
