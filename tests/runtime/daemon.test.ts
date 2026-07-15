import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DaemonFailure,
  manifestMatchesStopExpectation,
  parseDaemonRunOptions,
} from "@selftune/local/daemon";
import type { ServerManifest } from "@selftune/local/local-runtime";

describe("daemon options", () => {
  const originalEnvironment = {
    configDir: process.env.SELFTUNE_CONFIG_DIR,
    desktop: process.env.SELFTUNE_DESKTOP,
    owner: process.env.SELFTUNE_RUNTIME_OWNER,
    supervised: process.env.SELFTUNE_SUPERVISED,
  };
  const roots: string[] = [];

  function restoreEnvironment(
    name: keyof typeof originalEnvironment,
    environmentName: string,
  ): void {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[environmentName];
    else process.env[environmentName] = value;
  }

  function temporaryConfigRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "selftune-daemon-options-"));
    roots.push(root);
    process.env.SELFTUNE_CONFIG_DIR = root;
    delete process.env.SELFTUNE_DESKTOP;
    delete process.env.SELFTUNE_RUNTIME_OWNER;
    delete process.env.SELFTUNE_SUPERVISED;
    return root;
  }

  afterEach(() => {
    restoreEnvironment("configDir", "SELFTUNE_CONFIG_DIR");
    restoreEnvironment("desktop", "SELFTUNE_DESKTOP");
    restoreEnvironment("owner", "SELFTUNE_RUNTIME_OWNER");
    restoreEnvironment("supervised", "SELFTUNE_SUPERVISED");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("parses the desktop supervised contract", () => {
    const configDir = temporaryConfigRoot();
    const options = parseDaemonRunOptions([
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--config-dir",
      configDir,
      "--spa-dir",
      "/tmp/dashboard",
      "--supervised",
      "--owner",
      "desktop",
      "--ready-sentinel",
    ]);
    expect(options).toMatchObject({
      port: 0,
      hostname: "127.0.0.1",
      configDir,
      owner: "desktop",
      spaDir: "/tmp/dashboard",
      supervision: "os-service",
      readySentinel: true,
      runtimeMode: "standalone",
    });
  });

  it("distinguishes CLI ownership from a desktop-managed child", () => {
    temporaryConfigRoot();
    const cli = parseDaemonRunOptions([]);
    const desktop = parseDaemonRunOptions(["--owner", "desktop"]);

    expect(cli).toMatchObject({ owner: "cli", supervision: "none" });
    expect(desktop).toMatchObject({
      owner: "desktop",
      supervision: "desktop-child",
    });
  });

  it("rejects an invalid port before starting the server", () => {
    temporaryConfigRoot();
    expect(() => parseDaemonRunOptions(["--port", "70000"])).toThrow(DaemonFailure);
  });

  it("rejects non-loopback listeners and mismatched config roots", () => {
    const configDir = temporaryConfigRoot();
    expect(() => parseDaemonRunOptions(["--hostname", "0.0.0.0"])).toThrow(
      "only listen on 127.0.0.1",
    );
    expect(() => parseDaemonRunOptions(["--config-dir", `${configDir}-other`])).toThrow(
      "must match SELFTUNE_CONFIG_DIR",
    );
  });

  it("binds conditional cleanup to one runtime instance", () => {
    const manifest: ServerManifest = {
      version: 2,
      kind: "selftune-runtime",
      pid: 4242,
      port: 7888,
      origin: "http://127.0.0.1:7888",
      started_at: "2026-07-15T00:00:00.000Z",
      owner: "desktop",
      supervision: "desktop-child",
      owner_version: "0.3.0",
      owner_executable_path: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
      instance_id: "11111111-1111-4111-8111-111111111111",
    };

    expect(
      manifestMatchesStopExpectation(manifest, {
        instanceId: manifest.instance_id,
        pid: manifest.pid,
      }),
    ).toBe(true);
    expect(
      manifestMatchesStopExpectation(manifest, {
        instanceId: "22222222-2222-4222-8222-222222222222",
        pid: manifest.pid,
      }),
    ).toBe(false);
  });
});
