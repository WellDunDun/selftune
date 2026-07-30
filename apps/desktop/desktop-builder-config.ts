import type { Configuration } from "electron-builder";

import {
  desktopPlatformFromTarget,
  desktopProtocolConfiguration,
  desktopReleaseTrustPinsFromEnvironment,
  type DesktopReleaseTrustEnvironment,
} from "./src/main/desktop-protocol";

export interface DesktopBuilderEnvironment extends DesktopReleaseTrustEnvironment {
  readonly BUN_TARGET?: string;
  readonly DESKTOP_REQUIRE_CODE_SIGNING?: string;
}

export function readDesktopBuilderEnvironment(
  environment: NodeJS.ProcessEnv,
): DesktopBuilderEnvironment {
  return {
    BUN_TARGET: environment.BUN_TARGET,
    DESKTOP_REQUIRE_CODE_SIGNING: environment.DESKTOP_REQUIRE_CODE_SIGNING,
    DESKTOP_MACOS_TEAM_IDENTIFIER: environment.DESKTOP_MACOS_TEAM_IDENTIFIER,
    DESKTOP_MACOS_CERTIFICATE_AUTHORITY: environment.DESKTOP_MACOS_CERTIFICATE_AUTHORITY,
    DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256:
      environment.DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256,
    DESKTOP_WINDOWS_PUBLISHER_SUBJECT: environment.DESKTOP_WINDOWS_PUBLISHER_SUBJECT,
    DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT: environment.DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT,
  };
}

export function createDesktopBuilderConfig(
  environment: DesktopBuilderEnvironment,
  hostPlatform: NodeJS.Platform,
): Configuration {
  const platform = desktopPlatformFromTarget(environment.BUN_TARGET, hostPlatform);
  const signingRequired = environment.DESKTOP_REQUIRE_CODE_SIGNING === "true";
  const supportsRuntimeTrust = platform === "darwin" || platform === "win32";
  const pins = desktopReleaseTrustPinsFromEnvironment(platform, environment);
  if (signingRequired && supportsRuntimeTrust && !pins) {
    throw new Error(`Pinned ${platform} Desktop release identity is required for signed builds.`);
  }

  return {
    appId: "dev.selftune.desktop",
    productName: "SelfTune",
    executableName: "selftune",
    artifactName: "selftune-desktop-${os}-${arch}.${ext}",
    forceCodeSigning: signingRequired && supportsRuntimeTrust,
    protocols: signingRequired ? desktopProtocolConfiguration(platform, pins) : undefined,
    directories: { output: "dist", buildResources: "build" },
    files: ["out/**/*", "package.json"],
    extraResources: [
      { from: "resources/selftune", to: "selftune", filter: ["**/*"] },
      { from: "build/icon.png", to: "tray-icon.png" },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      icon: "build/icon.icns",
      identity:
        signingRequired && pins?.platform === "darwin" ? pins.certificateAuthority : undefined,
      target: ["dmg", "zip"],
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true,
    },
    win: {
      icon: "build/icon.ico",
      signtoolOptions:
        signingRequired && pins?.platform === "win32"
          ? {
              certificateSha1: pins.certificateThumbprint,
              certificateSubjectName: pins.publisherSubject,
            }
          : undefined,
      target: ["nsis"],
    },
    nsis: { oneClick: true, perMachine: false },
    linux: { category: "Development", icon: "build/icon.png", target: ["AppImage", "deb"] },
    publish: {
      provider: "github",
      owner: "selftune-dev",
      repo: "selftune",
    },
  };
}
