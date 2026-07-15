import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsDaemonWrapper,
  generateWindowsTaskXml,
  getServiceBackend,
  expectedRuntimeIsPresent,
  runServiceCommand,
  ServiceManager,
  serviceEnvironment,
  serviceProgramArguments,
  serviceRuntimeIsReady,
  systemdLingerArguments,
  systemdLingerMarkerPath,
  type LocalRuntimeControl,
  type ServiceBackend,
  type ServiceDescriptor,
  type ServicePlatform,
  type ServiceStatus,
} from "@selftune/local/service";
import type { ServerManifest } from "@selftune/local/local-runtime";

const descriptor: ServiceDescriptor = {
  executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
  executableArgsPrefix: [],
  resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
  configDir: "/Users/test/.selftune",
  owner: "desktop",
  version: "0.3.0",
  port: 7888,
  boot: false,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appBundledExecutable(bundleIdentifier: string): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-app-bundle-"));
  roots.push(root);
  const contents = join(root, "SelfTune.app", "Contents");
  const executable = join(contents, "Resources", "selftune", "selftune");
  mkdirSync(join(contents, "Resources", "selftune"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string></dict></plist>`,
  );
  return executable;
}

const serviceManifest: ServerManifest = {
  version: 2,
  kind: "selftune-runtime",
  pid: 4242,
  port: 7888,
  origin: "http://127.0.0.1:7888",
  started_at: "2026-07-15T00:00:00.000Z",
  owner: "desktop",
  supervision: "os-service",
  owner_version: "0.3.0",
  owner_executable_path: descriptor.executablePath,
  instance_id: "11111111-1111-4111-8111-111111111111",
};

const directCliManifest: ServerManifest = {
  ...serviceManifest,
  pid: 4343,
  owner: "cli",
  supervision: "none",
  owner_executable_path: "/usr/local/bin/selftune",
  instance_id: "22222222-2222-4222-8222-222222222222",
};

function serviceCommandHarness(
  platform: ServicePlatform,
  initialRuntime: "cli" | "service" | "none" = "service",
) {
  const events: string[] = [];
  let registered = true;
  let running = true;
  let runtimeKind = initialRuntime;
  const currentManifest = (): ServerManifest | null =>
    runtimeKind === "service" ? serviceManifest : runtimeKind === "cli" ? directCliManifest : null;
  const backend: ServiceBackend = {
    automated: true,
    platform,
    install: () =>
      Effect.sync(() => {
        events.push("backend:install");
        registered = true;
        running = true;
        runtimeKind = "service";
      }),
    uninstall: () =>
      Effect.sync(() => {
        events.push("backend:uninstall");
        registered = false;
        running = false;
      }),
    start: () =>
      Effect.sync(() => {
        running = true;
        if (runtimeKind === "none") runtimeKind = "service";
      }),
    status: () =>
      Effect.succeed({
        detail: [],
        pid: null,
        platform,
        registered,
        running,
      }),
    stop: () =>
      Effect.sync(() => {
        events.push("backend:stop");
        running = false;
      }),
    restart: () =>
      Effect.sync(() => {
        running = true;
        if (runtimeKind === "none") runtimeKind = "service";
      }),
  };
  const runtime: LocalRuntimeControl = {
    status: () =>
      Effect.sync(() => {
        const manifest = currentManifest();
        return { manifest, reachable: manifest !== null };
      }),
    stop: (_configDir, expectation) =>
      Effect.sync(() => {
        events.push("runtime:stop");
        const manifest = currentManifest();
        if (
          expectation &&
          (manifest?.pid !== expectation.pid || manifest.instance_id !== expectation.instanceId)
        ) {
          return false;
        }
        const stopped = manifest !== null;
        runtimeKind = "none";
        return stopped;
      }),
  };
  return {
    events,
    layer: Layer.succeed(ServiceManager)({ backend, runtime }),
  };
}

describe("supervised service definitions", () => {
  it("runs daemon mode through the same SelfTune binary", () => {
    expect(serviceProgramArguments(descriptor)).toEqual([
      descriptor.executablePath,
      "daemon",
      "run",
      "--foreground",
      "--supervised",
      "--owner",
      "desktop",
      "--port",
      "7888",
      "--hostname",
      "127.0.0.1",
      "--runtime-mode",
      "standalone",
      "--spa-dir",
      join(descriptor.resourceDir!, "dashboard"),
    ]);
  });

  it("keeps the bearer token out of durable service definitions", () => {
    const environment = serviceEnvironment(descriptor);
    expect(environment.SELFTUNE_SUPERVISED).toBe("1");
    expect(environment.SELFTUNE_RUNTIME_OWNER).toBe("desktop");
    expect(JSON.stringify(environment)).not.toContain("AUTH_TOKEN");

    const plist = generateLaunchdPlist({
      label: "dev.selftune.daemon",
      programArguments: serviceProgramArguments(descriptor),
      environment,
      workingDirectory: descriptor.configDir,
      stdoutPath: "/Users/test/.selftune/logs/daemon.log",
      stderrPath: "/Users/test/.selftune/logs/daemon.error.log",
    });
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).not.toContain("AssociatedBundleIdentifiers");
    expect(plist).not.toContain("AUTH_TOKEN");
  });

  it("only associates launchd services with a real enclosing app bundle", () => {
    const bundledDescriptor = {
      ...descriptor,
      executablePath: appBundledExecutable("dev.selftune.desktop.test"),
    };
    const bundled = generateLaunchdPlist({
      label: "dev.selftune.daemon",
      programArguments: serviceProgramArguments(bundledDescriptor),
      environment: serviceEnvironment(bundledDescriptor),
      workingDirectory: bundledDescriptor.configDir,
      stdoutPath: "/tmp/daemon.log",
      stderrPath: "/tmp/daemon.error.log",
    });
    const standalone = generateLaunchdPlist({
      label: "dev.selftune.daemon",
      programArguments: serviceProgramArguments({
        ...descriptor,
        executablePath: "/usr/local/bin/selftune",
      }),
      environment: serviceEnvironment(descriptor),
      workingDirectory: descriptor.configDir,
      stdoutPath: "/tmp/daemon.log",
      stderrPath: "/tmp/daemon.error.log",
    });

    expect(bundled).toContain("AssociatedBundleIdentifiers");
    expect(bundled).toContain("dev.selftune.desktop.test");
    expect(standalone).not.toContain("AssociatedBundleIdentifiers");
  });

  it("preserves CLI ownership in a CLI-installed service", () => {
    const cliDescriptor: ServiceDescriptor = {
      ...descriptor,
      owner: "cli",
      resourceDir: undefined,
    };

    expect(serviceProgramArguments(cliDescriptor)).toContain("cli");
    expect(serviceEnvironment(cliDescriptor)).toMatchObject({
      SELFTUNE_DESKTOP: "0",
      SELFTUNE_RUNTIME_OWNER: "cli",
      SELFTUNE_SUPERVISED: "1",
    });
  });

  it("generates a crash-restarting systemd user service", () => {
    const unit = generateSystemdUnit({
      execStart: serviceProgramArguments(descriptor),
      environment: serviceEnvironment(descriptor),
      workingDirectory: descriptor.configDir,
      stdoutPath: "/Users/test/.selftune/logs/daemon.log",
      stderrPath: "/Users/test/.selftune/logs/daemon.error.log",
    });
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("selftune daemon run");
    expect(systemdLingerArguments(true, "tester")).toEqual(["enable-linger", "tester"]);
    expect(systemdLingerArguments(false, "tester")).toEqual(["disable-linger", "tester"]);
    expect(systemdLingerMarkerPath("/home/test/.selftune")).toBe(
      join("/home/test/.selftune", "server-control", "systemd-linger-enabled-by-selftune"),
    );
  });

  it("takes over the authenticated predecessor before installing a service", async () => {
    const harness = serviceCommandHarness("darwin");

    await Effect.runPromise(
      runServiceCommand("install", descriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events).toEqual(["runtime:stop", "backend:install"]);
  });

  it("confirms the Windows listener exits after stop and uninstall", async () => {
    const stopped = serviceCommandHarness("win32");
    await Effect.runPromise(
      runServiceCommand("stop", descriptor).pipe(Effect.provide(stopped.layer)),
    );
    expect(stopped.events).toEqual(["backend:stop", "runtime:stop"]);

    const uninstalled = serviceCommandHarness("win32");
    await Effect.runPromise(
      runServiceCommand("uninstall", descriptor).pipe(Effect.provide(uninstalled.layer)),
    );
    expect(uninstalled.events).toEqual(["backend:uninstall", "runtime:stop"]);
  });

  it("does not stop a direct CLI runtime when a Windows task is stopped", async () => {
    const harness = serviceCommandHarness("win32", "cli");

    await Effect.runPromise(
      runServiceCommand("stop", descriptor).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.events).toEqual(["backend:stop"]);
  });

  it("requires the reachable runtime to belong to the OS service", () => {
    const backendStatus: ServiceStatus = {
      detail: [],
      pid: null,
      platform: "win32",
      registered: true,
      running: true,
    };

    expect(
      serviceRuntimeIsReady(backendStatus, { manifest: serviceManifest, reachable: true }),
    ).toBe(true);
    expect(
      serviceRuntimeIsReady(
        backendStatus,
        { manifest: serviceManifest, reachable: true },
        descriptor,
      ),
    ).toBe(true);
    expect(
      serviceRuntimeIsReady(
        backendStatus,
        { manifest: serviceManifest, reachable: true },
        { ...descriptor, version: "0.4.0" },
      ),
    ).toBe(false);
    expect(
      serviceRuntimeIsReady(backendStatus, { manifest: directCliManifest, reachable: true }),
    ).toBe(false);
    expect(
      serviceRuntimeIsReady(
        { ...backendStatus, pid: serviceManifest.pid + 1 },
        { manifest: serviceManifest, reachable: true },
      ),
    ).toBe(false);
  });

  it("tracks the stopped service instance without treating a replacement as the same runtime", () => {
    const expectation = {
      instanceId: serviceManifest.instance_id,
      pid: serviceManifest.pid,
    };

    expect(expectedRuntimeIsPresent(serviceManifest, expectation)).toBe(true);
    expect(expectedRuntimeIsPresent(directCliManifest, expectation)).toBe(false);
  });

  it("generates a hidden per-user Windows task with restart-on-failure", () => {
    const wrapper = generateWindowsDaemonWrapper({
      ...descriptor,
      executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
      configDir: "C:\\Users\\test\\.selftune",
      resourceDir: "C:\\Program Files\\SelfTune",
    });
    expect(wrapper).toContain("daemon");
    expect(wrapper).toContain("SELFTUNE_SUPERVISED=1");
    expect(wrapper).not.toContain("AUTH_TOKEN");

    const task = generateWindowsTaskXml({
      boot: false,
      launcherPath: "C:\\Users\\test\\.selftune\\server-control\\run-daemon.vbs",
      userId: "WORKSTATION\\test",
    });
    expect(task).toContain("<LogonTrigger>");
    expect(task).toContain("<RestartOnFailure>");
    expect(task).toContain("InteractiveToken");
  });

  it("selects a backend for every supported desktop platform", () => {
    expect(getServiceBackend("darwin").platform).toBe("darwin");
    expect(getServiceBackend("linux").platform).toBe("linux");
    expect(getServiceBackend("win32").platform).toBe("win32");
    expect(getServiceBackend("freebsd").platform).toBe("unsupported");
  });
});
