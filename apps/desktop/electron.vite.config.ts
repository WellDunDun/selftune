import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import {
  desktopPlatformFromTarget,
  desktopReleaseTrustPinsFromEnvironment,
} from "./src/main/desktop-protocol";

const sentryDsn = process.env.SELFTUNE_DESKTOP_SENTRY_DSN ?? "";
const buildPlatform = desktopPlatformFromTarget(process.env.BUN_TARGET, process.platform);
const releasePins = desktopReleaseTrustPinsFromEnvironment(buildPlatform, {
  DESKTOP_MACOS_TEAM_IDENTIFIER: process.env.DESKTOP_MACOS_TEAM_IDENTIFIER,
  DESKTOP_MACOS_CERTIFICATE_AUTHORITY: process.env.DESKTOP_MACOS_CERTIFICATE_AUTHORITY,
  DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256:
    process.env.DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256,
  DESKTOP_WINDOWS_PUBLISHER_SUBJECT: process.env.DESKTOP_WINDOWS_PUBLISHER_SUBJECT,
  DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT: process.env.DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT,
});
const macOsPins = releasePins?.platform === "darwin" ? releasePins : null;
const windowsPins = releasePins?.platform === "win32" ? releasePins : null;

export default defineConfig({
  main: {
    define: {
      __SELFTUNE_SENTRY_DSN__: JSON.stringify(sentryDsn),
      __SELFTUNE_DESKTOP_MACOS_TEAM_IDENTIFIER__: JSON.stringify(macOsPins?.teamIdentifier ?? ""),
      __SELFTUNE_DESKTOP_MACOS_CERTIFICATE_AUTHORITY__: JSON.stringify(
        macOsPins?.certificateAuthority ?? "",
      ),
      __SELFTUNE_DESKTOP_MACOS_DESIGNATED_REQUIREMENT_SHA256__: JSON.stringify(
        macOsPins?.designatedRequirementSha256 ?? "",
      ),
      __SELFTUNE_DESKTOP_WINDOWS_PUBLISHER_SUBJECT__: JSON.stringify(
        windowsPins?.publisherSubject ?? "",
      ),
      __SELFTUNE_DESKTOP_WINDOWS_CERTIFICATE_THUMBPRINT__: JSON.stringify(
        windowsPins?.certificateThumbprint ?? "",
      ),
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@selftune/config", "@selftune/local", "@selftune/runtime"],
      }),
    ],
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        external: ["electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: { input: { main: "src/renderer/index.html" } },
    },
  },
});
