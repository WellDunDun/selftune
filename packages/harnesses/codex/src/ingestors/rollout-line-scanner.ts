import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface RolloutLineScan {
  readonly nonEmptyLineCount: number;
  readonly transcriptChars: number;
}

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const ASYNC_YIELD_BYTES = 4 * 1024 * 1024;

interface LineConsumer {
  readonly consume: (decoded: string) => void;
  readonly finish: () => RolloutLineScan;
}

function makeLineConsumer(onLine: (line: string) => void): LineConsumer {
  const fragments: string[] = [];
  let fragmentChars = 0;
  let rawLineChars = 0;
  let oversized = false;
  let nonEmptyLineCount = 0;
  let transcriptChars = 0;

  const append = (fragment: string): void => {
    rawLineChars += fragment.length;
    if (oversized) return;
    if (fragmentChars + fragment.length > MAX_LINE_CHARS) {
      fragments.length = 0;
      fragmentChars = 0;
      oversized = true;
      return;
    }
    fragments.push(fragment);
    fragmentChars += fragment.length;
  };
  const finishLine = (): void => {
    if (rawLineChars === 0) return;
    if (oversized) {
      nonEmptyLineCount += 1;
      transcriptChars += rawLineChars;
    } else {
      const line = fragments.join("").trim();
      if (line.length > 0) {
        nonEmptyLineCount += 1;
        transcriptChars += line.length;
        onLine(line);
      }
    }
    fragments.length = 0;
    fragmentChars = 0;
    rawLineChars = 0;
    oversized = false;
  };

  return {
    consume: (decoded) => {
      let offset = 0;
      for (;;) {
        const newline = decoded.indexOf("\n", offset);
        if (newline < 0) {
          append(decoded.slice(offset));
          return;
        }
        append(decoded.slice(offset, newline));
        finishLine();
        offset = newline + 1;
      }
    },
    finish: () => {
      finishLine();
      return { nonEmptyLineCount, transcriptChars };
    },
  };
}

function openRollout(filePath: string): number | null {
  try {
    return openSync(filePath, "r");
  } catch {
    return null;
  }
}

/** Synchronous compatibility scanner used by the standalone Codex ingestor. */
export function scanRolloutLines(
  filePath: string,
  onLine: (line: string) => void,
): RolloutLineScan | null {
  const descriptor = openRollout(filePath);
  if (descriptor === null) return null;
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const consumer = makeLineConsumer(onLine);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consumer.consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consumer.consume(decoder.end());
    return consumer.finish();
  } finally {
    closeSync(descriptor);
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Bounded source-sync scanner that yields and honours Effect cancellation. */
export async function scanRolloutLinesAsync(
  filePath: string,
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<RolloutLineScan | null> {
  const descriptor = openRollout(filePath);
  if (descriptor === null) return null;
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const consumer = makeLineConsumer(onLine);
  let bytesSinceYield = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Codex rollout scan was interrupted");
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consumer.consume(decoder.write(buffer.subarray(0, bytesRead)));
      bytesSinceYield += bytesRead;
      if (bytesSinceYield >= ASYNC_YIELD_BYTES) {
        bytesSinceYield = 0;
        // oxlint-disable-next-line no-await-in-loop -- deliberate cooperative I/O.
        await yieldToEventLoop();
      }
    }
    if (signal.aborted) throw new Error("Codex rollout scan was interrupted");
    consumer.consume(decoder.end());
    return consumer.finish();
  } finally {
    closeSync(descriptor);
  }
}
