import { isAbsolute } from "node:path";

import type { RemoteArtifact } from "@selftune/control-plane";

import { CLIError } from "../utils/cli-error.js";

export function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "")) {
    throw new CLIError(`Remote package contains an unsafe path: ${path}`, "OPERATION_FAILED");
  }
}

export function artifactPackageIdentity(artifact: RemoteArtifact): {
  skillName: string;
  revisionHash: string;
} {
  const parts = artifact.artifactId.split("/");
  const skillName = parts.at(-2) ?? "";
  const revisionHash = artifact.revisionHash ?? parts.at(-1) ?? "";
  assertSafeRelativePath(skillName);
  assertSafeRelativePath(revisionHash);
  return { skillName, revisionHash };
}
