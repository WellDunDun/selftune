import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  createSignedHelperReleaseManifest,
  USE_ONCE_HELPER_PACKAGE_ID,
  verifySignedHelperReleaseManifest,
} from "../src";

describe("pinnable helper release manifest", () => {
  test("binds package identity, target, checksum, and an Ed25519 signature", () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const artifact = new TextEncoder().encode("compiled helper");
    const manifest = createSignedHelperReleaseManifest({
      version: "0.1.0",
      target: "bun-darwin-arm64",
      artifactName: "selftune-use-once",
      artifact,
      keyId: "release-2026-01",
      privateKeyPem,
    });
    expect(manifest.packageId).toBe(USE_ONCE_HELPER_PACKAGE_ID);
    expect(verifySignedHelperReleaseManifest({ manifest, artifact, publicKeyPem })).toBe(true);
    expect(
      verifySignedHelperReleaseManifest({
        manifest,
        artifact: new TextEncoder().encode("tampered"),
        publicKeyPem,
      }),
    ).toBe(false);
    expect(
      verifySignedHelperReleaseManifest({
        manifest: { ...manifest, url: "https://attacker.test/helper" } as typeof manifest,
        artifact,
        publicKeyPem,
      }),
    ).toBe(false);
  });
});
