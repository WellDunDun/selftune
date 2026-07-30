import { describe, expect, it } from "vitest";

import * as root from "../index";
import * as subpath from "@selftune/api-contract/recipient-actions";

describe("recipient action package exports", () => {
  it("exposes the contract from the root and official package subpath", () => {
    expect(root.RecipientPortableDownloadRequestSchema).toBe(
      subpath.RecipientPortableDownloadRequestSchema,
    );
    expect(root.RecipientUseOnceIssueRequestSchema).toBe(
      subpath.RecipientUseOnceIssueRequestSchema,
    );
    expect(root.RecipientUseOncePreviewResponseSchema).toBe(
      subpath.RecipientUseOncePreviewResponseSchema,
    );
    expect(root.RecipientDesktopInstallPreviewResponseSchema).toBe(
      subpath.RecipientDesktopInstallPreviewResponseSchema,
    );
  });
});
