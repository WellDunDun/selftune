import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  inspectDurableArtifact,
  inspectDurableArtifactSet,
  sha256Hex,
} from "@selftune/local/service/authority/durable-artifact";
import {
  acceptsAuthorityControl,
  acceptsAuthorityInstall,
  type AuthorityEvidence,
} from "@selftune/local/service/authority/evidence";
import { reproveAuthority } from "@selftune/local/service/authority/reproof";
import { sha256Hex as windowsSha256Hex } from "@selftune/local/service/windows/installation/model";

const encoder = new TextEncoder();

type TestEvidence = AuthorityEvidence<
  { readonly currentUserSid: string },
  { readonly receipt: { readonly installId: string } },
  { readonly artifacts: ReadonlyArray<string> },
  { readonly reason: string }
>;

function evidenceIdentity(evidence: TestEvidence): string {
  switch (evidence._tag) {
    case "Owned":
    case "OwnedIncomplete":
      return `owned:${evidence.receipt.installId}`;
    case "LegacyCompatible":
      return "legacy";
    case "Absent":
      return "absent";
    case "Refused":
      return "refused";
  }
}

const owned: TestEvidence = {
  _tag: "Owned",
  currentUserSid: "S-1-5-21-1000",
  receipt: { installId: "install-a" },
};

describe("service authority foundations", () => {
  it("preserves Windows digest and evidence verdicts", () => {
    expect(sha256Hex("abc")).toBe(windowsSha256Hex("abc"));
    expect(sha256Hex(encoder.encode("abc"))).toBe(windowsSha256Hex(encoder.encode("abc")));

    const cases: ReadonlyArray<readonly [TestEvidence, boolean, boolean]> = [
      [{ _tag: "Absent", currentUserSid: "sid" }, false, true],
      [owned, true, true],
      [
        {
          _tag: "OwnedIncomplete",
          currentUserSid: "sid",
          receipt: { installId: "install-a" },
        },
        false,
        true,
      ],
      [{ _tag: "LegacyCompatible", artifacts: [], currentUserSid: "sid" }, true, true],
      [{ _tag: "Refused", currentUserSid: "sid", reason: "foreign" }, false, false],
    ];
    for (const [evidence, control, install] of cases) {
      expect(acceptsAuthorityControl(evidence)).toBe(control);
      expect(acceptsAuthorityInstall(evidence)).toBe(install);
    }
  });

  it("classifies durable artifact sets without weakening digest mismatches", async () => {
    const files = new Map<string, Uint8Array>([
      ["one", encoder.encode("one")],
      ["two", encoder.encode("two")],
    ]);
    const read = (path: string) => Effect.succeed(files.get(path) ?? null);
    const records = [
      { path: "one", sha256: sha256Hex("one") },
      { path: "two", sha256: sha256Hex("two") },
    ];

    expect(await Effect.runPromise(inspectDurableArtifact(read, records[0]))).toBe("matching");
    expect(await Effect.runPromise(inspectDurableArtifactSet(read, records))).toBe("matching");
    expect(await Effect.runPromise(inspectDurableArtifactSet(read, []))).toBe("partially-missing");
    files.delete("two");
    expect(await Effect.runPromise(inspectDurableArtifactSet(read, records))).toBe(
      "partially-missing",
    );
    files.set("one", encoder.encode("changed"));
    expect(await Effect.runPromise(inspectDurableArtifactSet(read, records))).toBe("mismatch");
  });

  it("reproves both an accepted verdict and the same authority identity", async () => {
    const reference = {
      acceptsControl: acceptsAuthorityControl,
      sameAuthority: (expected: TestEvidence, actual: TestEvidence) =>
        evidenceIdentity(expected) === evidenceIdentity(actual),
    };
    await expect(
      Effect.runPromise(reproveAuthority(Effect.succeed(owned), owned, reference, () => "changed")),
    ).resolves.toEqual(owned);
    await expect(
      Effect.runPromise(
        reproveAuthority(
          Effect.succeed<TestEvidence>({
            _tag: "OwnedIncomplete",
            currentUserSid: "sid",
            receipt: { installId: "install-a" },
          }),
          owned,
          reference,
          () => "changed",
        ),
      ),
    ).rejects.toBe("changed");
    await expect(
      Effect.runPromise(
        reproveAuthority(
          Effect.succeed(owned),
          {
            _tag: "OwnedIncomplete",
            currentUserSid: "sid",
            receipt: { installId: "install-a" },
          } satisfies TestEvidence,
          reference,
          () => "changed",
        ),
      ),
    ).rejects.toBe("changed");
    await expect(
      Effect.runPromise(
        reproveAuthority(
          Effect.succeed<TestEvidence>({
            _tag: "Owned",
            currentUserSid: "sid",
            receipt: { installId: "install-b" },
          }),
          owned,
          reference,
          () => "changed",
        ),
      ),
    ).rejects.toBe("changed");
  });
});
