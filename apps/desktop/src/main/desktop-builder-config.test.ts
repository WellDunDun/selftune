import { describe, expect, it } from "bun:test";

import { createDesktopBuilderConfig } from "../../desktop-builder-config";
import { createDesktopE2eBuilderConfig } from "../../electron-builder.e2e.config";

const MAC_RELEASE_ENVIRONMENT = {
  BUN_TARGET: "bun-darwin-arm64",
  DESKTOP_REQUIRE_CODE_SIGNING: "true",
  DESKTOP_MACOS_TEAM_IDENTIFIER: "ABC123XYZ9",
  DESKTOP_MACOS_CERTIFICATE_AUTHORITY:
    "Developer ID Application: PragSys Collaborative LLC (ABC123XYZ9)",
  DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256: "a".repeat(64),
} as const;

const WINDOWS_RELEASE_ENVIRONMENT = {
  BUN_TARGET: "bun-windows-x64",
  DESKTOP_REQUIRE_CODE_SIGNING: "true",
  DESKTOP_WINDOWS_PUBLISHER_SUBJECT: "CN=SelfTune LLC, O=SelfTune LLC, C=US",
  DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
} as const;

describe("Desktop builder protocol configuration", () => {
  it("loads protocol metadata only for a pinned signed target", () => {
    const signed = createDesktopBuilderConfig(MAC_RELEASE_ENVIRONMENT, "linux");
    expect(signed.forceCodeSigning).toBeTrue();
    expect(signed.protocols).toEqual([{ name: "SelfTune install handoff", schemes: ["selftune"] }]);
    expect(signed.mac?.identity).toBe("PragSys Collaborative LLC (ABC123XYZ9)");

    const unsigned = createDesktopBuilderConfig(
      { ...MAC_RELEASE_ENVIRONMENT, DESKTOP_REQUIRE_CODE_SIGNING: "false" },
      "darwin",
    );
    expect(unsigned.forceCodeSigning).toBeFalse();
    expect(unsigned.protocols).toBeUndefined();
    expect(unsigned.mac?.identity).toBeUndefined();
  });

  it("fails signed supported-platform config loading when identity pins are absent", () => {
    expect(() =>
      createDesktopBuilderConfig(
        { BUN_TARGET: "bun-darwin-arm64", DESKTOP_REQUIRE_CODE_SIGNING: "true" },
        "darwin",
      ),
    ).toThrow("Pinned darwin Desktop release identity is required");
    expect(() =>
      createDesktopBuilderConfig(
        { BUN_TARGET: "bun-windows-x64", DESKTOP_REQUIRE_CODE_SIGNING: "true" },
        "win32",
      ),
    ).toThrow("Pinned win32 Desktop release identity is required");
  });

  it("selects the exact pinned Windows signing certificate", () => {
    const signed = createDesktopBuilderConfig(WINDOWS_RELEASE_ENVIRONMENT, "darwin");
    expect(signed.forceCodeSigning).toBeTrue();
    expect(signed.win?.signtoolOptions?.certificateSha1).toBe(
      WINDOWS_RELEASE_ENVIRONMENT.DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT,
    );
    expect(signed.win?.signtoolOptions?.certificateSubjectName).toBe(
      WINDOWS_RELEASE_ENVIRONMENT.DESKTOP_WINDOWS_PUBLISHER_SUBJECT,
    );
  });

  it("never emits Linux protocol metadata even when signing is requested", () => {
    const config = createDesktopBuilderConfig(
      { ...MAC_RELEASE_ENVIRONMENT, BUN_TARGET: "bun-linux-x64" },
      "darwin",
    );
    expect(config.forceCodeSigning).toBeFalse();
    expect(config.protocols).toBeUndefined();
  });

  it("strips inherited signing and protocol metadata from E2E config for every environment", () => {
    const config = createDesktopE2eBuilderConfig(MAC_RELEASE_ENVIRONMENT, "darwin");
    expect(config.forceCodeSigning).toBeFalse();
    expect(config.protocols).toBeUndefined();
    expect(config.mac).toMatchObject({ identity: null, notarize: false, target: ["dir"] });
  });

  it("copies the compiled runtime's nested native dependencies as explicit resources", () => {
    const config = createDesktopBuilderConfig({}, "darwin");
    expect(config.extraResources).toContainEqual({
      from: "resources/selftune/node_modules",
      to: "selftune/node_modules",
      filter: ["**/*"],
    });
  });
});
