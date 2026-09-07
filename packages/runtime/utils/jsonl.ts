/**
 * JSONL read utilities and marker file helpers.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import * as Schema from "effect/Schema";

export function jsonlDecoder<A>(schema: Schema.Codec<A>) {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));
  return (line: string) => decode(line, { onExcessProperty: "preserve" });
}

export const decodeJsonLine = jsonlDecoder(Schema.Json);

export type JsonlDecoder<A> = (line: string) => A;

/**
 * Read a JSONL file and return parsed records.
 * Skips blank lines and lines that fail to parse.
 */
export function readJsonl<T>(path: string, decode: JsonlDecoder<T>): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const records: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(decode(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/**
 * Read new records from a JSONL file starting at the given byte offset.
 * Returns the parsed records and the new byte offset (end of file).
 * This is used for incremental materialization to avoid re-reading
 * hundreds of megabytes of append-only log data on every refresh.
 *
 * Uses Node fs with a file descriptor + read to only load the tail
 * of the file into memory, keeping the hot path lightweight.
 */
export function readJsonlFrom<T>(path: string, byteOffset: number, decode: JsonlDecoder<T>) {
  if (!existsSync(path)) return { records: [], newOffset: 0 };
  const fd = openSync(path, "r");
  try {
    const fileSize = fstatSync(fd).size;
    // Handle file shrinkage (e.g. truncation) — reset offset to current EOF
    if (fileSize < byteOffset) return { records: [], newOffset: fileSize };
    if (fileSize === byteOffset) return { records: [], newOffset: byteOffset };

    const tailSize = fileSize - byteOffset;
    const buf = Buffer.alloc(tailSize);
    const bytesRead = readSync(fd, buf, 0, tailSize, byteOffset);
    const content = buf.subarray(0, bytesRead).toString("utf-8");

    // Only process up to the last complete newline to avoid splitting partial records
    const lastNewline = content.lastIndexOf("\n");
    if (lastNewline === -1) return { records: [], newOffset: byteOffset };
    const completeContent = content.slice(0, lastNewline + 1);

    const records: T[] = [];
    for (const line of completeContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(decode(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return { records, newOffset: byteOffset + Buffer.byteLength(completeContent, "utf-8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Load a marker file (JSON array of strings) for idempotent ingestion.
 */
export function loadMarker(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const data = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)))(
      readFileSync(path, "utf-8"),
    );
    return new Set(data.filter(Schema.is(Schema.String)));
  } catch {
    return new Set();
  }
}

/**
 * Save a marker file (sorted JSON array of strings).
 */
export function saveMarker(path: string, ingested: Set<string>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify([...ingested].toSorted(), null, 2), "utf-8");
}

export interface FileIngestionFingerprint {
  readonly size: number;
  readonly mtime_ms: number;
  readonly normalizer_version: string;
}

export type FileIngestionMarker = Map<string, FileIngestionFingerprint>;

const FileFingerprint = Schema.Struct({
  size: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  mtime_ms: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  normalizer_version: Schema.String.check(Schema.isMinLength(1)),
});
const SerializedFileIngestionMarker = Schema.Struct({
  marker_version: Schema.Literal(2),
  files: Schema.Record(Schema.String, FileFingerprint),
});

/**
 * Load append-aware ingestion state.
 *
 * Legacy string-array markers deliberately return no matches. This forces one
 * safe reprocess before the marker is rewritten with file fingerprints.
 */
export function loadFileIngestionMarker(path: string): FileIngestionMarker {
  if (!existsSync(path)) return new Map();
  try {
    const data = Schema.decodeUnknownSync(Schema.fromJsonString(SerializedFileIngestionMarker))(
      readFileSync(path, "utf-8"),
    );
    return new Map(Object.entries(data.files));
  } catch {
    return new Map();
  }
}

/** Capture file state before ingestion so concurrent appends cause a later rescan. */
export function fingerprintIngestionFile(
  path: string,
  normalizerVersion: string,
): FileIngestionFingerprint {
  const stats = statSync(path);
  return {
    size: stats.size,
    mtime_ms: stats.mtimeMs,
    normalizer_version: normalizerVersion,
  };
}

export function isFileIngestionCurrent(
  marker: FileIngestionMarker,
  path: string,
  fingerprint: FileIngestionFingerprint,
): boolean {
  const previous = marker.get(path);
  return (
    previous?.size === fingerprint.size &&
    previous.mtime_ms === fingerprint.mtime_ms &&
    previous.normalizer_version === fingerprint.normalizer_version
  );
}

/** Save deterministic, versioned file fingerprints for append-aware ingestion. */
export function saveFileIngestionMarker(path: string, marker: FileIngestionMarker): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const files = Object.fromEntries(
    [...marker.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const serialized: typeof SerializedFileIngestionMarker.Type = { marker_version: 2, files };
  writeFileSync(path, JSON.stringify(serialized, null, 2), "utf-8");
}
