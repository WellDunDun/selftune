import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { computeSkillVersionHash } from "../utils/skill-discovery.js";
import { getSkillEditCaptureLogPath } from "../constants.js";

const MAX_CANDIDATES = 128;
const MAX_RAW_SOURCE_BYTES = 256 * 1024;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_REDACTED_PROMPT_LENGTH = 512;
const PROMPT_TO_INVOCATION_WINDOW_MS = 30 * 60 * 1_000;
const INVOCATION_TO_EDIT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_INVOCATIONS_PER_PROMPT = 32;

type CanonicalPromptRow = {
  readonly session_id: string;
  readonly platform: string | null;
  readonly session_source_ref: string | null;
  readonly prompt_id: string;
  readonly prompt_text: string;
  readonly prompt_at: string;
  readonly prompt_source_ref: string | null;
};

type CanonicalSignalRow = {
  readonly session_id: string;
  readonly platform: string | null;
  readonly session_source_ref: string | null;
  readonly prompt_id: string;
  readonly prompt_text: string;
  readonly prompt_at: string | null;
  readonly prompt_source_ref: string | null;
  readonly skill_invocation_id: string;
  readonly skill_name: string;
  readonly skill_path: string | null;
  readonly skill_version_hash: string | null;
  readonly invocation_at: string | null;
  readonly invocation_source_ref: string | null;
};

export type CorrectionRevisionEvidence =
  | "invocation_hash_delta"
  | "raw_exact_contents"
  | "raw_deterministic_patch"
  | "captured_package_revisions"
  | "missing_revision_evidence"
  | "ambiguous_multi_skill_correlation";

export interface ExplicitCorrectionSignal {
  readonly candidate_id: string;
  readonly kind: "explicit_correction_hypothesis";
  readonly review_status: "review_required" | "deferred";
  readonly dry_run: true;
  readonly evidence_level: "E0" | "E0.5";
  readonly reason: CorrectionRevisionEvidence;
  readonly skill: {
    readonly name: string;
    readonly path: "[local-path-redacted]";
    readonly pre_revision: string | null;
    readonly post_revision: string | null;
  };
  readonly source: {
    readonly harness: string;
    readonly session_id: string;
    readonly prompt_id: string;
    readonly skill_invocation_id: string;
    readonly raw_source_ref_digest: string | null;
  };
  /** Hash-only local proof that a source-native edit artifact was present. */
  readonly raw_edit_digest: string | null;
  /** SKILL.md content evidence, never whole-package revision hashes. */
  readonly raw_content_digests: { readonly before: string; readonly after: string } | null;
  /** Present only when one correction prompt cannot be attributed to one skill. */
  readonly deferred_skill_names: readonly string[] | null;
  readonly correlation_truncated: boolean;
  readonly correction_intent: string;
  /** Regex matching only prioritizes review; it never proves an edit's effect. */
  readonly intent_detection: "heuristic";
  /** Never present until a later review constructs and validates a study. */
  readonly proves_causality: false;
}

export interface CorrectionSignalDiscoveryOptions {
  /** Hard upper bound; a caller may lower it but never raise it above 128. */
  readonly limit?: number;
  readonly inspectSkill?: (skillPath: string) => {
    readonly revision: string | null;
    readonly modified_at: string | null;
  };
  /**
   * Reads a source-native artifact only after the canonical row selected it.
   * The default accepts only a regular file identified by raw_source_ref.path
   * and refuses sources over 256 KiB.
   */
  readonly readRawSource?: (rawSourceRef: string) => string | null;
  /** Optional test/host seam for bounded hash-only Write/Edit artifacts. */
  readonly readSkillEditCaptures?: () => string | null;
}

export interface CorrectionSignalPageInput {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface CorrectionSignalPage {
  readonly items: readonly ExplicitCorrectionSignal[];
  readonly next_cursor: string | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    .slice(0, MAX_REDACTED_PROMPT_LENGTH);
}

function isExplicitCorrectionPrompt(value: string): boolean {
  const directCorrectionPatterns = [
    /\bno[,!—\s]+(?:that's|that is|this is|it is)\s+(?:wrong|incorrect)\b/i,
    /\b(?:that's|that is|this is|it is)\s+(?:wrong|incorrect)\b/i,
    /\byou\s+(?:forgot|missed|didn't|did not)\s+to\s+(?:update|edit|change)\s+(?:the\s+)?skill\b/i,
  ];
  return directCorrectionPatterns.some((pattern) => pattern.test(value));
}

/**
 * Canonical importers assign the user's first task prompt `p0`, optionally
 * followed by a source variant such as `p0:codex-rollout`. It is task intent,
 * not an interactional correction, even when it contains policy words.
 */
function isInitialPrompt(promptId: string): boolean {
  return /(?:^|:)p0(?::|$)/.test(promptId);
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearby(left: number | null, right: number | null, windowMs: number): boolean {
  return left !== null && right !== null && right >= left && right - left <= windowMs;
}

type SignalCursor = {
  readonly prompt_at: string;
  readonly prompt_id: string;
};

export class CorrectionSignalCursorError extends Error {
  constructor() {
    super("The correction signal cursor is invalid.");
    this.name = "CorrectionSignalCursorError";
  }
}

function encodeCursor(row: CanonicalPromptRow): string {
  return Buffer.from(
    JSON.stringify({
      prompt_at: row.prompt_at,
      prompt_id: row.prompt_id,
    }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): SignalCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new CorrectionSignalCursorError();
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("prompt_at" in decoded) ||
      !("prompt_id" in decoded) ||
      typeof decoded.prompt_at !== "string" ||
      typeof decoded.prompt_id !== "string" ||
      !Number.isFinite(Date.parse(decoded.prompt_at)) ||
      decoded.prompt_id.length === 0 ||
      decoded.prompt_id.length > 256
    ) {
      throw new CorrectionSignalCursorError();
    }
    return {
      prompt_at: decoded.prompt_at,
      prompt_id: decoded.prompt_id,
    };
  } catch (error) {
    if (error instanceof CorrectionSignalCursorError) throw error;
    throw new CorrectionSignalCursorError();
  }
}

function defaultInspectSkill(skillPath: string) {
  if (basename(skillPath).toUpperCase() !== "SKILL.MD") {
    return { revision: null, modified_at: null };
  }
  try {
    return {
      revision: computeSkillVersionHash(skillPath) ?? null,
      modified_at: statSync(skillPath).mtime.toISOString(),
    };
  } catch {
    return { revision: null, modified_at: null };
  }
}

function rawPath(rawSourceRef: string): string | null {
  try {
    const value: unknown = JSON.parse(rawSourceRef);
    if (
      typeof value === "object" &&
      value !== null &&
      "path" in value &&
      typeof value.path === "string" &&
      value.path.length > 0
    ) {
      return value.path;
    }
  } catch {
    // Legacy source references may be opaque strings; they are not reopenable.
  }
  return null;
}

function defaultReadRawSource(rawSourceRef: string): string | null {
  const path = rawPath(rawSourceRef);
  if (!path) return null;
  try {
    const details = statSync(path);
    if (!details.isFile() || details.size > MAX_RAW_SOURCE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parsedValues(raw: string): readonly unknown[] {
  const parsed: unknown[] = [];
  try {
    parsed.push(JSON.parse(raw));
  } catch {
    for (const line of raw.split("\n")) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Source-native formats may have non-JSON framing. Those lines carry no deterministic edit.
      }
    }
  }
  return parsed;
}

function objects(value: unknown, depth = 0): readonly Record<string, unknown>[] {
  if (depth > 12 || typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => objects(item, depth + 1));
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap((item) => objects(item, depth + 1))];
}

function exactPath(value: unknown, skillPath: string): boolean {
  return typeof value === "string" && resolve(value) === resolve(skillPath);
}

type RawEditEvidence = {
  readonly kind: "raw_exact_contents" | "raw_deterministic_patch" | "captured_package_revisions";
  readonly digest: string;
  readonly pre_content_digest: string | null;
  readonly post_content_digest: string | null;
  readonly pre_revision: string | null;
  readonly post_revision: string | null;
};

function rawEditEvidence(raw: string | null, skillPath: string): RawEditEvidence | null {
  if (!raw) return null;
  for (const value of parsedValues(raw)) {
    for (const object of objects(value)) {
      const path = object.skill_path ?? object.file_path ?? object.path;
      if (!exactPath(path, skillPath)) continue;
      const before = object.before ?? object.old_string ?? object.previous_content;
      const after = object.after ?? object.new_string ?? object.updated_content;
      if (typeof before === "string" && typeof after === "string") {
        return {
          kind: "raw_exact_contents",
          digest: digest(JSON.stringify({ skill_path: resolve(skillPath), before, after })),
          pre_content_digest: digest(before),
          post_content_digest: digest(after),
          pre_revision: null,
          post_revision: null,
        };
      }
      if (typeof object.patch === "string" && object.patch.length > 0) {
        return {
          kind: "raw_deterministic_patch",
          digest: digest(JSON.stringify({ skill_path: resolve(skillPath), patch: object.patch })),
          pre_content_digest: null,
          post_content_digest: null,
          pre_revision: null,
          post_revision: null,
        };
      }
    }
  }
  const quoted = skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`--- ${quoted}[\\s\\S]{0,20000}\\+\\+\\+ ${quoted}[\\s\\S]{0,20000}@@`).test(
    raw,
  )
    ? {
        kind: "raw_deterministic_patch",
        digest: digest(raw),
        pre_content_digest: null,
        post_content_digest: null,
        pre_revision: null,
        post_revision: null,
      }
    : null;
}

/** Hash-only artifacts emitted by the Write/Edit hooks; no skill content or path is reopened. */
function capturedRevisionEvidence(
  sessionId: string,
  skillPath: string,
  promptAt: string | null,
  readCaptures: () => string | null,
): RawEditEvidence | null {
  const raw = readCaptures();
  if (!raw) return null;
  const promptTimestamp = parseTimestamp(promptAt);
  if (promptTimestamp === null) return null;
  const targetDigest = digest(resolve(skillPath));
  const candidates: Array<RawEditEvidence & { readonly post_timestamp: number }> = [];
  for (const value of parsedValues(raw)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("event_type" in value) ||
      value.event_type !== "skill_md_edit_capture" ||
      !("status" in value) ||
      value.status !== "captured" ||
      !("session_id" in value) ||
      value.session_id !== sessionId ||
      !("target_digest" in value) ||
      value.target_digest !== targetDigest ||
      !("pre_revision" in value) ||
      !("post_revision" in value) ||
      typeof value.pre_revision !== "string" ||
      typeof value.post_revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.pre_revision) ||
      !/^[a-f0-9]{64}$/.test(value.post_revision) ||
      value.pre_revision === value.post_revision ||
      !("pre_captured_at" in value) ||
      typeof value.pre_captured_at !== "string" ||
      !("post_captured_at" in value) ||
      typeof value.post_captured_at !== "string"
    ) {
      continue;
    }
    const preTimestamp = parseTimestamp(value.pre_captured_at);
    const postTimestamp = parseTimestamp(value.post_captured_at);
    if (
      preTimestamp === null ||
      postTimestamp === null ||
      preTimestamp < promptTimestamp ||
      postTimestamp < preTimestamp ||
      postTimestamp - promptTimestamp > INVOCATION_TO_EDIT_WINDOW_MS
    ) {
      continue;
    }
    candidates.push({
      kind: "captured_package_revisions",
      digest: digest(JSON.stringify(value)),
      pre_content_digest: null,
      post_content_digest: null,
      pre_revision: value.pre_revision,
      post_revision: value.post_revision,
      post_timestamp: postTimestamp,
    });
  }
  return (
    candidates
      .toSorted(
        (left, right) =>
          left.post_timestamp - right.post_timestamp || left.digest.localeCompare(right.digest),
      )
      .at(0) ?? null
  );
}

function defaultReadSkillEditCaptures(): string | null {
  try {
    const path = getSkillEditCaptureLogPath();
    const details = statSync(path);
    if (!details.isFile()) return null;
    if (details.size <= MAX_RAW_SOURCE_BYTES) return readFileSync(path, "utf8");
    const descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_RAW_SOURCE_BYTES);
    try {
      readSync(descriptor, buffer, 0, buffer.length, details.size - buffer.length);
    } finally {
      closeSync(descriptor);
    }
    // The first record may be truncated because this is an append-only JSONL tail.
    // Drop it rather than treating a partial object as source evidence.
    const tail = buffer.toString("utf8");
    const firstNewline = tail.indexOf("\n");
    return firstNewline === -1 ? null : tail.slice(firstNewline + 1);
  } catch {
    return null;
  }
}

function rowRawSourceRef(row: CanonicalSignalRow): string | null {
  return row.invocation_source_ref ?? row.prompt_source_ref ?? row.session_source_ref;
}

function signalFromRow(
  row: CanonicalSignalRow,
  inspectSkill: NonNullable<CorrectionSignalDiscoveryOptions["inspectSkill"]>,
  readRawSource: NonNullable<CorrectionSignalDiscoveryOptions["readRawSource"]>,
  readSkillEditCaptures: NonNullable<CorrectionSignalDiscoveryOptions["readSkillEditCaptures"]>,
  ambiguousSkillNames: readonly string[] | null,
  correlationTruncated: boolean,
): ExplicitCorrectionSignal | null {
  if (
    !row.skill_path ||
    isInitialPrompt(row.prompt_id) ||
    row.prompt_text.length > MAX_PROMPT_LENGTH ||
    !isExplicitCorrectionPrompt(row.prompt_text) ||
    !nearby(
      parseTimestamp(row.invocation_at),
      parseTimestamp(row.prompt_at),
      PROMPT_TO_INVOCATION_WINDOW_MS,
    )
  ) {
    return null;
  }
  const ambiguous = ambiguousSkillNames !== null || correlationTruncated;
  const inspected = ambiguous
    ? { revision: null, modified_at: null }
    : inspectSkill(row.skill_path);
  const invocationRevision = row.skill_version_hash?.match(/^[a-f0-9]{64}$/)
    ? row.skill_version_hash
    : null;
  const currentRevision = inspected.revision?.match(/^[a-f0-9]{64}$/) ? inspected.revision : null;
  const rawSourceRef = rowRawSourceRef(row);
  const rawEvidence = ambiguous
    ? null
    : (capturedRevisionEvidence(
        row.session_id,
        row.skill_path,
        row.prompt_at,
        readSkillEditCaptures,
      ) ?? rawEditEvidence(rawSourceRef ? readRawSource(rawSourceRef) : null, row.skill_path));
  const hasHashDelta =
    invocationRevision !== null &&
    currentRevision !== null &&
    invocationRevision !== currentRevision &&
    nearby(
      parseTimestamp(row.prompt_at),
      parseTimestamp(inspected.modified_at),
      INVOCATION_TO_EDIT_WINDOW_MS,
    );
  const reason: CorrectionRevisionEvidence = ambiguous
    ? "ambiguous_multi_skill_correlation"
    : hasHashDelta
      ? "invocation_hash_delta"
      : (rawEvidence?.kind ?? "missing_revision_evidence");
  const preRevision = rawEvidence?.pre_revision ?? invocationRevision;
  const postRevision = rawEvidence?.post_revision ?? currentRevision;
  const candidateId = `correction-signal-${digest(
    JSON.stringify({
      session_id: row.session_id,
      prompt_id: row.prompt_id,
      skill_invocation_id: row.skill_invocation_id,
      reason,
      pre_revision: preRevision,
      post_revision: postRevision,
      deferred_skill_names: ambiguousSkillNames,
      correlation_truncated: correlationTruncated,
      raw_source_ref_digest: rawSourceRef ? digest(rawSourceRef) : null,
    }),
  ).slice(0, 32)}`;
  return {
    candidate_id: candidateId,
    kind: "explicit_correction_hypothesis",
    review_status: ambiguous ? "deferred" : "review_required",
    dry_run: true,
    evidence_level:
      reason === "missing_revision_evidence" || reason === "ambiguous_multi_skill_correlation"
        ? "E0"
        : "E0.5",
    reason,
    skill: {
      name: row.skill_name,
      path: "[local-path-redacted]",
      pre_revision: preRevision,
      post_revision: postRevision,
    },
    source: {
      harness: row.platform ?? "unknown",
      session_id: row.session_id,
      prompt_id: row.prompt_id,
      skill_invocation_id: row.skill_invocation_id,
      raw_source_ref_digest: rawSourceRef ? digest(rawSourceRef) : null,
    },
    raw_edit_digest: rawEvidence?.digest ?? null,
    raw_content_digests:
      rawEvidence?.pre_content_digest && rawEvidence.post_content_digest
        ? { before: rawEvidence.pre_content_digest, after: rawEvidence.post_content_digest }
        : null,
    deferred_skill_names: ambiguousSkillNames,
    correlation_truncated: correlationTruncated,
    correction_intent: redactedText(row.prompt_text),
    intent_detection: "heuristic",
    proves_causality: false,
  };
}

/**
 * Read-only, dry-run discovery over canonical session history. It never writes
 * a correction episode, advances source markers, starts a replay, or edits a
 * skill. A later reviewer must decide whether a hypothesis can become a study.
 */
export function discoverExplicitCorrectionSignals(
  database: Database,
  options: CorrectionSignalDiscoveryOptions = {},
): readonly ExplicitCorrectionSignal[] {
  return discoverExplicitCorrectionSignalPage(database, { limit: options.limit }, options).items;
}

/**
 * Cursor-paged, read-only historical discovery. The cursor advances over
 * canonical rows (rather than only matches), so old evidence remains reachable
 * even when a page contains no review candidates.
 */
export function discoverExplicitCorrectionSignalPage(
  database: Database,
  input: CorrectionSignalPageInput = {},
  options: CorrectionSignalDiscoveryOptions = {},
): CorrectionSignalPage {
  const requestedLimit = Math.min(Math.max(1, input.limit ?? 25), MAX_CANDIDATES);
  const cursor = decodeCursor(input.cursor);
  const cursorPredicate = cursor
    ? `AND (
        p.occurred_at < ? OR
        (p.occurred_at = ? AND p.prompt_id > ?)
      )`
    : "";
  const promptQuery = `SELECT
        s.session_id,
        s.platform,
        s.raw_source_ref AS session_source_ref,
        p.prompt_id,
        p.prompt_text,
        p.occurred_at AS prompt_at,
        p.raw_source_ref AS prompt_source_ref
      FROM prompts AS p
      INNER JOIN sessions AS s ON s.session_id = p.session_id
      WHERE p.prompt_text IS NOT NULL
        AND p.occurred_at IS NOT NULL
        AND length(p.prompt_text) <= ${MAX_PROMPT_LENGTH}
        AND EXISTS (
          SELECT 1 FROM skill_invocations AS si
          WHERE si.session_id = p.session_id AND si.triggered = 1
        )
        ${cursorPredicate}
      ORDER BY p.occurred_at DESC, p.prompt_id ASC
      LIMIT ?`;
  const promptRows = cursor
    ? database
        .query<CanonicalPromptRow, [string, string, string, number]>(promptQuery)
        .all(cursor.prompt_at, cursor.prompt_at, cursor.prompt_id, requestedLimit + 1)
    : database.query<CanonicalPromptRow, [number]>(promptQuery).all(requestedLimit + 1);
  const pagePrompts = promptRows.slice(0, requestedLimit);
  const inspectSkill = options.inspectSkill ?? defaultInspectSkill;
  const readRawSource = options.readRawSource ?? defaultReadRawSource;
  const readSkillEditCaptures = options.readSkillEditCaptures ?? defaultReadSkillEditCaptures;
  const correlationGroups: Array<{
    readonly row: CanonicalSignalRow;
    readonly ambiguousSkillNames: readonly string[] | null;
    readonly correlationTruncated: boolean;
  }> = [];
  for (const prompt of pagePrompts) {
    const invocationRows = database
      .query<
        Omit<CanonicalSignalRow, keyof CanonicalPromptRow> & { readonly source_session_id: string },
        [string, string, string, number]
      >(
        `SELECT skill_invocation_id, skill_name, skill_path, skill_version_hash,
          occurred_at AS invocation_at, raw_source_ref AS invocation_source_ref,
          session_id AS source_session_id
         FROM skill_invocations
         WHERE session_id = ?
           AND triggered = 1
           AND occurred_at IS NOT NULL
           AND julianday(occurred_at) <= julianday(?)
           AND julianday(occurred_at) >= julianday(?) - (30.0 / 1440)
         ORDER BY skill_invocation_id ASC
         LIMIT ?`,
      )
      .all(prompt.session_id, prompt.prompt_at, prompt.prompt_at, MAX_INVOCATIONS_PER_PROMPT + 1);
    const truncated = invocationRows.length > MAX_INVOCATIONS_PER_PROMPT;
    const groupedRows: CanonicalSignalRow[] = invocationRows
      .slice(0, MAX_INVOCATIONS_PER_PROMPT)
      .map((invocation) => ({
        ...prompt,
        ...invocation,
        session_id: prompt.session_id,
      }));
    const skillNames = [...new Set(groupedRows.map((row) => row.skill_name))].toSorted();
    const representativeBySkill = [
      ...Map.groupBy(groupedRows, (row) => row.skill_name).values(),
    ].map(
      (sameSkillRows) =>
        [...sameSkillRows].toSorted((left, right) =>
          left.skill_invocation_id.localeCompare(right.skill_invocation_id),
        )[0]!,
    );
    if (skillNames.length > 1 || truncated) {
      correlationGroups.push({
        row: representativeBySkill[0]!,
        ambiguousSkillNames: skillNames,
        correlationTruncated: truncated,
      });
    } else {
      for (const row of representativeBySkill) {
        correlationGroups.push({ row, ambiguousSkillNames: null, correlationTruncated: false });
      }
    }
  }
  const candidates = correlationGroups
    .map(({ row, ambiguousSkillNames, correlationTruncated }) =>
      signalFromRow(
        row,
        inspectSkill,
        readRawSource,
        readSkillEditCaptures,
        ambiguousSkillNames,
        correlationTruncated,
      ),
    )
    .filter((candidate): candidate is ExplicitCorrectionSignal => candidate !== null);
  const items = [
    ...new Map(candidates.map((candidate) => [candidate.candidate_id, candidate])).values(),
  ]
    .toSorted((left, right) => left.candidate_id.localeCompare(right.candidate_id))
    .slice(0, requestedLimit);
  return {
    items,
    next_cursor: promptRows.length > requestedLimit ? encodeCursor(pagePrompts.at(-1)!) : null,
  };
}
