import { describe, expect, it } from "vitest";

import {
  executeLocalShare,
  LOCAL_SHARE_CAPABILITIES,
  LOCAL_SHARE_LINK_ONLY,
} from "./local-library-transfer-actions";

describe("local Cloud share capabilities", () => {
  it("advertises reusable copy links as the only supported share mode", () => {
    expect(LOCAL_SHARE_CAPABILITIES).toEqual({
      supportedDeliveryMethods: ["copy_link"],
      supportedShareModes: ["reusable_unlisted"],
    });
  });

  it.each([
    { delivery: "email" as const, mode: "private_single_claim" as const },
    { delivery: "copy_link" as const, mode: "private_single_claim" as const },
  ])("rejects unsupported $delivery/$mode execution", async (input) => {
    let calls = 0;

    await expect(
      executeLocalShare(input, async () => {
        calls += 1;
        return { shareUrl: "https://cloud.selftune.dev/shared/unexpected" };
      }),
    ).rejects.toThrow(LOCAL_SHARE_LINK_ONLY);
    expect(calls).toBe(0);
  });
});
