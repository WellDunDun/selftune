import { isDeepStrictEqual } from "node:util";

import { acceptsAuthorityControl, acceptsAuthorityInstall } from "../../authority/evidence.js";
import type { WindowsServiceInstallationEvidence } from "./contract.js";
import { sameWindowsServiceInstallationReceipt } from "./model.js";

export function acceptsWindowsInstallationControl(
  evidence: WindowsServiceInstallationEvidence,
): boolean {
  return evidence._tag !== "LegacyCleanupPending" && acceptsAuthorityControl(evidence);
}

export function acceptsWindowsInstallationInstall(
  evidence: WindowsServiceInstallationEvidence,
): boolean {
  return evidence._tag !== "LegacyCleanupPending" && acceptsAuthorityInstall(evidence);
}

export function sameWindowsInstallationAuthority(
  expected: WindowsServiceInstallationEvidence,
  actual: WindowsServiceInstallationEvidence,
): boolean {
  if (expected._tag !== actual._tag || expected.currentUserSid !== actual.currentUserSid) {
    return false;
  }
  switch (expected._tag) {
    case "Owned":
      return (
        actual._tag === "Owned" &&
        sameWindowsServiceInstallationReceipt(expected.receipt, actual.receipt)
      );
    case "LegacyCompatible":
      return (
        actual._tag === "LegacyCompatible" &&
        isDeepStrictEqual(expected.artifacts, actual.artifacts) &&
        isDeepStrictEqual(expected.runtimeIdentity, actual.runtimeIdentity)
      );
    case "OwnedIncomplete":
    case "LegacyCleanupPending":
    case "Absent":
    case "Refused":
      return false;
  }
}
