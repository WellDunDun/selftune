import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import * as Schema from "effect/Schema";

export function decodeExistingAbsoluteDirectory(input: unknown): string {
  let path: string;
  try {
    path = Schema.decodeUnknownSync(Schema.String)(input);
  } catch {
    throw new Error("Only existing absolute folder paths can be opened.");
  }
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error("Only existing absolute folder paths can be opened.");
  }
  return path;
}

export function decodeBackgroundServiceEnabled(input: unknown): boolean {
  try {
    return Schema.decodeUnknownSync(Schema.Boolean)(input);
  } catch {
    throw new Error("Background service state must be boolean.");
  }
}
