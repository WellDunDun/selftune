import type { UseOnceAuthorityClient } from "./contracts";
import { UseOnceHelperError } from "./errors";

const unavailable = (): never => {
  throw new UseOnceHelperError(
    "AUTHORITY_SEAM_UNAVAILABLE",
    "This helper build is not wired to the required token-bound preview and one-use delivery API.",
  );
};

/** Fail-closed production composition until the Cloud authority seam ships. */
export const unavailableUseOnceAuthorityClient: UseOnceAuthorityClient = {
  preview: async () => unavailable(),
  consume: async () => unavailable(),
  retrievePreviewObject: async () => unavailable(),
};
