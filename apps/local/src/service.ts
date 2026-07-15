import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DEFAULT_DAEMON_PORT,
  LOCAL_SERVICE_LABEL,
  readSupervisedDaemonManifest,
  resolveLocalConfigDir,
  type RuntimeOwner,
  type ServerManifest,
} from "./local-runtime.js";
import {
  getDaemonStatus,
  manifestMatchesStopExpectation,
  stopDaemon,
  type DaemonFailure,
  type DaemonStatus,
  type RuntimeStopExpectation,
} from "./daemon.js";
import { resolveLoginShellPath } from "@selftune/runtime/login-shell-path";
import { findSelftunePackageRoot } from "@selftune/runtime/package-root";

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

export interface ServiceDescriptor {
  readonly boot: boolean;
  readonly configDir: string;
  readonly executableArgsPrefix: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly owner: RuntimeOwner;
  readonly port: number;
  readonly resourceDir?: string;
  readonly version: string;
}

export interface ServiceStatus {
  readonly detail: ReadonlyArray<string>;
  readonly pid: number | null;
  readonly platform: ServicePlatform;
  readonly registered: boolean;
  readonly running: boolean;
}

export interface ServiceBackend {
  readonly automated: boolean;
  readonly install: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
  readonly platform: ServicePlatform;
  readonly restart: () => Effect.Effect<void, ServiceFailure>;
  readonly start: () => Effect.Effect<void, ServiceFailure>;
  readonly status: () => Effect.Effect<ServiceStatus, ServiceFailure>;
  readonly stop: () => Effect.Effect<void, ServiceFailure>;
  readonly uninstall: (descriptor: ServiceDescriptor) => Effect.Effect<void, ServiceFailure>;
}

export interface LocalRuntimeControl {
  readonly status: (configDir: string) => Effect.Effect<DaemonStatus, DaemonFailure>;
  readonly stop: (
    configDir: string,
    expectation?: RuntimeStopExpectation,
  ) => Effect.Effect<boolean, DaemonFailure>;
}

export class ServiceFailure extends Schema.TaggedErrorClass<ServiceFailure>()("ServiceFailure", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class ServiceManager extends Context.Service<
  ServiceManager,
  { readonly backend: ServiceBackend; readonly runtime: LocalRuntimeControl }
>()("@selftune/cli/ServiceManager") {}

interface CommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ServiceCommandResponse {
  readonly action: "install" | "restart" | "start" | "status" | "stop" | "uninstall";
  readonly ok: true;
  readonly status: ServiceStatus;
}

function serviceFailure(operation: string, cause: unknown): ServiceFailure {
  return ServiceFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const runCommand = Effect.fn("SelfTuneService.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  environment?: Record<string, string | undefined>,
) {
  return yield* Effect.callback<CommandResult, ServiceFailure>((resumeCallback) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          resumeCallback(Effect.fail(serviceFailure(command, `${error.code}: ${error.message}`)));
          return;
        }
        resumeCallback(
          Effect.succeed({
            code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          }),
        );
      },
    );
  });
});

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function serviceProgramArguments(descriptor: ServiceDescriptor): ReadonlyArray<string> {
  return [
    descriptor.executablePath,
    ...descriptor.executableArgsPrefix,
    "daemon",
    "run",
    "--foreground",
    "--supervised",
    "--owner",
    descriptor.owner,
    "--port",
    String(descriptor.port),
    "--hostname",
    "127.0.0.1",
    "--runtime-mode",
    "standalone",
    ...(descriptor.resourceDir ? ["--spa-dir", join(descriptor.resourceDir, "dashboard")] : []),
  ];
}

export function serviceEnvironment(descriptor: ServiceDescriptor): Record<string, string> {
  return {
    PATH: resolveLoginShellPath(),
    SELFTUNE_CONFIG_DIR: descriptor.configDir,
    SELFTUNE_DESKTOP: descriptor.resourceDir ? "1" : "0",
    SELFTUNE_RUNTIME_OWNER: descriptor.owner,
    SELFTUNE_SUPERVISED: "1",
    SELFTUNE_VERSION: descriptor.version,
    SELFTUNE_SERVICE_VERSION: descriptor.version,
    SELFTUNE_BIN_PATH: descriptor.executablePath,
    ...(descriptor.resourceDir ? { SELFTUNE_DESKTOP_RESOURCE_DIR: descriptor.resourceDir } : {}),
  };
}

function logDir(configDir: string): string {
  return join(configDir, "logs");
}

function ensureServiceDirectories(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir(configDir), { recursive: true, mode: 0o700 });
  mkdirSync(join(configDir, "server-control"), { recursive: true, mode: 0o700 });
}

export interface LaunchdPlistOptions {
  readonly environment: Record<string, string>;
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly workingDirectory: string;
}

function enclosingAppBundlePath(executablePath: string): string | null {
  const appContentsMarker = ".app/Contents/";
  const markerIndex = executablePath.replaceAll("\\", "/").lastIndexOf(appContentsMarker);
  return markerIndex < 0 ? null : executablePath.slice(0, markerIndex + ".app".length);
}

function associatedBundleIdentifier(programArguments: ReadonlyArray<string>): string | null {
  const executablePath = programArguments[0];
  if (!executablePath) return null;
  const appBundlePath = enclosingAppBundlePath(executablePath);
  if (!appBundlePath) return null;
  try {
    const plist = readFileSync(join(appBundlePath, "Contents", "Info.plist"), "utf8");
    const match = plist.match(/<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/);
    const identifier = match ? xmlUnescape(match[1].trim()) : "";
    return identifier.length > 0 ? identifier : null;
  } catch {
    return null;
  }
}

export function generateLaunchdPlist(options: LaunchdPlistOptions): string {
  const argumentsXml = options.programArguments
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(options.environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const bundleIdentifier = associatedBundleIdentifier(options.programArguments);
  const associatedBundleIdentifiers = bundleIdentifier
    ? `  <key>AssociatedBundleIdentifiers</key>\n  <array><string>${xmlEscape(bundleIdentifier)}</string></array>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
${associatedBundleIdentifiers}  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function parseLaunchctlPid(output: string): number | null {
  const match = output.match(/\bpid\s*=\s*(\d+)/);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function launchdPlistPath(): string {
  return join(launchAgentsDir(), `${LOCAL_SERVICE_LABEL}.plist`);
}

function launchdTarget(): string {
  return `gui/${currentUid()}/${LOCAL_SERVICE_LABEL}`;
}

function launchdServiceMissing(result: CommandResult): boolean {
  return /could not find service|no such process|service not found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function makeLaunchdBackend(): ServiceBackend {
  const checked = (operation: string, result: CommandResult) =>
    result.code === 0
      ? Effect.void
      : Effect.fail(
          serviceFailure(
            operation,
            result.stderr.trim() || result.stdout.trim() || "launchctl failed",
          ),
        );
  const start = Effect.fn("SelfTuneService.launchd.start")(function* () {
    const plistPath = launchdPlistPath();
    if (!existsSync(plistPath)) {
      return yield* Effect.fail(serviceFailure("start", "The launchd service is not installed."));
    }
    yield* checked("enable", yield* runCommand("launchctl", ["enable", launchdTarget()]));
    const result = yield* runCommand("launchctl", ["bootstrap", `gui/${currentUid()}`, plistPath]);
    if (
      result.code !== 0 &&
      !/already (?:loaded|bootstrapped)|service already loaded/i.test(result.stderr)
    ) {
      return yield* Effect.fail(
        serviceFailure("start", result.stderr.trim() || result.stdout.trim() || "launchctl failed"),
      );
    }
    yield* checked("kickstart", yield* runCommand("launchctl", ["kickstart", launchdTarget()]));
  });

  const stop = Effect.fn("SelfTuneService.launchd.stop")(function* () {
    const result = yield* runCommand("launchctl", ["bootout", launchdTarget()]);
    if (result.code !== 0 && !launchdServiceMissing(result)) {
      return yield* checked("stop", result);
    }
  });

  return {
    platform: "darwin",
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            ensureServiceDirectories(descriptor.configDir);
            mkdirSync(launchAgentsDir(), { recursive: true, mode: 0o700 });
            writeFileSync(
              launchdPlistPath(),
              generateLaunchdPlist({
                label: LOCAL_SERVICE_LABEL,
                programArguments: serviceProgramArguments(descriptor),
                environment: serviceEnvironment(descriptor),
                workingDirectory: descriptor.configDir,
                stdoutPath: join(logDir(descriptor.configDir), "daemon.log"),
                stderrPath: join(logDir(descriptor.configDir), "daemon.error.log"),
              }),
              { mode: 0o600 },
            );
          },
          catch: (cause) => serviceFailure("write-launchd-plist", cause),
        });
        yield* stop();
        yield* start();
      }),
    uninstall: () =>
      Effect.gen(function* () {
        yield* stop();
        const disabled = yield* runCommand("launchctl", ["disable", launchdTarget()]);
        if (disabled.code !== 0 && !launchdServiceMissing(disabled)) {
          yield* checked("disable", disabled);
        }
        yield* Effect.try({
          try: () => rmSync(launchdPlistPath(), { force: true }),
          catch: (cause) => serviceFailure("remove-launchd-plist", cause),
        });
      }),
    status: () =>
      Effect.gen(function* () {
        const registered = existsSync(launchdPlistPath());
        const result = yield* runCommand("launchctl", ["print", launchdTarget()]);
        const status: ServiceStatus = {
          platform: "darwin",
          registered,
          running: result.code === 0,
          pid: result.code === 0 ? parseLaunchctlPid(result.stdout) : null,
          detail: registered ? [] : ["The launchd service is not installed."],
        };
        return status;
      }),
    start,
    stop,
    restart: () =>
      Effect.gen(function* () {
        const result = yield* runCommand("launchctl", ["kickstart", "-k", launchdTarget()]);
        if (result.code !== 0) {
          yield* start();
        }
      }),
  };
}

export interface SystemdUnitOptions {
  readonly environment: Record<string, string>;
  readonly execStart: ReadonlyArray<string>;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly workingDirectory: string;
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

function systemdUnitDir(): string {
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configRoot, "systemd", "user");
}

export function systemdUnitPath(): string {
  return join(systemdUnitDir(), `${LOCAL_SERVICE_LABEL}.service`);
}

function systemdEnvironment(): Record<string, string> {
  return { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${currentUid()}` };
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

function makeSystemdBackend(): ServiceBackend {
  const unitName = `${LOCAL_SERVICE_LABEL}.service`;
  const systemctl = (args: ReadonlyArray<string>) =>
    runCommand("systemctl", ["--user", ...args], systemdEnvironment());
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
    platform: "linux",
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            ensureServiceDirectories(descriptor.configDir);
            mkdirSync(systemdUnitDir(), { recursive: true, mode: 0o700 });
            writeFileSync(
              systemdUnitPath(),
              generateSystemdUnit({
                execStart: serviceProgramArguments(descriptor),
                environment: serviceEnvironment(descriptor),
                workingDirectory: descriptor.configDir,
                stdoutPath: join(logDir(descriptor.configDir), "daemon.log"),
                stderrPath: join(logDir(descriptor.configDir), "daemon.error.log"),
              }),
              { mode: 0o600 },
            );
          },
          catch: (cause) => serviceFailure("write-systemd-unit", cause),
        });
        yield* checked("daemon-reload", ["daemon-reload"]);
        yield* checked("install", ["enable", "--now", unitName]);
        const linger = yield* runCommand(
          "loginctl",
          ["show-user", userInfo().username, "-p", "Linger", "--value"],
          systemdEnvironment(),
        ).pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
        if (linger.stdout.trim() !== "yes") {
          const enabled = yield* runCommand(
            "loginctl",
            systemdLingerArguments(true),
            systemdEnvironment(),
          ).pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
          if (enabled.code === 0) {
            yield* Effect.try({
              try: () =>
                writeFileSync(systemdLingerMarkerPath(descriptor.configDir), "enabled\n", {
                  mode: 0o600,
                }),
              catch: (cause) => serviceFailure("record-systemd-linger", cause),
            });
          }
        }
      }),
    uninstall: (descriptor) =>
      Effect.gen(function* () {
        if (existsSync(systemdUnitPath())) {
          yield* checked("uninstall", ["disable", "--now", unitName]);
        }
        yield* Effect.try({
          try: () => rmSync(systemdUnitPath(), { force: true }),
          catch: (cause) => serviceFailure("remove-systemd-unit", cause),
        });
        yield* checked("daemon-reload", ["daemon-reload"]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const markerPath = systemdLingerMarkerPath(descriptor.configDir);
            if (!existsSync(markerPath)) return;
            const disabled = yield* runCommand(
              "loginctl",
              systemdLingerArguments(false),
              systemdEnvironment(),
            );
            if (disabled.code === 0) rmSync(markerPath, { force: true });
          }).pipe(Effect.ignore),
        ),
      ),
    status: () =>
      Effect.gen(function* () {
        const active = yield* systemctl(["is-active", unitName]);
        const linger = yield* runCommand("loginctl", [
          "show-user",
          userInfo().username,
          "-p",
          "Linger",
          "--value",
        ]).pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
        const status: ServiceStatus = {
          platform: "linux",
          registered: existsSync(systemdUnitPath()),
          running: active.stdout.trim() === "active",
          pid: null,
          detail:
            linger.stdout.trim() === "yes"
              ? []
              : ["User lingering is disabled; SelfTune starts after login rather than at boot."],
        };
        return status;
      }),
    start: () => checked("start", ["start", unitName]),
    stop: () => checked("stop", ["stop", unitName]),
    restart: () => checked("restart", ["restart", unitName]),
  };
}

export const WINDOWS_TASK_NAME = "SelfTuneDaemon";

function cmdSetValue(value: string): string {
  return value.replaceAll('"', "").replaceAll("%", "%%");
}

export function generateWindowsDaemonWrapper(descriptor: ServiceDescriptor): string {
  const environmentLines = Object.entries(serviceEnvironment(descriptor)).map(
    ([key, value]) => `set "${key}=${cmdSetValue(value)}"`,
  );
  const [executable, ...args] = serviceProgramArguments(descriptor);
  const command = `"${executable}" ${args.map((value) => `"${value.replaceAll('"', "")}"`).join(" ")} 1>> "${join(logDir(descriptor.configDir), "daemon.log")}" 2>> "${join(logDir(descriptor.configDir), "daemon.error.log")}"`;
  return ["@echo off", ...environmentLines, command, ""].join("\r\n");
}

export function generateWindowsHiddenLauncher(wrapperPath: string): string {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `rc = sh.Run("""${wrapperPath}""", 0, True)`,
    "WScript.Quit rc",
    "",
  ].join("\r\n");
}

export function generateWindowsTaskXml(options: {
  readonly boot: boolean;
  readonly launcherPath: string;
  readonly userId: string;
}): string {
  const userId = xmlEscape(options.userId);
  const trigger = options.boot
    ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>"
    : `<LogonTrigger><Enabled>true</Enabled><UserId>${userId}</UserId></LogonTrigger>`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>SelfTune supervised local service</Description></RegistrationInfo>",
    `  <Triggers>${trigger}</Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${userId}</UserId><LogonType>${options.boot ? "S4U" : "InteractiveToken"}</LogonType><RunLevel>${options.boot ? "HighestAvailable" : "LeastPrivilege"}</RunLevel></Principal></Principals>`,
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>",
    `  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>&quot;${xmlEscape(options.launcherPath)}&quot;</Arguments></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
}

function windowsControlPath(configDir: string, filename: string): string {
  return join(configDir, "server-control", filename);
}

function windowsUserId(): string {
  const username = userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
}

function runSchtasks(args: ReadonlyArray<string>): Effect.Effect<CommandResult, ServiceFailure> {
  return runCommand("schtasks.exe", args);
}

function makeWindowsBackend(): ServiceBackend {
  const checked = (operation: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* runSchtasks(args);
      if (result.code !== 0) {
        return yield* Effect.fail(
          serviceFailure(
            operation,
            result.stderr.trim() || result.stdout.trim() || "schtasks failed",
          ),
        );
      }
    });
  return {
    platform: "win32",
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        const wrapperPath = windowsControlPath(descriptor.configDir, "run-daemon.cmd");
        const launcherPath = windowsControlPath(descriptor.configDir, "run-daemon.vbs");
        const taskPath = windowsControlPath(descriptor.configDir, "run-daemon.xml");
        yield* Effect.try({
          try: () => {
            ensureServiceDirectories(descriptor.configDir);
            writeFileSync(wrapperPath, generateWindowsDaemonWrapper(descriptor));
            writeFileSync(launcherPath, generateWindowsHiddenLauncher(wrapperPath));
            const taskXml = generateWindowsTaskXml({
              boot: descriptor.boot,
              launcherPath,
              userId: windowsUserId(),
            });
            writeFileSync(taskPath, Buffer.from(`\ufeff${taskXml}`, "utf16le"));
          },
          catch: (cause) => serviceFailure("write-windows-task", cause),
        });
        yield* checked("install", ["/create", "/tn", WINDOWS_TASK_NAME, "/xml", taskPath, "/f"]);
        yield* checked("start", ["/run", "/tn", WINDOWS_TASK_NAME]);
      }),
    uninstall: (descriptor) =>
      Effect.gen(function* () {
        const status = yield* runSchtasks(["/query", "/tn", WINDOWS_TASK_NAME]);
        if (status.code === 0) {
          yield* runSchtasks(["/end", "/tn", WINDOWS_TASK_NAME]);
          yield* checked("uninstall", ["/delete", "/tn", WINDOWS_TASK_NAME, "/f"]);
        } else if (!/cannot find|does not exist/i.test(`${status.stderr}\n${status.stdout}`)) {
          return yield* Effect.fail(
            serviceFailure("uninstall", status.stderr.trim() || status.stdout.trim()),
          );
        }
        const configDir = descriptor.configDir;
        yield* Effect.sync(() => {
          rmSync(windowsControlPath(configDir, "run-daemon.cmd"), { force: true });
          rmSync(windowsControlPath(configDir, "run-daemon.vbs"), { force: true });
          rmSync(windowsControlPath(configDir, "run-daemon.xml"), { force: true });
        });
      }),
    status: () =>
      Effect.gen(function* () {
        const result = yield* runSchtasks([
          "/query",
          "/tn",
          WINDOWS_TASK_NAME,
          "/fo",
          "LIST",
          "/v",
        ]);
        const registered = result.code === 0;
        const running = registered && /(?:267009|0x00041301)/i.test(result.stdout);
        const status: ServiceStatus = {
          platform: "win32",
          registered,
          running,
          pid: null,
          detail: registered ? [] : ["The SelfTune scheduled task is not installed."],
        };
        return status;
      }),
    start: () => checked("start", ["/run", "/tn", WINDOWS_TASK_NAME]),
    stop: () =>
      Effect.gen(function* () {
        const result = yield* runSchtasks(["/end", "/tn", WINDOWS_TASK_NAME]);
        if (
          result.code !== 0 &&
          !/not running|cannot find/i.test(`${result.stderr}\n${result.stdout}`)
        ) {
          return yield* Effect.fail(
            serviceFailure("stop", result.stderr.trim() || result.stdout.trim()),
          );
        }
      }),
    restart: () =>
      Effect.gen(function* () {
        yield* runSchtasks(["/end", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.ignore);
        yield* checked("restart", ["/run", "/tn", WINDOWS_TASK_NAME]);
      }),
  };
}

function makeUnsupportedBackend(platform: NodeJS.Platform): ServiceBackend {
  const unsupported = (operation: string) =>
    Effect.fail(
      serviceFailure(operation, `OS service management is not supported on ${platform}.`),
    );
  return {
    platform: "unsupported",
    automated: false,
    install: () => unsupported("install"),
    uninstall: () => unsupported("uninstall"),
    status: () =>
      Effect.succeed({
        platform: "unsupported",
        registered: false,
        running: false,
        pid: null,
        detail: [`OS service management is not supported on ${platform}.`],
      }),
    start: () => unsupported("start"),
    stop: () => unsupported("stop"),
    restart: () => unsupported("restart"),
  };
}

export function getServiceBackend(platform: NodeJS.Platform = process.platform): ServiceBackend {
  switch (platform) {
    case "darwin":
      return makeLaunchdBackend();
    case "linux":
      return makeSystemdBackend();
    case "win32":
      return makeWindowsBackend();
    default:
      return makeUnsupportedBackend(platform);
  }
}

export const ServiceManagerLive = Layer.succeed(ServiceManager)({
  backend: getServiceBackend(),
  runtime: {
    status: getDaemonStatus,
    stop: stopDaemon,
  },
});

function argumentValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DAEMON_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw serviceFailure("parse", `Invalid service port: ${value}`);
  }
  return parsed;
}

function parseRuntimeOwner(value: string | undefined): RuntimeOwner {
  if (value === "desktop" || value === "cli") return value;
  if (value !== undefined) throw serviceFailure("parse", `Invalid service owner: ${value}`);
  return process.env.SELFTUNE_DESKTOP === "1" ? "desktop" : "cli";
}

function isCompiledBunEntrypoint(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/$bunfs/") || /^[a-z]:\/~BUN\//i.test(normalized);
}

function resolveCliInvocation(args: ReadonlyArray<string>): {
  readonly executableArgsPrefix: ReadonlyArray<string>;
  readonly executablePath: string;
} {
  const explicit = argumentValue(args, "--executable");
  if (explicit) return { executablePath: resolve(explicit), executableArgsPrefix: [] };
  const configured = process.env.SELFTUNE_BIN_PATH?.trim();
  if (configured) return { executablePath: resolve(configured), executableArgsPrefix: [] };
  if (isCompiledBunEntrypoint(process.argv[1])) {
    return { executablePath: process.execPath, executableArgsPrefix: [] };
  }
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw serviceFailure("install", "Cannot resolve the SelfTune CLI entrypoint.");
  }
  return { executablePath: process.execPath, executableArgsPrefix: [resolve(scriptPath)] };
}

function installedVersion(): string {
  const environmentVersion = process.env.SELFTUNE_VERSION;
  if (environmentVersion) return environmentVersion;
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(findSelftunePackageRoot(), "package.json"), "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      typeof value.version === "string"
    ) {
      return value.version;
    }
  } catch {
    // A compiled desktop binary supplies its version through the environment.
  }
  return "unknown";
}

function serviceDescriptor(args: ReadonlyArray<string>): ServiceDescriptor {
  const invocation = resolveCliInvocation(args);
  const resourceDir = argumentValue(args, "--resource-dir");
  return {
    ...invocation,
    boot: args.includes("--boot"),
    configDir: argumentValue(args, "--config-dir") ?? resolveLocalConfigDir(),
    owner: parseRuntimeOwner(argumentValue(args, "--owner")),
    port: parsePort(argumentValue(args, "--port")),
    version: argumentValue(args, "--version") ?? installedVersion(),
    ...(resourceDir ? { resourceDir: resolve(resourceDir) } : {}),
  };
}

function withManifestDetail(status: ServiceStatus, configDir: string): ServiceStatus {
  const manifest = readSupervisedDaemonManifest(configDir);
  if (!manifest) return status;
  return {
    ...status,
    detail: [
      ...status.detail,
      `Serving ${manifest.origin} (pid ${manifest.pid}, SelfTune ${manifest.owner_version}, ${manifest.owner}-owned).`,
    ],
  };
}

function serviceRuntimeExpectation(status: DaemonStatus): RuntimeStopExpectation | null {
  const manifest = status.manifest;
  return manifest?.supervision === "os-service"
    ? { instanceId: manifest.instance_id, pid: manifest.pid }
    : null;
}

export function serviceRuntimeIsReady(
  status: ServiceStatus,
  daemon: DaemonStatus,
  installedDescriptor?: ServiceDescriptor,
): boolean {
  const manifest = daemon.manifest;
  return (
    status.running &&
    daemon.reachable &&
    manifest?.supervision === "os-service" &&
    (status.pid === null || status.pid === manifest.pid) &&
    (installedDescriptor === undefined ||
      (manifest.owner === installedDescriptor.owner &&
        manifest.port === installedDescriptor.port &&
        manifest.owner_version === installedDescriptor.version))
  );
}

export function expectedRuntimeIsPresent(
  manifest: ServerManifest | null,
  expectation: RuntimeStopExpectation | null,
): boolean {
  return expectation !== null && manifest !== null
    ? manifestMatchesStopExpectation(manifest, expectation)
    : false;
}

export const runServiceCommand = Effect.fn("SelfTuneService.command")(function* (
  action: ServiceCommandResponse["action"],
  descriptor: ServiceDescriptor,
) {
  const manager = yield* ServiceManager;
  const backend = manager.backend;
  const stopOwnedRuntime = (operation: string, expectation?: RuntimeStopExpectation) =>
    manager.runtime
      .stop(descriptor.configDir, expectation)
      .pipe(Effect.mapError((cause) => serviceFailure(operation, cause)));
  const expectsStopped = action === "stop" || action === "uninstall";
  const runtimeBeforeAction = expectsStopped
    ? yield* manager.runtime
        .status(descriptor.configDir)
        .pipe(Effect.mapError((cause) => serviceFailure(`${action}-runtime-status`, cause)))
    : null;
  const serviceRuntimeBeforeAction = runtimeBeforeAction
    ? serviceRuntimeExpectation(runtimeBeforeAction)
    : null;
  switch (action) {
    case "install":
      yield* stopOwnedRuntime("install-takeover");
      yield* backend.install(descriptor);
      break;
    case "uninstall":
      yield* backend.uninstall(descriptor);
      if (backend.platform === "win32" && serviceRuntimeBeforeAction) {
        yield* stopOwnedRuntime("uninstall-runtime", serviceRuntimeBeforeAction);
      }
      break;
    case "start":
      yield* backend.start();
      break;
    case "stop":
      yield* backend.stop();
      if (backend.platform === "win32" && serviceRuntimeBeforeAction) {
        yield* stopOwnedRuntime("stop-runtime", serviceRuntimeBeforeAction);
      }
      break;
    case "restart":
      yield* backend.restart();
      break;
    case "status":
      break;
  }
  const expectsRunning = action === "install" || action === "restart" || action === "start";
  let status = yield* backend.status();
  if (expectsRunning || expectsStopped) {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      status = yield* backend.status();
      const daemon = yield* manager.runtime
        .status(descriptor.configDir)
        .pipe(Effect.catch(() => Effect.succeed({ manifest: null, reachable: false })));
      ready = expectsRunning
        ? serviceRuntimeIsReady(status, daemon, action === "install" ? descriptor : undefined)
        : !status.running &&
          !expectedRuntimeIsPresent(daemon.manifest, serviceRuntimeBeforeAction) &&
          (action !== "uninstall" || !status.registered);
      if (ready) break;
      yield* Effect.sleep(250);
    }
    if (!ready) {
      return yield* Effect.fail(
        serviceFailure(
          action,
          expectsRunning
            ? "The service did not become healthy within 20 seconds."
            : "The service did not stop cleanly within 20 seconds.",
        ),
      );
    }
  }
  return {
    ok: true,
    action,
    status: withManifestDetail(status, descriptor.configDir),
  } satisfies ServiceCommandResponse;
});

function serviceHelp(): string {
  return `selftune service - Manage the supervised SelfTune daemon

Usage:
  selftune service install [options]
  selftune service status [--json]
  selftune service start [--json]
  selftune service stop [--json]
  selftune service restart [--json]
  selftune service uninstall [--json]

Options:
  --port <port>          Service port (default: ${DEFAULT_DAEMON_PORT})
  --config-dir <path>   SelfTune state directory
  --owner <owner>       Service owner: desktop or cli
  --boot                Windows only: start before login (requires elevation)
  --json                Emit a machine-readable response`;
}

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    console.log(serviceHelp());
    return;
  }
  if (
    action !== "install" &&
    action !== "uninstall" &&
    action !== "status" &&
    action !== "start" &&
    action !== "stop" &&
    action !== "restart"
  ) {
    throw serviceFailure("parse", `Unknown service command: ${action}`);
  }
  const descriptor = serviceDescriptor(args.slice(1));
  const response = await Effect.runPromise(
    runServiceCommand(action, descriptor).pipe(Effect.provide(ServiceManagerLive)),
  );
  if (args.includes("--json")) {
    console.log(JSON.stringify(response));
    return;
  }
  console.log(`SelfTune service ${action} completed on ${response.status.platform}.`);
  console.log(`Registered: ${response.status.registered ? "yes" : "no"}`);
  console.log(
    `Running: ${response.status.running ? "yes" : "no"}${response.status.pid ? ` (pid ${response.status.pid})` : ""}`,
  );
  for (const line of response.status.detail) console.log(line);
}

if (import.meta.main) {
  await cliMain();
}
