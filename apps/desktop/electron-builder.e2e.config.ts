import type { Configuration } from "electron-builder";

import releaseConfig from "./electron-builder.config";

const config: Configuration = {
  ...releaseConfig,
  forceCodeSigning: false,
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

export default config;
