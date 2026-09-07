import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { LOCAL_SERVICE_LABEL } from "@selftune/local/local-runtime";
import {
  generateLaunchdPlist,
  launchdPlistPath,
  ServiceFailure,
  serviceEnvironment,
  serviceProgramArguments,
  type ServiceDescriptor,
} from "@selftune/local/service";
import { makeLaunchdBackend } from "@selftune/local/service/launchd/backend";

const descriptor: ServiceDescriptor = {
  boot: false,
  configDir: "/Users/test/.selftune",
  executableArgsPrefix: [],
  executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
  owner: "desktop",
  port: 7888,
  resourceDir: "/Applications/SelfTune.app/Contents/Resources/selftune",
  version: "0.3.0",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function appBundledExecutable(bundleIdentifier: string): string {
  const root = temporaryRoot("selftune-app-bundle-");
  const contents = join(root, "SelfTune.app", "Contents");
  const executable = join(contents, "Resources", "selftune", "selftune");
  mkdirSync(join(contents, "Resources", "selftune"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string></dict></plist>`,
  );
  return executable;
}

describe("launchd service backend", () => {
  it("preserves the launchd plist byte format", () => {
    expect(
      generateLaunchdPlist({
        environment: { KEY: '<&"' },
        label: LOCAL_SERVICE_LABEL,
        programArguments: ["/bin/selftune", "a&b"],
        stderrPath: "/tmp/error.log",
        stdoutPath: "/tmp/output.log",
        workingDirectory: "/tmp/selftune",
      }),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.selftune.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/selftune</string>
    <string>a&amp;b</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KEY</key>
    <string>&lt;&amp;&quot;</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>/tmp/selftune</string>
  <key>StandardOutPath</key>
  <string>/tmp/output.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/error.log</string>
</dict>
</plist>
`);
  });

  it("keeps the bearer token out of durable service definitions", () => {
    const standalone = {
      ...descriptor,
      executablePath: "/tmp/selftune-test-standalone/bin/selftune",
    };
    const environment = serviceEnvironment(standalone);
    expect(environment.SELFTUNE_SUPERVISED).toBe("1");
    expect(environment.SELFTUNE_RUNTIME_OWNER).toBe("desktop");
    expect(JSON.stringify(environment)).not.toContain("AUTH_TOKEN");

    const plist = generateLaunchdPlist({
      environment,
      label: LOCAL_SERVICE_LABEL,
      programArguments: serviceProgramArguments(standalone),
      stderrPath: "/Users/test/.selftune/logs/daemon.error.log",
      stdoutPath: "/Users/test/.selftune/logs/daemon.log",
      workingDirectory: descriptor.configDir,
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
      environment: serviceEnvironment(bundledDescriptor),
      label: LOCAL_SERVICE_LABEL,
      programArguments: serviceProgramArguments(bundledDescriptor),
      stderrPath: "/tmp/daemon.error.log",
      stdoutPath: "/tmp/daemon.log",
      workingDirectory: bundledDescriptor.configDir,
    });
    const standalone = generateLaunchdPlist({
      environment: serviceEnvironment(descriptor),
      label: LOCAL_SERVICE_LABEL,
      programArguments: serviceProgramArguments({
        ...descriptor,
        executablePath: "/usr/local/bin/selftune",
      }),
      stderrPath: "/tmp/daemon.error.log",
      stdoutPath: "/tmp/daemon.log",
      workingDirectory: descriptor.configDir,
    });

    expect(bundled).toContain("AssociatedBundleIdentifiers");
    expect(bundled).toContain("dev.selftune.desktop.test");
    expect(standalone).not.toContain("AssociatedBundleIdentifiers");
  });

  it("keeps the ambient plist path compatible", () => {
    expect(launchdPlistPath()).toBe(
      join(homedir(), "Library", "LaunchAgents", `${LOCAL_SERVICE_LABEL}.plist`),
    );
  });

  it("uses injected identity and paths while tolerating missing and already-loaded services", async () => {
    const root = temporaryRoot("selftune-launchd-backend-");
    const homeDirectory = join(root, "home");
    const configDir = join(root, "config");
    const plistPath = join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LOCAL_SERVICE_LABEL}.plist`,
    );
    const target = `gui/501/${LOCAL_SERVICE_LABEL}`;
    const calls: ReadonlyArray<string>[] = [];
    const backend = makeLaunchdBackend({
      homeDirectory,
      uid: 501,
      run: (_command, args) =>
        Effect.sync(() => {
          calls.push(args);
          switch (args[0]) {
            case "bootout":
            case "disable":
              return { code: 1, stderr: "Could not find service", stdout: "" };
            case "bootstrap":
              return { code: 1, stderr: "Service already loaded", stdout: "" };
            case "print":
              return { code: 0, stderr: "", stdout: "service = { pid = 4321; }" };
            default:
              return { code: 0, stderr: "", stdout: "" };
          }
        }),
    });
    const installedDescriptor = { ...descriptor, configDir };

    await Effect.runPromise(backend.install(installedDescriptor));
    expect(existsSync(plistPath)).toBe(true);
    if (process.platform !== "win32") expect(statSync(plistPath).mode & 0o077).toBe(0);
    expect(readFileSync(plistPath, "utf8")).toBe(
      generateLaunchdPlist({
        environment: serviceEnvironment(installedDescriptor),
        label: LOCAL_SERVICE_LABEL,
        programArguments: serviceProgramArguments(installedDescriptor),
        stderrPath: join(configDir, "logs", "daemon.error.log"),
        stdoutPath: join(configDir, "logs", "daemon.log"),
        workingDirectory: configDir,
      }),
    );

    expect(await Effect.runPromise(backend.status(installedDescriptor))).toEqual({
      detail: [],
      pid: 4321,
      platform: "darwin",
      registered: true,
      running: true,
    });
    await Effect.runPromise(backend.uninstall(installedDescriptor));

    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([
      ["bootout", target],
      ["enable", target],
      ["bootstrap", "gui/501", plistPath],
      ["kickstart", target],
      ["print", target],
      ["bootout", target],
      ["disable", target],
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "replaces permissive and symlinked plist leaves before launchctl activation",
    async () => {
      const root = temporaryRoot("selftune-launchd-backend-");
      const homeDirectory = join(root, "home");
      const agentsDir = join(homeDirectory, "Library", "LaunchAgents");
      const plistPath = join(agentsDir, `${LOCAL_SERVICE_LABEL}.plist`);
      const referent = join(root, "referent.plist");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(plistPath, "permissive");
      chmodSync(plistPath, 0o666);
      const backend = makeLaunchdBackend({
        homeDirectory,
        uid: 501,
        run: (_command, _args) =>
          Effect.sync(() => {
            expect(lstatSync(plistPath).isFile()).toBe(true);
            expect(lstatSync(plistPath).mode & 0o777).toBe(0o600);
            return { code: 0, stderr: "", stdout: "" };
          }),
      });
      const installedDescriptor = { ...descriptor, configDir: join(root, "config") };

      await Effect.runPromise(backend.install(installedDescriptor));
      expect(lstatSync(plistPath).mode & 0o777).toBe(0o600);

      unlinkSync(plistPath);
      writeFileSync(referent, "referent");
      symlinkSync(referent, plistPath);
      await Effect.runPromise(backend.install(installedDescriptor));

      expect(lstatSync(plistPath).isFile()).toBe(true);
      expect(readFileSync(referent, "utf8")).toBe("referent");
    },
  );

  it("does not invoke launchctl when plist replacement fails", async () => {
    const root = temporaryRoot("selftune-launchd-backend-");
    const homeDirectory = join(root, "home");
    const plistPath = join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LOCAL_SERVICE_LABEL}.plist`,
    );
    mkdirSync(plistPath, { recursive: true });
    const calls: ReadonlyArray<string>[] = [];
    const backend = makeLaunchdBackend({
      homeDirectory,
      uid: 501,
      run: (_command, args) =>
        Effect.sync(() => {
          calls.push(args);
          return { code: 0, stderr: "", stdout: "" };
        }),
    });

    const error = await Effect.runPromise(
      Effect.flip(backend.install({ ...descriptor, configDir: join(root, "config") })),
    );

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.operation).toBe("write-launchd-plist");
    expect(calls).toEqual([]);
  });

  it("restarts with kickstart -k and falls back through start on failure", async () => {
    const root = temporaryRoot("selftune-launchd-backend-");
    const homeDirectory = join(root, "home");
    const plistPath = join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LOCAL_SERVICE_LABEL}.plist`,
    );
    mkdirSync(join(homeDirectory, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, "installed");
    const target = `gui/501/${LOCAL_SERVICE_LABEL}`;
    const calls: ReadonlyArray<string>[] = [];
    const backend = makeLaunchdBackend({
      homeDirectory,
      uid: 501,
      run: (_command, args) =>
        Effect.sync(() => {
          calls.push(args);
          return args[0] === "kickstart" && args[1] === "-k"
            ? { code: 1, stderr: "not running", stdout: "" }
            : { code: 0, stderr: "", stdout: "" };
        }),
    });

    await Effect.runPromise(backend.restart(descriptor));

    expect(calls).toEqual([
      ["kickstart", "-k", target],
      ["enable", target],
      ["bootstrap", "gui/501", plistPath],
      ["kickstart", target],
    ]);
  });

  it("preserves a typed service failure for unexpected bootstrap errors", async () => {
    const root = temporaryRoot("selftune-launchd-backend-");
    const homeDirectory = join(root, "home");
    const agentsDir = join(homeDirectory, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${LOCAL_SERVICE_LABEL}.plist`), "installed");
    const backend = makeLaunchdBackend({
      homeDirectory,
      uid: 501,
      run: (_command, args) =>
        Effect.succeed(
          args[0] === "bootstrap"
            ? { code: 77, stderr: "Bootstrap permission denied", stdout: "" }
            : { code: 0, stderr: "", stdout: "" },
        ),
    });

    const error = await Effect.runPromise(Effect.flip(backend.start(descriptor)));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error).toMatchObject({
      message: "Bootstrap permission denied",
      operation: "start",
    });
  });

  it("refuses to start before the injected plist path is installed", async () => {
    const root = temporaryRoot("selftune-launchd-backend-");
    const calls: ReadonlyArray<string>[] = [];
    const backend = makeLaunchdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      run: (_command, args) =>
        Effect.sync(() => {
          calls.push(args);
          return { code: 0, stderr: "", stdout: "" };
        }),
    });

    await expect(Effect.runPromise(backend.start(descriptor))).rejects.toThrow(
      "The launchd service is not installed.",
    );
    expect(calls).toEqual([]);
  });
});
