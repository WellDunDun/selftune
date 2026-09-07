import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";
import { findSelftunePackageRoot } from "../package-root.js";

let cachedVersion: string | null = null;
const decodePackageVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

export function getSelftuneVersion(fallback = "0.0.0"): string {
  if (cachedVersion !== null) return cachedVersion;

  try {
    const pkg = decodePackageVersion(
      readFileSync(join(findSelftunePackageRoot(), "package.json"), "utf-8"),
    );
    cachedVersion = pkg.version.trim().length > 0 ? pkg.version : fallback;
  } catch {
    cachedVersion = fallback;
  }

  return cachedVersion;
}
