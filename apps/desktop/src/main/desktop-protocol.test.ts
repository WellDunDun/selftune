import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  desktopProtocolConfiguration,
  desktopReleaseTrustPinsFromEnvironment,
  isTrustedPackagedDesktopBuild,
  registerDesktopProtocol,
  type DesktopReleaseTrustPins,
} from "./desktop-protocol";

const REQUIREMENT = 'identifier "dev.selftune.desktop" and anchor apple generic';
const MAC_PINS: DesktopReleaseTrustPins = {
  platform: "darwin",
  teamIdentifier: "ABC123XYZ9",
  certificateAuthority: "Developer ID Application: SelfTune LLC (ABC123XYZ9)",
  designatedRequirementSha256: createHash("sha256").update(REQUIREMENT).digest("hex"),
};

describe("Desktop protocol registration", () => {
  it("registers only packaged builds whose production signature is verified", () => {
    for (const input of [
      { isPackaged: false, signatureVerified: false },
      { isPackaged: false, signatureVerified: true },
      { isPackaged: true, signatureVerified: false },
    ]) {
      const registrations: string[] = [];
      expect(
        registerDesktopProtocol(
          {
            isPackaged: input.isPackaged,
            setAsDefaultProtocolClient: (protocol) => {
              registrations.push(protocol);
              return true;
            },
          },
          input.signatureVerified,
        ),
      ).toEqual({ registered: false, reason: "untrusted_build" });
      expect(registrations).toEqual([]);
    }

    const registrations: string[] = [];
    expect(
      registerDesktopProtocol(
        {
          isPackaged: true,
          setAsDefaultProtocolClient: (protocol) => {
            registrations.push(protocol);
            return true;
          },
        },
        true,
      ),
    ).toEqual({ registered: true });
    expect(registrations).toEqual(["selftune"]);
  });

  it("emits metadata only for a platform with complete release pins", () => {
    expect(desktopProtocolConfiguration("linux", MAC_PINS)).toBeUndefined();
    expect(desktopProtocolConfiguration("darwin", null)).toBeUndefined();
    expect(desktopProtocolConfiguration("darwin", MAC_PINS)).toEqual([
      { name: "SelfTune install handoff", schemes: ["selftune"] },
    ]);
  });

  it("pins macOS trust to the exact team, authority, and designated requirement", () => {
    const trustedRun = (_command: string, args: ReadonlyArray<string>) => {
      if (args.includes("--verify")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("--requirements")) {
        return { status: 0, stdout: "", stderr: `designated => ${REQUIREMENT}\n` };
      }
      return {
        status: 0,
        stdout: "",
        stderr:
          "Authority=Developer ID Application: SelfTune LLC (ABC123XYZ9)\nTeamIdentifier=ABC123XYZ9\n",
      };
    };
    expect(
      isTrustedPackagedDesktopBuild(
        { isPackaged: true, platform: "darwin", executablePath: "/SelfTune", pins: MAC_PINS },
        trustedRun,
      ),
    ).toBeTrue();
    expect(
      isTrustedPackagedDesktopBuild(
        {
          isPackaged: true,
          platform: "darwin",
          executablePath: "/SelfTune",
          pins: { ...MAC_PINS, teamIdentifier: "EVIL123456" },
        },
        trustedRun,
      ),
    ).toBeFalse();
    expect(
      isTrustedPackagedDesktopBuild(
        { isPackaged: true, platform: "darwin", executablePath: "/SelfTune", pins: null },
        trustedRun,
      ),
    ).toBeFalse();
  });

  it("pins Windows trust to the exact publisher subject and certificate thumbprint", () => {
    const pins: DesktopReleaseTrustPins = {
      platform: "win32",
      publisherSubject: "CN=SelfTune LLC, O=SelfTune LLC, C=US",
      certificateThumbprint: "A".repeat(40),
    };
    const run = () => ({
      status: 0,
      stdout: JSON.stringify({
        Status: "Valid",
        Subject: pins.publisherSubject,
        Thumbprint: pins.certificateThumbprint,
      }),
      stderr: "",
    });
    expect(
      isTrustedPackagedDesktopBuild(
        { isPackaged: true, platform: "win32", executablePath: "SelfTune.exe", pins },
        run,
      ),
    ).toBeTrue();
    expect(
      isTrustedPackagedDesktopBuild(
        {
          isPackaged: true,
          platform: "win32",
          executablePath: "SelfTune.exe",
          pins: { ...pins, certificateThumbprint: "B".repeat(40) },
        },
        run,
      ),
    ).toBeFalse();
  });

  it("fails closed when release pin configuration is partial or not official", () => {
    expect(desktopReleaseTrustPinsFromEnvironment("darwin", {})).toBeNull();
    expect(
      desktopReleaseTrustPinsFromEnvironment("darwin", {
        DESKTOP_MACOS_TEAM_IDENTIFIER: "ABC123XYZ9",
        DESKTOP_MACOS_CERTIFICATE_AUTHORITY:
          "Developer ID Application: Third Party LLC (ABC123XYZ9)",
        DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256: "a".repeat(64),
      }),
    ).toBeNull();
  });
});
