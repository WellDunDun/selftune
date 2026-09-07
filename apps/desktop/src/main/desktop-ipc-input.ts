import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import * as Schema from "effect/Schema";

export function decodeDesktopBootstrapNoInput(input: ReadonlyArray<unknown>): void {
  if (input.length !== 0) {
    throw new Error("Desktop bootstrap requests do not accept renderer input.");
  }
}

const directoryMessage = "Only existing absolute folder paths can be opened.";
export const decodeExistingAbsoluteDirectory = Schema.decodeUnknownSync(
  Schema.String.annotate({ message: directoryMessage }).check(
    Schema.makeFilter(
      (path) => isAbsolute(path) && existsSync(path) && statSync(path).isDirectory(),
      { message: directoryMessage },
    ),
  ),
);

export const decodeBackgroundServiceEnabled = Schema.decodeUnknownSync(
  Schema.Boolean.annotate({ message: "Background service state must be boolean." }),
);
