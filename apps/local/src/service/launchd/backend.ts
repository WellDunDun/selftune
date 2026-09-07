import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LOCAL_SERVICE_LABEL } from "../../local-runtime.js";
import {
  serviceFailure,
  ServiceBackendProvider,
  type ServiceBackend,
  type ServiceDescriptor,
  type ServiceFailure,
  type ServiceStatus,
} from "../../service-contract.js";
import { serviceEnvironment, serviceProgramArguments } from "../../service-definition.js";
import type { ServiceProcessResult } from "../../service-process.js";
import { replaceServiceDefinitionFile } from "../definition-file.js";
import { prepareServiceDirectories, serviceLogDir } from "../directories.js";

export interface LaunchdPlistOptions {
  readonly environment: Record<string, string>;
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly stderrPath: string;
  readonly stdoutPath: string;
  readonly workingDirectory: string;
}

export interface LaunchdBackendOptions {
  readonly homeDirectory: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ServiceProcessResult, ServiceFailure>;
  readonly uid: number;
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

function launchAgentsDir(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents");
}

function launchdPlistPathFor(homeDirectory: string): string {
  return join(launchAgentsDir(homeDirectory), `${LOCAL_SERVICE_LABEL}.plist`);
}

export function launchdPlistPath(): string {
  return launchdPlistPathFor(homedir());
}

function launchdTarget(uid: number): string {
  return `gui/${uid}/${LOCAL_SERVICE_LABEL}`;
}

function launchdServiceMissing(result: ServiceProcessResult): boolean {
  return /could not find service|no such process|service not found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

export function makeLaunchdBackendLayer(options: LaunchdBackendOptions) {
  return Layer.sync(ServiceBackendProvider)(() => makeLaunchdBackend(options));
}

export function makeLaunchdBackend(options: LaunchdBackendOptions): ServiceBackend {
  const agentsDir = launchAgentsDir(options.homeDirectory);
  const plistPath = launchdPlistPathFor(options.homeDirectory);
  const target = launchdTarget(options.uid);
  const checked = (operation: string, result: ServiceProcessResult) =>
    result.code === 0
      ? Effect.void
      : Effect.fail(
          serviceFailure(
            operation,
            result.stderr.trim() || result.stdout.trim() || "launchctl failed",
          ),
        );
  const start = Effect.fn("SelfTuneService.launchd.start")(function* (
    _descriptor: ServiceDescriptor,
  ) {
    if (!existsSync(plistPath)) {
      return yield* Effect.fail(serviceFailure("start", "The launchd service is not installed."));
    }
    yield* checked("enable", yield* options.run("launchctl", ["enable", target]));
    const result = yield* options.run("launchctl", ["bootstrap", `gui/${options.uid}`, plistPath]);
    if (
      result.code !== 0 &&
      !/already (?:loaded|bootstrapped)|service already loaded/i.test(result.stderr)
    ) {
      return yield* Effect.fail(
        serviceFailure("start", result.stderr.trim() || result.stdout.trim() || "launchctl failed"),
      );
    }
    yield* checked("kickstart", yield* options.run("launchctl", ["kickstart", target]));
  });

  const stop = Effect.fn("SelfTuneService.launchd.stop")(function* (
    _descriptor: ServiceDescriptor,
  ) {
    const result = yield* options.run("launchctl", ["bootout", target]);
    if (result.code !== 0 && !launchdServiceMissing(result)) {
      return yield* checked("stop", result);
    }
  });

  return {
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            prepareServiceDirectories(descriptor.configDir);
            mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
          },
          catch: (cause) => serviceFailure("write-launchd-plist", cause),
        });
        yield* replaceServiceDefinitionFile({
          contents: generateLaunchdPlist({
            environment: serviceEnvironment(descriptor),
            label: LOCAL_SERVICE_LABEL,
            programArguments: serviceProgramArguments(descriptor),
            stderrPath: join(serviceLogDir(descriptor.configDir), "daemon.error.log"),
            stdoutPath: join(serviceLogDir(descriptor.configDir), "daemon.log"),
            workingDirectory: descriptor.configDir,
          }),
          operation: "write-launchd-plist",
          path: plistPath,
        });
        yield* stop(descriptor);
        yield* start(descriptor);
      }),
    platform: "darwin",
    restart: (descriptor) =>
      Effect.gen(function* () {
        const result = yield* options.run("launchctl", ["kickstart", "-k", target]);
        if (result.code !== 0) {
          yield* start(descriptor);
        }
      }),
    start,
    status: (_descriptor) =>
      Effect.gen(function* () {
        const registered = existsSync(plistPath);
        const result = yield* options.run("launchctl", ["print", target]);
        const status: ServiceStatus = {
          detail: registered ? [] : ["The launchd service is not installed."],
          pid: result.code === 0 ? parseLaunchctlPid(result.stdout) : null,
          platform: "darwin",
          registered,
          running: result.code === 0,
        };
        return status;
      }),
    stop,
    uninstall: (descriptor) =>
      Effect.gen(function* () {
        yield* stop(descriptor);
        const disabled = yield* options.run("launchctl", ["disable", target]);
        if (disabled.code !== 0 && !launchdServiceMissing(disabled)) {
          yield* checked("disable", disabled);
        }
        yield* Effect.try({
          try: () => rmSync(plistPath, { force: true }),
          catch: (cause) => serviceFailure("remove-launchd-plist", cause),
        });
      }),
  };
}
