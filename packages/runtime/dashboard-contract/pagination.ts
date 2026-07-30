export interface PaginationCursor {
  timestamp: string;
  id: number | string;
}

export interface PaginatedResult<T> {
  items: T[];
  next_cursor: PaginationCursor | null;
  has_more: boolean;
}

/** Parse a JSON cursor param from a URL search string. Returns null on invalid input. */
export function parseCursorParam(value: string | null | undefined): PaginationCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "timestamp" in parsed && "id" in parsed) {
      const { timestamp, id } = parsed as { timestamp: unknown; id: unknown };
      if (
        typeof timestamp === "string" &&
        (typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))
      ) {
        return { timestamp, id };
      }
    }
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
