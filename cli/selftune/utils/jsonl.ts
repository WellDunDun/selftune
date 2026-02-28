/**
 * JSONL read/write/append utilities.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
