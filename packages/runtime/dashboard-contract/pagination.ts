import * as Schema from "effect/Schema";

export const PaginationCursor = Schema.Struct({
  timestamp: Schema.mutableKey(Schema.String),
  id: Schema.mutableKey(Schema.Union([Schema.Finite, Schema.String])),
});
export type PaginationCursor = typeof PaginationCursor.Type;

const decodeCursor = Schema.decodeUnknownSync(Schema.fromJsonString(PaginationCursor));

export interface PaginatedResult<T> {
  items: T[];
  next_cursor: PaginationCursor | null;
  has_more: boolean;
}

/** Parse a JSON cursor param from a URL search string. Returns null on invalid input. */
export function parseCursorParam(value: string | null | undefined): PaginationCursor | null {
  if (!value) return null;
  try {
    return decodeCursor(value);
  } catch {
    // Invalid cursor JSON is equivalent to no cursor.
  }
  return null;
}

/** Parse an integer query param with bounds clamping. */
export function parseIntParam(value: string | null | undefined, defaultValue: number): number {
  if (value == null) return defaultValue;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? defaultValue : Math.max(1, Math.min(n, 10000));
}
