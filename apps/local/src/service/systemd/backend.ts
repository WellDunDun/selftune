import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LOCAL_SERVICE_LABEL } from "../../local-runtime.js";
import {
  serviceFailure,
  ServiceBackendProvider,
  type ServiceBackend,
  type ServiceFailure,
  type ServiceStatus,
} from "../../service-contract.js";
import { serviceEnvironment, serviceProgramArguments } from "../../service-definition.js";
import type { ServiceProcessResult } from "../../service-process.js";
import { replaceServiceDefinitionFile } from "../definition-file.js";
import { prepareServiceDirectories, serviceLogDir } from "../directories.js";
import { makeSystemdManagerLayer, SystemdManagerService } from "./manager.js";

export interface SystemdUnitOptions {
  readonly environment: Record<string, string>;
  readonly execStart: ReadonlyArray<string>;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly workingDirectory: string;
}

export interface SystemdBackendOptions {
  readonly homeDirectory: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    environment?: Record<string, string | undefined>,
  ) => Effect.Effect<ServiceProcessResult, ServiceFailure>;
  readonly uid: number;
  readonly username: string;
  readonly xdgConfigHome?: string;
  readonly xdgRuntimeDir?: string;
}

const SYSTEMD_BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function systemdQuote(value: string): string {
  if (SYSTEMD_BARE_VALUE.test(value)) return value;
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

export function generateSystemdUnit(options: SystemdUnitOptions): string {
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=SelfTune supervised local service
After=default.target

[Service]
Type=simple
ExecStart=${options.execStart.map(systemdQuote).join(" ")}
${environment}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
StandardOutput=${systemdQuote(`append:${options.stdoutPath}`)}
StandardError=${systemdQuote(`append:${options.stderrPath}`)}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
}

function systemdUnitDir(options: {
  readonly homeDirectory: string;
  readonly xdgConfigHome?: string;
}): string {
  const configRoot = options.xdgConfigHome ?? join(options.homeDirectory, ".config");
  return join(configRoot, "systemd", "user");
}

function systemdUnitPathFor(options: {
  readonly homeDirectory: string;
  readonly xdgConfigHome?: string;
}): string {
  return join(systemdUnitDir(options), `${LOCAL_SERVICE_LABEL}.service`);
}

export function systemdUnitPath(): string {
  return systemdUnitPathFor({
    homeDirectory: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
}

function systemdEnvironment(options: Pick<SystemdBackendOptions, "uid" | "xdgRuntimeDir">) {
  return { XDG_RUNTIME_DIR: options.xdgRuntimeDir ?? `/run/user/${options.uid}` };
}

export function systemdLingerArguments(
  enabled: boolean,
  username = userInfo().username,
): ReadonlyArray<string> {
  return [enabled ? "enable-linger" : "disable-linger", username];
}

export function systemdLingerMarkerPath(configDir: string): string {
  return join(configDir, "server-control", "systemd-linger-enabled-by-selftune");
}

export function makeSystemdBackendLayer(options: SystemdBackendOptions) {
  const manager = makeSystemdManagerLayer({
    failure: serviceFailure,
    run: (args) => options.run("systemctl", ["--user", ...args], systemdEnvironment(options)),
    unitName: `${LOCAL_SERVICE_LABEL}.service`,
  });
  return Layer.effect(ServiceBackendProvider)(
    Effect.gen(function* () {
      return makeSystemdBackend(options, yield* SystemdManagerService);
    }),
  ).pipe(Layer.provide(manager));
}

function makeSystemdBackend(
  options: SystemdBackendOptions,
  manager: SystemdManagerService["Service"],
): ServiceBackend {
  const environment = systemdEnvironment(options);
  const unitDir = systemdUnitDir(options);
  const unitPath = systemdUnitPathFor(options);
  const unitName = `${LOCAL_SERVICE_LABEL}.service`;
  const systemctl = (args: ReadonlyArray<string>) =>
    options.run("systemctl", ["--user", ...args], environment);
  const checked = (operation: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* systemctl(args);
      if (result.code !== 0) {
        return yield* Effect.fail(
          serviceFailure(
            operation,
            result.stderr.trim() || result.stdout.trim() || "systemctl failed",
          ),
        );
      }
    });
  return {
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            prepareServiceDirectories(descriptor.configDir);
            mkdirSync(unitDir, { recursive: true, mode: 0o700 });
          },
          catch: (cause) => serviceFailure("write-systemd-unit", cause),
        });
        yield* replaceServiceDefinitionFile({
          contents: generateSystemdUnit({
            environment: serviceEnvironment(descriptor),
            execStart: serviceProgramArguments(descriptor),
            stderrPath: join(serviceLogDir(descriptor.configDir), "daemon.error.log"),
            stdoutPath: join(serviceLogDir(descriptor.configDir), "daemon.log"),
            workingDirectory: descriptor.configDir,
          }),
          operation: "write-systemd-unit",
          path: unitPath,
        });
        yield* checked("daemon-reload", ["daemon-reload"]);
        yield* checked("install", ["enable", "--now", unitName]);
        const linger = yield* options
          .run("loginctl", ["show-user", options.username, "-p", "Linger", "--value"], environment)
          .pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
        if (linger.stdout.trim() !== "yes") {
          yield* options
            .run("loginctl", systemdLingerArguments(true, options.username), environment)
            .pipe(Effect.ignore);
        }
      }),
    platform: "linux",
    restart: (_descriptor) => checked("restart", ["restart", unitName]),
    start: (_descriptor) => checked("start", ["start", unitName]),
    status: (_descriptor) =>
      Effect.gen(function* () {
        const managerState = yield* manager.inspect();
        const linger = yield* options
          .run("loginctl", ["show-user", options.username, "-p", "Linger", "--value"])
          .pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
        const status: ServiceStatus = {
          detail:
            linger.stdout.trim() === "yes"
              ? []
              : ["User lingering is disabled; SelfTune starts after login rather than at boot."],
          pid: managerState.mainPid,
          platform: "linux",
          registered: existsSync(unitPath),
          running: managerState.running,
        };
        return status;
      }),
    stop: (_descriptor) => manager.stop(),
    uninstall: (_descriptor) =>
      Effect.gen(function* () {
        yield* manager.uninstall(existsSync(unitPath));
        yield* Effect.try({
          try: () => rmSync(unitPath, { force: true }),
          catch: (cause) => serviceFailure("remove-systemd-unit", cause),
        });
        yield* checked("daemon-reload", ["daemon-reload"]);
      }),
  };
}
