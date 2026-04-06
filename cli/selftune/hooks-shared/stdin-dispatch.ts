/**
 * Generalized stdin preview and keyword filtering for hooks.
 *
 * Hooks receive payloads via stdin. Most hooks only care about specific
 * event types (e.g., skill-eval only handles PostToolUse). The existing
 * stdin-preview.ts provides a fast-path optimization: read stdin once,
 * check a preview slice for keywords, and skip JSON.parse entirely when
 * the keyword is absent.
 *
 * This module wraps that pattern into a single readAndFilter call that
 * combines the preview check with JSON parsing, returning null when
 * the payload is irrelevant (caller should exit 0 immediately).
 *
 * Re-exports readStdinWithPreview for backward compatibility.
 */

export { readStdinWithPreview } from "../hooks/stdin-preview.js";

/** Default preview size in characters (covers envelope fields). */
const DEFAULT_PREVIEW_BYTES = 4096;

/**
 * Read stdin with fast-path keyword filtering.
 *
 * Reads all of stdin, checks the leading preview slice for the presence of
 * ALL required keywords. If any keyword is missing, returns null (the caller
 * should exit early). Otherwise, parses the full payload as JSON and returns it.
 *
 * This is the recommended way to read hook payloads when you know which
 * keywords must appear in the envelope (e.g., event name, tool name).
 *
 * @param requiredKeywords  Strings that must ALL appear in the preview slice.
 *                          Typically quoted JSON values like '"PostToolUse"'.
 * @param previewBytes      Number of leading characters to check (default 4096).
 * @returns                 Parsed payload and raw string, or null if keywords don't match.
 *
 * @example
 * ```ts
 * const result = await readAndFilter<PostToolUsePayload>(['"PostToolUse"', '"Read"']);
 * if (!result) process.exit(0);
 * const { payload } = result;
 * ```
 */
export async function readAndFilter<T = unknown>(
  requiredKeywords: string[],
  previewBytes: number = DEFAULT_PREVIEW_BYTES,
): Promise<{ payload: T; raw: string } | null> {
  const raw = await Bun.stdin.text();
  const preview = raw.slice(0, previewBytes);

  for (const keyword of requiredKeywords) {
    if (!preview.includes(keyword)) {
      return null;
    }
  }

  const payload = JSON.parse(raw) as T;
  return { payload, raw };
}
