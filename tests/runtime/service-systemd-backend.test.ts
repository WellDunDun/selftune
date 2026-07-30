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
  generateSystemdUnit,
  ServiceFailure,
  serviceEnvironment,
  serviceFailure,
  serviceProgramArguments,
  systemdLingerArguments,
  systemdLingerMarkerPath,
  systemdUnitPath,
  type ServiceDescriptor,
} from "@selftune/local/service";
import { makeSystemdBackend } from "@selftune/local/service/systemd/backend";

const descriptor: ServiceDescriptor = {
  boot: false,
  configDir: "/home/test/.selftune",
  executableArgsPrefix: [],
  executablePath: "/usr/local/bin/selftune",
  owner: "desktop",
  port: 7888,
  resourceDir: "/opt/selftune",
  version: "0.3.0",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-systemd-backend-"));
  roots.push(root);
  return root;
}

describe("systemd service backend", () => {
  it("generates a crash-restarting user service and stable linger paths", () => {
    const unit = generateSystemdUnit({
      environment: serviceEnvironment(descriptor),
      execStart: serviceProgramArguments(descriptor),
      stderrPath: "/home/test/.selftune/logs/daemon.error.log",
      stdoutPath: "/home/test/.selftune/logs/daemon.log",
      workingDirectory: descriptor.configDir,
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

  it("keeps the ambient unit path compatible", () => {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    expect(systemdUnitPath()).toBe(
      join(configRoot, "systemd", "user", `${LOCAL_SERVICE_LABEL}.service`),
    );
  });

  it("uses injected paths and environment and reports manager status", async () => {
    const root = temporaryRoot();
    const homeDirectory = join(root, "home");
    const configDir = join(root, "state");
    const xdgConfigHome = join(root, "xdg-config");
    const xdgRuntimeDir = join(root, "xdg-runtime");
    const unitName = `${LOCAL_SERVICE_LABEL}.service`;
    const unitPath = join(xdgConfigHome, "systemd", "user", unitName);
    const environment = { XDG_RUNTIME_DIR: xdgRuntimeDir };
    const calls: Array<{
      readonly args: ReadonlyArray<string>;
      readonly command: string;
      readonly environment?: Record<string, string | undefined>;
    }> = [];
    const backend = makeSystemdBackend({
      homeDirectory,
      uid: 501,
      username: "tester",
      xdgConfigHome,
      xdgRuntimeDir,
      run: (command, args, receivedEnvironment) =>
        Effect.sync(() => {
          calls.push({ args, command, environment: receivedEnvironment });
          if (command === "loginctl") return { code: 0, stderr: "", stdout: "yes\n" };
          if (args[1] === "show") {
            return {
              code: 0,
              stderr: "",
              stdout: [
                "LoadState=loaded",
                "ActiveState=active",
                "MainPID=4321",
                "UnitFileState=enabled",
              ].join("\n"),
            };
          }
          return { code: 0, stderr: "", stdout: "" };
        }),
    });
    const installedDescriptor = { ...descriptor, configDir };

    await Effect.runPromise(backend.install(installedDescriptor));

    expect(existsSync(unitPath)).toBe(true);
    if (process.platform !== "win32") expect(statSync(unitPath).mode & 0o077).toBe(0);
    expect(readFileSync(unitPath, "utf8")).toBe(
      generateSystemdUnit({
        environment: serviceEnvironment(installedDescriptor),
        execStart: serviceProgramArguments(installedDescriptor),
        stderrPath: join(configDir, "logs", "daemon.error.log"),
        stdoutPath: join(configDir, "logs", "daemon.log"),
        workingDirectory: configDir,
      }),
    );
    expect(await Effect.runPromise(backend.status(installedDescriptor))).toEqual({
      detail: [],
      pid: 4321,
      platform: "linux",
      registered: true,
      running: true,
    });
    expect(calls).toEqual([
      { args: ["--user", "daemon-reload"], command: "systemctl", environment },
      {
        args: ["--user", "enable", "--now", unitName],
        command: "systemctl",
        environment,
      },
      {
        args: ["show-user", "tester", "-p", "Linger", "--value"],
        command: "loginctl",
        environment,
      },
      {
        args: [
          "--user",
          "show",
          unitName,
          "--property=LoadState",
          "--property=ActiveState",
          "--property=MainPID",
          "--property=UnitFileState",
        ],
        command: "systemctl",
        environment,
      },
      {
        args: ["show-user", "tester", "-p", "Linger", "--value"],
        command: "loginctl",
        environment: undefined,
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "replaces permissive and symlinked unit leaves before systemd activation",
    async () => {
      const root = temporaryRoot();
      const xdgConfigHome = join(root, "xdg-config");
      const unitDir = join(xdgConfigHome, "systemd", "user");
      const unitPath = join(unitDir, `${LOCAL_SERVICE_LABEL}.service`);
      const referent = join(root, "referent.service");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unitPath, "permissive");
      chmodSync(unitPath, 0o666);
      const backend = makeSystemdBackend({
        homeDirectory: join(root, "home"),
        uid: 501,
        username: "tester",
        xdgConfigHome,
        run: (_command, _args) =>
          Effect.sync(() => {
            expect(lstatSync(unitPath).isFile()).toBe(true);
            expect(lstatSync(unitPath).mode & 0o777).toBe(0o600);
            return { code: 0, stderr: "", stdout: "yes\n" };
          }),
      });
      const installedDescriptor = { ...descriptor, configDir: join(root, "state") };

      await Effect.runPromise(backend.install(installedDescriptor));
      expect(lstatSync(unitPath).mode & 0o777).toBe(0o600);

      unlinkSync(unitPath);
      writeFileSync(referent, "referent");
      symlinkSync(referent, unitPath);
      await Effect.runPromise(backend.install(installedDescriptor));

      expect(lstatSync(unitPath).isFile()).toBe(true);
      expect(readFileSync(referent, "utf8")).toBe("referent");
    },
  );

  it("does not invoke systemd commands when unit replacement fails", async () => {
    const root = temporaryRoot();
    const xdgConfigHome = join(root, "xdg-config");
    const unitPath = join(xdgConfigHome, "systemd", "user", `${LOCAL_SERVICE_LABEL}.service`);
    mkdirSync(unitPath, { recursive: true });
    const calls: ReadonlyArray<string>[] = [];
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      xdgConfigHome,
      run: (_command, args) =>
        Effect.sync(() => {
          calls.push(args);
          return { code: 0, stderr: "", stdout: "" };
        }),
    });

    const error = await Effect.runPromise(
      Effect.flip(backend.install({ ...descriptor, configDir: join(root, "state") })),
    );

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.operation).toBe("write-systemd-unit");
    expect(calls).toEqual([]);
  });

  it("enables linger best-effort without creating an ownership marker", async () => {
    const root = temporaryRoot();
    const configDir = join(root, "state");
    const markerPath = systemdLingerMarkerPath(configDir);
    const lingerCalls: ReadonlyArray<string>[] = [];
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      xdgConfigHome: join(root, "xdg-config"),
      xdgRuntimeDir: join(root, "runtime"),
      run: (command, args) =>
        Effect.sync(() => {
          if (command === "loginctl") {
            lingerCalls.push(args);
            return args[0] === "show-user"
              ? { code: 0, stderr: "", stdout: "no\n" }
              : { code: 0, stderr: "", stdout: "" };
          }
          return { code: 0, stderr: "", stdout: "" };
        }),
    });
    const installedDescriptor = { ...descriptor, configDir };

    await Effect.runPromise(backend.install(installedDescriptor));

    expect(existsSync(markerPath)).toBe(false);
    expect(lingerCalls).toEqual([
      ["show-user", "tester", "-p", "Linger", "--value"],
      ["enable-linger", "tester"],
    ]);
  });

  it("succeeds when the best-effort enable-linger command fails", async () => {
    const root = temporaryRoot();
    const configDir = join(root, "state");
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      xdgConfigHome: join(root, "xdg-config"),
      run: (command, args) => {
        if (command === "loginctl" && args[0] === "enable-linger") {
          return Effect.fail(serviceFailure("enable-linger", "permission denied"));
        }
        return Effect.succeed({
          code: 0,
          stderr: "",
          stdout: command === "loginctl" ? "no\n" : "",
        });
      },
    });

    await Effect.runPromise(backend.install({ ...descriptor, configDir }));

    expect(existsSync(systemdLingerMarkerPath(configDir))).toBe(false);
  });

  it("ignores a legacy marker during install and uninstall without disabling linger", async () => {
    const root = temporaryRoot();
    const configDir = join(root, "state");
    const markerPath = systemdLingerMarkerPath(configDir);
    mkdirSync(join(configDir, "server-control"), { recursive: true });
    writeFileSync(markerPath, "enabled\n");
    const loginctlCalls: ReadonlyArray<string>[] = [];
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      xdgConfigHome: join(root, "xdg-config"),
      run: (command, args) =>
        Effect.sync(() => {
          if (command === "loginctl") {
            loginctlCalls.push(args);
            return { code: 0, stderr: "", stdout: "yes\n" };
          }
          if (args[1] === "show") {
            return {
              code: 0,
              stderr: "",
              stdout: "LoadState=loaded\nActiveState=active\nMainPID=4321\nUnitFileState=enabled",
            };
          }
          return { code: 0, stderr: "", stdout: "" };
        }),
    });
    const installedDescriptor = { ...descriptor, configDir };

    await Effect.runPromise(backend.install(installedDescriptor));
    expect(readFileSync(markerPath, "utf8")).toBe("enabled\n");

    await Effect.runPromise(backend.uninstall(installedDescriptor));

    expect(readFileSync(markerPath, "utf8")).toBe("enabled\n");
    expect(loginctlCalls).toEqual([["show-user", "tester", "-p", "Linger", "--value"]]);
  });

  it("ignores a legacy marker during failed uninstall and never disables linger", async () => {
    const root = temporaryRoot();
    const configDir = join(root, "state");
    const markerPath = systemdLingerMarkerPath(configDir);
    mkdirSync(join(configDir, "server-control"), { recursive: true });
    writeFileSync(markerPath, "enabled\n");
    const loginctlCalls: ReadonlyArray<string>[] = [];
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      run: (command) => {
        if (command === "loginctl") {
          loginctlCalls.push(["unexpected"]);
          return Effect.succeed({ code: 0, stderr: "", stdout: "" });
        }
        return Effect.succeed({ code: 1, stderr: "Failed to connect to bus", stdout: "" });
      },
    });

    await expect(
      Effect.runPromise(backend.uninstall({ ...descriptor, configDir })),
    ).rejects.toThrow("Failed to connect to bus");

    expect(readFileSync(markerPath, "utf8")).toBe("enabled\n");
    expect(loginctlCalls).toEqual([]);
  });

  it("keeps status read-only when a legacy marker exists", async () => {
    const root = temporaryRoot();
    const configDir = join(root, "state");
    const markerPath = systemdLingerMarkerPath(configDir);
    mkdirSync(join(configDir, "server-control"), { recursive: true });
    writeFileSync(markerPath, "enabled\n");
    const loginctlCalls: ReadonlyArray<string>[] = [];
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      run: (command, args) =>
        Effect.sync(() => {
          if (command === "loginctl") {
            loginctlCalls.push(args);
            return { code: 0, stderr: "", stdout: "yes\n" };
          }
          return {
            code: 0,
            stderr: "",
            stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0\nUnitFileState=enabled",
          };
        }),
    });

    await Effect.runPromise(backend.status({ ...descriptor, configDir }));

    expect(readFileSync(markerPath, "utf8")).toBe("enabled\n");
    expect(loginctlCalls).toEqual([["show-user", "tester", "-p", "Linger", "--value"]]);
  });

  it("preserves typed systemctl failures", async () => {
    const root = temporaryRoot();
    const backend = makeSystemdBackend({
      homeDirectory: join(root, "home"),
      uid: 501,
      username: "tester",
      run: () => Effect.succeed({ code: 1, stderr: "Access denied", stdout: "" }),
    });

    const error = await Effect.runPromise(Effect.flip(backend.start(descriptor)));

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error).toMatchObject({ message: "Access denied", operation: "start" });
  });
});
