import type { Configuration } from "electron-builder";

import {
  createDesktopBuilderConfig,
  readDesktopBuilderEnvironment,
  type DesktopBuilderEnvironment,
} from "./desktop-builder-config";

export function createDesktopE2eBuilderConfig(
  environment: DesktopBuilderEnvironment,
  hostPlatform: NodeJS.Platform,
): Configuration {
  const releaseConfig = createDesktopBuilderConfig(
    { ...environment, DESKTOP_REQUIRE_CODE_SIGNING: "false" },
    hostPlatform,
  );
  return {
    ...releaseConfig,
    forceCodeSigning: false,
    protocols: undefined,
    directories: {
      ...releaseConfig.directories,
      output: "dist-e2e",
    },
    mac: {
      ...releaseConfig.mac,
      hardenedRuntime: false,
      identity: null,
      notarize: false,
      target: ["dir"],
    },
    win: {
      ...releaseConfig.win,
      target: ["dir"],
    },
    linux: {
      ...releaseConfig.linux,
      target: ["dir"],
    },
    publish: null,
  };
}

const config = createDesktopE2eBuilderConfig(
  readDesktopBuilderEnvironment(process.env),
  process.platform,
);
export default config;
