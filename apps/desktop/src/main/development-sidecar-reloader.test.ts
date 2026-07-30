import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  developmentSidecarSourceRoots,
  isDevelopmentSidecarSource,
  startDevelopmentSidecarReloader,
} from "./development-sidecar-reloader";

describe("development sidecar reloader", () => {
  test("maps the desktop app path to the harness source root", () => {
    const roots = developmentSidecarSourceRoots("/repo/apps/desktop");

    expect(roots).toEqual([resolve("/repo/packages/harnesses")]);
  });

  test("only treats backend source files as reload signals", () => {
    expect(isDevelopmentSidecarSource("cline/src/descriptor.ts")).toBe(true);
    expect(isDevelopmentSidecarSource("runtime/config.json")).toBe(true);
    expect(isDevelopmentSidecarSource("cline/node_modules/icon.ts")).toBe(false);
    expect(isDevelopmentSidecarSource("runtime/.turbo/cache.json")).toBe(false);
    expect(isDevelopmentSidecarSource("README.md")).toBe(false);
  });

  test("does not install source watchers in packaged builds", () => {
    let restarted = false;
    const close = startDevelopmentSidecarReloader({
      appPath: "/repo/apps/desktop",
      isPackaged: true,
      onError: () => undefined,
      restart: async () => {
        restarted = true;
      },
    });

    close();
    expect(restarted).toBe(false);
  });
});
