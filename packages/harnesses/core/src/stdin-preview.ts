/**
 * Shared stdin preview utility for hook fast-path optimization.
 *
 * Reads all of stdin once, then exposes a small preview slice so callers
 * can do cheap `.includes()` keyword checks before paying for JSON.parse().
 * When the keyword is absent the hook can exit in <1ms.
 */

const STDIN_PREVIEW_BYTES = 4096;

/**
 * Read stdin and return both a preview slice and the full text.
 *
 * Bun's `stdin.text()` consumes the entire stream in one call, so this is
 * not a true streaming preview. The win comes from avoiding `JSON.parse()`
 * entirely when the preview slice already proves the payload is irrelevant.
 *
 * @param previewBytes  Number of leading characters to expose in `preview`.
 *                      Defaults to 4096, which comfortably covers the
 *                      envelope fields (`hook_event_name`, `tool_name`, etc.)
 *                      of any Claude Code hook payload.
 */
export async function readStdinWithPreview(previewBytes: number = STDIN_PREVIEW_BYTES): Promise<{
  preview: string;
  full: string;
}> {
  const raw = await Bun.stdin.text();
  return {
    preview: raw.slice(0, previewBytes),
    full: raw,
  };
}
