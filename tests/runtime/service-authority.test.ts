import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
import { defineDurableReceiptContract } from "@selftune/local/service/authority/receipt";
import { reproveAuthority } from "@selftune/local/service/authority/reproof";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex as windowsSha256Hex,
  WindowsServiceInstallationReceiptSchema,
  type WindowsServiceInstallationCreationInput,
  type WindowsServiceInstallationReceipt,
} from "@selftune/local/service/windows/installation/model";
import type { WindowsServiceInstallationReceiptExpectation } from "@selftune/local/service/windows/installation/store";

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

const receiptInput: WindowsServiceInstallationCreationInput = {
  artifacts: {
    launcher: {
      path: "C:\\Users\\Test\\.selftune\\server-control\\run.vbs",
      sha256: windowsSha256Hex("launcher"),
    },
    taskDefinition: {
      path: "C:\\Users\\Test\\.selftune\\server-control\\run.xml",
      sha256: windowsSha256Hex("task-definition"),
    },
    wrapper: {
      path: "C:\\Users\\Test\\.selftune\\server-control\\run.cmd",
      sha256: windowsSha256Hex("wrapper"),
    },
  },
  boot: false,
  configDir: "C:\\Users\\Test\\.selftune",
  executableArgsPrefix: [],
  executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
  expectedArgv: [
    "daemon",
    "run",
    "--foreground",
    "--supervised",
    "--owner",
    "desktop",
    "--port",
    "7888",
    "--hostname",
    "127.0.0.1",
    "--runtime-mode",
    "standalone",
    "--service-installation-nonce",
    "A".repeat(43),
  ],
  installId: "11111111-1111-4111-8111-111111111111",
  installedAt: "2026-07-16T12:30:00.000Z",
  nonce: "A".repeat(43),
  owner: "desktop",
  port: 7888,
  taskName: "SelfTuneDaemon-11111111-1111-4111-8111-111111111111",
  userSid: "S-1-5-21-1000-2000-3000-4000",
};

function windowsReceiptGeneration(
  receipt: WindowsServiceInstallationReceipt,
): WindowsServiceInstallationReceiptExpectation {
  return { _tag: "Present", receipt };
}

function windowsReceiptGenerationMatches(
  receipt: WindowsServiceInstallationReceipt | null,
  expected: WindowsServiceInstallationReceiptExpectation,
): boolean {
  if (expected._tag === "Absent") return receipt === null;
  return receipt !== null && JSON.stringify(receipt) === JSON.stringify(expected.receipt);
}

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

  it("encodes Windows receipts byte-for-byte and validates the same generation", async () => {
    const jsonSchema = Schema.fromJsonString(WindowsServiceInstallationReceiptSchema);
    const contract = defineDurableReceiptContract({
      create: createWindowsServiceInstallationReceipt,
      decode: (input: unknown) => Schema.decodeUnknownEffect(jsonSchema)(input),
      encodeForStorage: (receipt: WindowsServiceInstallationReceipt) =>
        Schema.encodeEffect(jsonSchema)(receipt).pipe(Effect.map((encoded) => `${encoded}\n`)),
      generation: {
        absent: () => ({ _tag: "Absent" }),
        fromReceipt: windowsReceiptGeneration,
        matches: windowsReceiptGenerationMatches,
      },
    });
    const receipt = contract.create(receiptInput);
    const encoded = await Effect.runPromise(contract.encodeForStorage(receipt));

    expect(encoded).toBe(`${JSON.stringify(receipt)}\n`);
    expect(await Effect.runPromise(contract.decode(encoded))).toEqual(receipt);
    expect(contract.generation.fromReceipt(receipt)).toEqual({
      _tag: "Present",
      receipt,
    });
    expect(contract.generation.matches(receipt, contract.generation.fromReceipt(receipt))).toBe(
      true,
    );
    expect(contract.generation.matches(receipt, contract.generation.absent())).toBe(false);
    expect(contract.generation.matches(null, contract.generation.absent())).toBe(true);
  });
});
