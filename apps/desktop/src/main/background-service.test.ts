import { describe, expect, it } from "bun:test";

import { buildBackgroundServiceArgs, parseBackgroundServiceResponse } from "./background-service";

const options = {
  executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
  resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
  configDir: "/Users/test/.selftune",
  version: "0.3.0",
};

describe("background service CLI adapter", () => {
  it("delegates installation to the single bundled SelfTune runtime", () => {
    expect(buildBackgroundServiceArgs(options, "install")).toEqual([
      "service",
      "install",
      "--json",
      "--port",
      "7888",
      "--config-dir",
      "/Users/test/.selftune",
      "--executable",
      "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
      "--resource-dir",
      "/Applications/SelfTune.app/Contents/Resources/selftune",
      "--owner",
      "desktop",
      "--version",
      "0.3.0",
    ]);
  });

  it("decodes the machine-readable service response", () => {
    expect(
      parseBackgroundServiceResponse(
        `${JSON.stringify({
          ok: true,
          action: "status",
          status: {
            platform: "darwin",
            registered: true,
            running: true,
            pid: 42,
            detail: ["Serving http://127.0.0.1:7888."],
          },
        })}\n`,
      ),
    ).toEqual({
      platform: "darwin",
      registered: true,
      running: true,
      pid: 42,
      detail: ["Serving http://127.0.0.1:7888."],
    });
  });
});
