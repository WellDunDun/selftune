import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDeveloperIdSigningIdentity,
  runtimeMatchesSignedSource,
  verifyRuntimeDirectory,
} from "./runtime-integrity";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-runtime-install-"));
  roots.push(root);
  const executable = Buffer.from("selftune-runtime");
  const settings = Buffer.from('{"version":1}\n');
  writeFileSync(join(root, "selftune"), executable, { mode: 0o700 });
  writeFileSync(join(root, "settings_snippet.json"), settings);
  writeFileSync(
    join(root, "runtime-manifest.json"),
    JSON.stringify({
      version: 2,
      files: [
        {
          path: "selftune",
          signing_mutable: true,
          size: executable.byteLength,
          sha256: createHash("sha256").update(executable).digest("hex"),
        },
        {
          path: "settings_snippet.json",
          signing_mutable: false,
          size: settings.byteLength,
          sha256: createHash("sha256").update(settings).digest("hex"),
        },
      ],
    }),
  );
  return root;
}

describe("stable desktop runtime integrity", () => {
  it("recognizes only Developer ID application identities with a team", () => {
    expect(
      parseDeveloperIdSigningIdentity(
        [
          "Authority=Developer ID Application: SelfTune LLC (ABC123XYZ9)",
          "TeamIdentifier=ABC123XYZ9",
        ].join("\n"),
      ),
    ).toEqual({
      authority: "Developer ID Application: SelfTune LLC (ABC123XYZ9)",
      teamIdentifier: "ABC123XYZ9",
    });
    expect(
      parseDeveloperIdSigningIdentity(
        "Authority=Apple Development: SelfTune LLC (ABC123XYZ9)\nTeamIdentifier=ABC123XYZ9",
      ),
    ).toBeNull();
    expect(
      parseDeveloperIdSigningIdentity(
        "Authority=Developer ID Application: SelfTune LLC (ABC123XYZ9)",
      ),
    ).toBeNull();
  });

  it("accepts a complete runtime matching its signed manifest", () => {
    expect(verifyRuntimeDirectory(runtimeFixture())).toBeTrue();
  });

  it("rejects a byte-identical installed runtime that cannot execute", () => {
    if (process.platform === "win32") return;
    const root = runtimeFixture();
    chmodSync(join(root, "selftune"), 0o600);
    expect(verifyRuntimeDirectory(root)).toBeFalse();
  });

  it("rejects tampering and manifest path traversal", () => {
    const root = runtimeFixture();
    writeFileSync(join(root, "selftune"), "tampered");
    expect(verifyRuntimeDirectory(root)).toBeFalse();

    writeFileSync(
      join(root, "runtime-manifest.json"),
      JSON.stringify({
        version: 2,
        files: [
          {
            path: "../outside",
            signing_mutable: true,
            size: 0,
            sha256: "0".repeat(64),
          },
        ],
      }),
    );
    expect(verifyRuntimeDirectory(root)).toBeFalse();
  });

  it("requires copied runtimes to retain the signed source manifest", () => {
    const source = runtimeFixture();
    const candidate = runtimeFixture();
    expect(runtimeMatchesSignedSource(source, candidate)).toBeTrue();

    const replacement = Buffer.from("replacement-runtime");
    writeFileSync(join(candidate, "selftune"), replacement);
    writeFileSync(
      join(candidate, "runtime-manifest.json"),
      JSON.stringify({
        version: 2,
        files: [
          {
            path: "selftune",
            signing_mutable: true,
            size: replacement.byteLength,
            sha256: createHash("sha256").update(replacement).digest("hex"),
          },
        ],
      }),
    );
    expect(verifyRuntimeDirectory(candidate)).toBeTrue();
    expect(runtimeMatchesSignedSource(source, candidate)).toBeFalse();
  });

  it("accepts a signing-mutated executable only when the verified source and copy match", () => {
    const source = runtimeFixture();
    const candidate = runtimeFixture();
    writeFileSync(join(source, "selftune"), "developer-id-signed-runtime");
    writeFileSync(join(candidate, "selftune"), "developer-id-signed-runtime");

    expect(verifyRuntimeDirectory(source)).toBeFalse();
    expect(verifyRuntimeDirectory(source, { allowPlatformSigningMutation: true })).toBeTrue();
    expect(
      runtimeMatchesSignedSource(source, candidate, {
        allowPlatformSigningMutation: true,
      }),
    ).toBeTrue();

    writeFileSync(join(candidate, "selftune"), "different-signed-runtime");
    expect(
      runtimeMatchesSignedSource(source, candidate, {
        allowPlatformSigningMutation: true,
      }),
    ).toBeFalse();
  });

  it("never exempts non-executable runtime assets from their build hash", () => {
    const root = runtimeFixture();
    writeFileSync(join(root, "settings_snippet.json"), "tampered");
    expect(verifyRuntimeDirectory(root, { allowPlatformSigningMutation: true })).toBeFalse();
  });
});
