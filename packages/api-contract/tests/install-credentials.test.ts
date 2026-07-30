import { describe, expect, it } from "vitest";

import { decodeUnknown } from "../index";
import { DesktopInstallFinalizeRequestSchema } from "../src/install-credentials";

const uuid = "11111111-1111-4111-8111-111111111111";
const hash = (value: string) => value.repeat(64);
const bootstrapToken = "B".repeat(43);

describe("desktop install finalization contracts", () => {
  const base = {
    bootstrapToken,
    distributionId: uuid,
    sealedPackageSha256: hash("a"),
    pseudonymousInstallKey: hash("c"),
    receiptEvidenceSha256: hash("d"),
  };

  it("keeps sender-visible installed status on a separate explicit consent", () => {
    expect(
      decodeUnknown(DesktopInstallFinalizeRequestSchema, {
        ...base,
        lifecycleReporting: {
          _tag: "installed_status",
          lifecycleDisclosureSha256: hash("f"),
          consent: "not_granted",
          senderVisibleInstalledStatus: "disabled",
        },
      }).success,
    ).toBe(true);
    expect(
      decodeUnknown(DesktopInstallFinalizeRequestSchema, {
        ...base,
        lifecycleReporting: {
          _tag: "installed_status",
          lifecycleDisclosureSha256: hash("f"),
          consent: "not_granted",
          senderVisibleInstalledStatus: "enabled",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects raw local details", () => {
    expect(
      decodeUnknown(DesktopInstallFinalizeRequestSchema, {
        ...base,
        targetPath: "/private/project/.agents/skills/review-helper",
        lifecycleReporting: {
          _tag: "installed_status",
          lifecycleDisclosureSha256: hash("f"),
          consent: "not_granted",
          senderVisibleInstalledStatus: "disabled",
        },
      }).success,
    ).toBe(false);
  });
});
