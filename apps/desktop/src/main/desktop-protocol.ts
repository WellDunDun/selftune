import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as Schema from "effect/Schema";

import { parseDeveloperIdSigningIdentity } from "./runtime-integrity";

declare const __SELFTUNE_DESKTOP_MACOS_TEAM_IDENTIFIER__: string;
declare const __SELFTUNE_DESKTOP_MACOS_CERTIFICATE_AUTHORITY__: string;
declare const __SELFTUNE_DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256__: string;
declare const __SELFTUNE_DESKTOP_WINDOWS_PUBLISHER_SUBJECT__: string;
declare const __SELFTUNE_DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT__: string;

export const DESKTOP_PROTOCOL = "selftune";

export type DesktopReleaseTrustPins =
  | {
      readonly platform: "darwin";
      readonly teamIdentifier: string;
      readonly certificateAuthority: string;
      readonly designatedRequirementSha256: string;
    }
  | {
      readonly platform: "win32";
      readonly publisherSubject: string;
      readonly certificateThumbprint: string;
    };

export interface DesktopReleaseTrustEnvironment {
  readonly DESKTOP_MACOS_TEAM_IDENTIFIER?: string;
  readonly DESKTOP_MACOS_CERTIFICATE_AUTHORITY?: string;
  readonly DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256?: string;
  readonly DESKTOP_WINDOWS_PUBLISHER_SUBJECT?: string;
  readonly DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT?: string;
}

export function desktopPlatformFromTarget(
  target: string | undefined,
  hostPlatform: NodeJS.Platform,
): NodeJS.Platform {
  if (target?.startsWith("bun-darwin-")) return "darwin";
  if (target?.startsWith("bun-windows-")) return "win32";
  if (target?.startsWith("bun-linux-")) return "linux";
  return hostPlatform;
}

function normalized(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

export function desktopReleaseTrustPinsFromEnvironment(
  platform: NodeJS.Platform,
  environment: DesktopReleaseTrustEnvironment,
): DesktopReleaseTrustPins | null {
  if (platform === "darwin") {
    const teamIdentifier = normalized(environment.DESKTOP_MACOS_TEAM_IDENTIFIER);
    const certificateAuthority = normalized(environment.DESKTOP_MACOS_CERTIFICATE_AUTHORITY);
    const designatedRequirementSha256 = normalized(
      environment.DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256,
    )?.toLowerCase();
    if (
      !teamIdentifier ||
      !/^[A-Z0-9]{10}$/u.test(teamIdentifier) ||
      !certificateAuthority ||
      certificateAuthority !==
        `Developer ID Application: PragSys Collaborative LLC (${teamIdentifier})` ||
      !designatedRequirementSha256 ||
      !/^[a-f0-9]{64}$/u.test(designatedRequirementSha256)
    ) {
      return null;
    }
    return {
      platform,
      teamIdentifier,
      certificateAuthority,
      designatedRequirementSha256,
    };
  }
  if (platform === "win32") {
    const publisherSubject = normalized(environment.DESKTOP_WINDOWS_PUBLISHER_SUBJECT);
    const certificateThumbprint = normalized(
      environment.DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT,
    )?.toUpperCase();
    if (
      !publisherSubject ||
      publisherSubject.length > 512 ||
      !certificateThumbprint ||
      !/^[A-F0-9]{40}$/u.test(certificateThumbprint)
    ) {
      return null;
    }
    return { platform, publisherSubject, certificateThumbprint };
  }
  return null;
}

export function compiledDesktopReleaseTrustPins(
  platform: NodeJS.Platform,
): DesktopReleaseTrustPins | null {
  return desktopReleaseTrustPinsFromEnvironment(platform, {
    DESKTOP_MACOS_TEAM_IDENTIFIER:
      typeof __SELFTUNE_DESKTOP_MACOS_TEAM_IDENTIFIER__ !== "undefined"
        ? __SELFTUNE_DESKTOP_MACOS_TEAM_IDENTIFIER__
        : "",
    DESKTOP_MACOS_CERTIFICATE_AUTHORITY:
      typeof __SELFTUNE_DESKTOP_MACOS_CERTIFICATE_AUTHORITY__ !== "undefined"
        ? __SELFTUNE_DESKTOP_MACOS_CERTIFICATE_AUTHORITY__
        : "",
    DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256:
      typeof __SELFTUNE_DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256__ !== "undefined"
        ? __SELFTUNE_DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256__
        : "",
    DESKTOP_WINDOWS_PUBLISHER_SUBJECT:
      typeof __SELFTUNE_DESKTOP_WINDOWS_PUBLISHER_SUBJECT__ !== "undefined"
        ? __SELFTUNE_DESKTOP_WINDOWS_PUBLISHER_SUBJECT__
        : "",
    DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT:
      typeof __SELFTUNE_DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT__ !== "undefined"
        ? __SELFTUNE_DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT__
        : "",
  });
}

export function desktopProtocolConfiguration(
  platform: NodeJS.Platform,
  pins: DesktopReleaseTrustPins | null,
): Array<{ name: string; schemes: string[] }> | undefined {
  return pins?.platform === platform && (platform === "darwin" || platform === "win32")
    ? [{ name: "SelfTune Pack and install handoff", schemes: [DESKTOP_PROTOCOL] }]
    : undefined;
}

interface ProtocolApplication {
  readonly isPackaged: boolean;
  readonly setAsDefaultProtocolClient: (protocol: string) => boolean;
}

export type DesktopProtocolRegistration =
  | { readonly registered: true }
  | { readonly registered: false; readonly reason: "registration_failed" | "untrusted_build" };

export function registerDesktopProtocol(
  application: ProtocolApplication,
  trustedPackagedBuild: boolean,
): DesktopProtocolRegistration {
  if (!application.isPackaged || !trustedPackagedBuild) {
    return { registered: false, reason: "untrusted_build" };
  }
  return application.setAsDefaultProtocolClient(DESKTOP_PROTOCOL)
    ? { registered: true }
    : { registered: false, reason: "registration_failed" };
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type RunCommand = (command: string, args: ReadonlyArray<string>) => CommandResult;

const runCommand: RunCommand = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

function designatedRequirement(details: string): string | null {
  const line = details
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith("designated =>"));
  return line ? line.slice("designated =>".length).trim() || null : null;
}

function macOsSignatureIsTrusted(
  executablePath: string,
  pins: Extract<DesktopReleaseTrustPins, { readonly platform: "darwin" }>,
  run: RunCommand,
): boolean {
  if (run("/usr/bin/codesign", ["--verify", "--deep", "--strict", executablePath]).status !== 0) {
    return false;
  }
  const identity = run("/usr/bin/codesign", ["--display", "--verbose=4", executablePath]);
  if (identity.status !== 0) return false;
  const parsed = parseDeveloperIdSigningIdentity(`${identity.stdout}${identity.stderr}`);
  if (
    parsed?.teamIdentifier !== pins.teamIdentifier ||
    parsed.authority !== pins.certificateAuthority
  ) {
    return false;
  }
  const requirementResult = run("/usr/bin/codesign", [
    "--display",
    "--requirements",
    "-",
    executablePath,
  ]);
  if (requirementResult.status !== 0) return false;
  const requirement = designatedRequirement(
    `${requirementResult.stdout}${requirementResult.stderr}`,
  );
  return (
    requirement !== null &&
    createHash("sha256").update(requirement).digest("hex") === pins.designatedRequirementSha256
  );
}

function windowsSignatureIsTrusted(
  executablePath: string,
  pins: Extract<DesktopReleaseTrustPins, { readonly platform: "win32" }>,
  run: RunCommand,
): boolean {
  const result = run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; [Console]::Out.Write((@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Thumbprint = [string]$signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress))",
    executablePath,
  ]);
  if (result.status !== 0) return false;
  try {
    const signature = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          Status: Schema.Literal("Valid"),
          Subject: Schema.String,
          Thumbprint: Schema.String,
        }),
      ),
    )(result.stdout);
    return (
      signature.Subject === pins.publisherSubject &&
      signature.Thumbprint.toUpperCase() === pins.certificateThumbprint
    );
  } catch {
    return false;
  }
}

/** One pinned decision gates registration, intake, queueing, resolution, and IPC. */
export function isTrustedPackagedDesktopBuild(
  input: {
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly executablePath: string;
    readonly pins: DesktopReleaseTrustPins | null;
  },
  run: RunCommand = runCommand,
): boolean {
  if (!input.isPackaged || input.pins?.platform !== input.platform) return false;
  if (input.platform === "darwin" && input.pins.platform === "darwin") {
    return macOsSignatureIsTrusted(input.executablePath, input.pins, run);
  }
  if (input.platform === "win32" && input.pins.platform === "win32") {
    return windowsSignatureIsTrusted(input.executablePath, input.pins, run);
  }
  return false;
}
