/**
 * JSONL read/write/append utilities.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { createLogger } from "./logging.js";
import type { LogType } from "./schema-validator.js";
import { validateRecord } from "./schema-validator.js";

/**
 * Read a JSONL file and return parsed records.
 * Skips blank lines and lines that fail to parse.
 */
export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const records: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
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
export function readJsonlFrom<T = Record<string, unknown>>(
  path: string,
  byteOffset: number,
): { records: T[]; newOffset: number } {
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
        records.push(JSON.parse(trimmed) as T);
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
 * Append a single record to a JSONL file. Creates parent directories if needed.
 * When logType is provided, validates the record and logs warnings on failure
 * but still writes the record (fail-open: hooks must never block).
 */
export function appendJsonl(path: string, record: unknown, logType?: LogType): void {
  if (logType) {
    const result = validateRecord(record, logType);
    if (!result.valid) {
      const logger = createLogger("jsonl");
      for (const error of result.errors) {
        logger.warn(`Validation warning for ${logType}: ${error}`);
      }
    }
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

/**
 * Load a marker file (JSON array of strings) for idempotent ingestion.
 */
export function loadMarker(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return new Set(Array.isArray(data) ? data : []);
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
  writeFileSync(path, JSON.stringify([...ingested].sort(), null, 2), "utf-8");
}
