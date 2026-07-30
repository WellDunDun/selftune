import { createHash, sign, verify } from "node:crypto";

export const USE_ONCE_HELPER_PACKAGE_ID = "dev.selftune.use-once-helper";
export const USE_ONCE_HELPER_PACKAGE_NAME = "@selftune/use-once-helper";
export const USE_ONCE_HELPER_RELEASE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-windows-x64",
] as const;

export interface SignedHelperReleaseManifest {
  readonly schemaVersion: 1;
  readonly packageId: typeof USE_ONCE_HELPER_PACKAGE_ID;
  readonly packageName: typeof USE_ONCE_HELPER_PACKAGE_NAME;
  readonly version: string;
  readonly target: string;
  readonly artifactName: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly valueBase64url: string;
  };
}

export type UnsignedHelperReleaseManifest = Omit<SignedHelperReleaseManifest, "signature">;

export function canonicalUnsignedManifestBytes(input: UnsignedHelperReleaseManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: input.schemaVersion,
      packageId: input.packageId,
      packageName: input.packageName,
      version: input.version,
      target: input.target,
      artifactName: input.artifactName,
      artifactBytes: input.artifactBytes,
      artifactSha256: input.artifactSha256,
    }),
  );
}

export function createSignedHelperReleaseManifest(input: {
  readonly version: string;
  readonly target: string;
  readonly artifactName: string;
  readonly artifact: Uint8Array;
  readonly keyId: string;
  readonly privateKeyPem: string;
}): SignedHelperReleaseManifest {
  if (!(USE_ONCE_HELPER_RELEASE_TARGETS as readonly string[]).includes(input.target))
    throw new Error("Unsupported helper release target.");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(input.version))
    throw new Error("Helper release version must be SemVer.");
  if (!/^[A-Za-z0-9._-]+$/.test(input.artifactName) || input.artifactName.length > 128)
    throw new Error("Helper artifact name must be a portable basename.");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.keyId)) throw new Error("Invalid release key id.");
  const unsigned: UnsignedHelperReleaseManifest = {
    schemaVersion: 1,
    packageId: USE_ONCE_HELPER_PACKAGE_ID,
    packageName: USE_ONCE_HELPER_PACKAGE_NAME,
    version: input.version,
    target: input.target,
    artifactName: input.artifactName,
    artifactBytes: input.artifact.byteLength,
    artifactSha256: createHash("sha256").update(input.artifact).digest("hex"),
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "Ed25519",
      keyId: input.keyId,
      valueBase64url: sign(
        null,
        canonicalUnsignedManifestBytes(unsigned),
        input.privateKeyPem,
      ).toString("base64url"),
    },
  };
}

export function verifySignedHelperReleaseManifest(input: {
  readonly manifest: SignedHelperReleaseManifest;
  readonly artifact: Uint8Array;
  readonly publicKeyPem: string;
}): boolean {
  if (
    Object.keys(input.manifest).toSorted().join(",") !==
      "artifactBytes,artifactName,artifactSha256,packageId,packageName,schemaVersion,signature,target,version" ||
    Object.keys(input.manifest.signature).toSorted().join(",") !==
      "algorithm,keyId,valueBase64url" ||
    input.manifest.schemaVersion !== 1 ||
    !(USE_ONCE_HELPER_RELEASE_TARGETS as readonly string[]).includes(input.manifest.target) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(input.manifest.version) ||
    !/^[A-Za-z0-9._-]+$/.test(input.manifest.artifactName) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(input.manifest.signature.keyId) ||
    !/^[A-Za-z0-9_-]{86}$/.test(input.manifest.signature.valueBase64url)
  )
    return false;
  const { signature, ...unsigned } = input.manifest;
  const digest = createHash("sha256").update(input.artifact).digest("hex");
  try {
    return (
      input.manifest.packageId === USE_ONCE_HELPER_PACKAGE_ID &&
      input.manifest.packageName === USE_ONCE_HELPER_PACKAGE_NAME &&
      input.manifest.artifactBytes === input.artifact.byteLength &&
      input.manifest.artifactSha256 === digest &&
      signature.algorithm === "Ed25519" &&
      verify(
        null,
        canonicalUnsignedManifestBytes(unsigned),
        input.publicKeyPem,
        Buffer.from(signature.valueBase64url, "base64url"),
      )
    );
  } catch {
    return false;
  }
}
