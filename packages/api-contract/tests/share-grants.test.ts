import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ShareGrantIssueRequest } from "../src/share-grants";

const base = {
  skillId: "research",
  sourceRevisionHash: "a".repeat(64),
  expiresAt: "2026-08-01T00:00:00.000Z",
};

describe("share grant contract", () => {
  it("supports reusable and private copy links", () => {
    for (const mode of ["reusable_unlisted", "private_single_claim"] as const) {
      expect(
        Schema.decodeUnknownSync(ShareGrantIssueRequest)({
          ...base,
          mode,
          delivery: { _tag: "copy_link" },
        }).mode,
      ).toBe(mode);
    }
  });

  it("allows email only for private single-claim sharing", () => {
    const privateEmail = {
      ...base,
      mode: "private_single_claim",
      delivery: { _tag: "email", recipientEmail: "person@example.com" },
    };
    expect(Schema.decodeUnknownSync(ShareGrantIssueRequest)(privateEmail).mode).toBe(
      "private_single_claim",
    );
    expect(() =>
      Schema.decodeUnknownSync(ShareGrantIssueRequest)({
        ...privateEmail,
        mode: "reusable_unlisted",
      }),
    ).toThrow();
  });
});
