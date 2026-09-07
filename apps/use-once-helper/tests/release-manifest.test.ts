import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";

import { describe, expect, test } from "bun:test";

import {
  createSignedHelperReleaseManifest,
  USE_ONCE_HELPER_PACKAGE_ID,
  USE_ONCE_HELPER_RELEASE_TARGETS,
  verifySignedHelperReleaseManifest,
} from "../src";

describe("pinnable helper release manifest", () => {
  test("the release script writes a manifest beside the artifact with no temporary file left", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-helper-manifest-"));
    const artifactPath = join(root, "helper");
    const privateKeyPath = join(root, "test-key.pem");
    const keys = generateKeyPairSync("ed25519");
    const artifact = "compiled test helper";
    writeFileSync(artifactPath, artifact);
    writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          fileURLToPath(new URL("../scripts/release-manifest.ts", import.meta.url)),
          "--artifact",
          artifactPath,
          "--target",
          "bun-darwin-arm64",
          "--private-key",
          privateKeyPath,
          "--key-id",
          "test-release",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(existsSync(`${artifactPath}.manifest.json.tmp`)).toBe(false);
      const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
        readFileSync(`${artifactPath}.manifest.json`, "utf8"),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        packageId: USE_ONCE_HELPER_PACKAGE_ID,
        target: "bun-darwin-arm64",
        artifactName: "helper",
        artifactBytes: Buffer.byteLength(artifact),
        artifactSha256: createHash("sha256").update(artifact).digest("hex"),
        signature: { algorithm: "Ed25519", keyId: "test-release" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test.each([...USE_ONCE_HELPER_RELEASE_TARGETS])(
    "binds package identity, checksum, and an Ed25519 signature for %s",
    (target) => {
      const keys = generateKeyPairSync("ed25519");
      const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const artifact = new TextEncoder().encode("compiled helper");
      const manifest = createSignedHelperReleaseManifest({
        version: "0.1.0",
        target,
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
      const extraFieldManifest = { ...manifest, url: "https://attacker.test/helper" };
      expect(
        verifySignedHelperReleaseManifest({
          manifest: extraFieldManifest,
          artifact,
          publicKeyPem,
        }),
      ).toBe(false);
      expect(
        verifySignedHelperReleaseManifest({
          manifest: { ...manifest, target: "unsupported" },
          artifact,
          publicKeyPem,
        }),
      ).toBe(false);
      expect(() =>
        createSignedHelperReleaseManifest({
          version: "0.1.0",
          target: "unsupported",
          artifactName: "selftune-use-once",
          artifact,
          keyId: "release-2026-01",
          privateKeyPem,
        }),
      ).toThrow("Unsupported helper release target");
    },
  );
});
