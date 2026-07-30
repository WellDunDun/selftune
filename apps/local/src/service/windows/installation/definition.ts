import { join, win32 } from "node:path";

import { serviceEnvironment, serviceProgramArguments } from "../../../service-definition.js";
import type { ServiceDescriptor } from "../../../service-contract.js";

export const WINDOWS_TASK_NAME = "SelfTuneDaemon";

export interface WindowsLegacyUserIdentity {
  readonly domain?: string;
  readonly username: string;
}

function logDir(configDir: string): string {
  return join(configDir, "logs");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cmdEscapedValue(value: string, context: string): string {
  if (value.includes('"') || value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    throw new Error(
      `Windows service ${context} cannot contain double quotes, line breaks, or NUL bytes.`,
    );
  }
  return value.replaceAll("%", "%%");
}

function cmdSetValue(value: string, key: string): string {
  return cmdEscapedValue(value, `environment variable ${key}`);
}

function cmdQuotedArgument(value: string, context: string): string {
  const escaped = cmdEscapedValue(value, context);
  const trailingBackslashes = escaped.match(/\\+$/)?.[0] ?? "";
  const body = escaped.slice(0, escaped.length - trailingBackslashes.length);
  return `"${body}${trailingBackslashes}${trailingBackslashes}"`;
}

export function generateWindowsDaemonWrapper(
  descriptor: ServiceDescriptor,
  installationNonce?: string,
): string {
  const environment = serviceEnvironment(descriptor);
  const environmentLines = Object.entries(environment).map(
    ([key, value]) => `set "${key}=${cmdSetValue(value, key)}"`,
  );
  const [executable, ...args] = serviceProgramArguments(descriptor, { installationNonce });
  const stdoutPath = join(logDir(descriptor.configDir), "daemon.log");
  const stderrPath = join(logDir(descriptor.configDir), "daemon.error.log");
  const command = `${cmdQuotedArgument(executable, "executable path")} ${args.map((value, index) => cmdQuotedArgument(value, `argument ${index + 1}`)).join(" ")} 1>> ${cmdQuotedArgument(stdoutPath, "stdout path")} 2>> ${cmdQuotedArgument(stderrPath, "stderr path")}`;
  const values = [...Object.values(environment), executable, ...args, stdoutPath, stderrPath];
  const disableDelayedExpansion = values.some((value) => value.includes("!"))
    ? ["setlocal DisableDelayedExpansion"]
    : [];
  return ["@echo off", ...disableDelayedExpansion, ...environmentLines, command, ""].join("\r\n");
}

export function generateWindowsHiddenLauncher(wrapperPath: string): string {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `rc = sh.Run("""${wrapperPath}""", 0, True)`,
    "WScript.Quit rc",
    "",
  ].join("\r\n");
}

function legacyCmdSetValue(value: string): string {
  return value.replaceAll('"', "").replaceAll("%", "%%");
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemver {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: ReadonlyArray<string>;
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return null;
  }
  return { core: [BigInt(major), BigInt(minor), BigInt(patch)], prerelease };
}

function comparePrerelease(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function semverAtMost(observed: string, desired: string): boolean {
  const left = parseSemver(observed);
  const right = parseSemver(desired);
  if (left === null || right === null) return false;
  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index];
    const rightPart = right.core[index];
    if (leftPart === undefined || rightPart === undefined) return false;
    if (leftPart !== rightPart) return leftPart < rightPart;
  }
  return comparePrerelease(left.prerelease, right.prerelease) <= 0;
}

function serializedLegacyPathIsValid(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('"') ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    return false;
  }
  return [...value.matchAll(/%+/g)].every((match) => match[0].length % 2 === 0);
}

function legacySetValue(line: string, key: string): string | null {
  const prefix = `set "${key}=`;
  return line.startsWith(prefix) && line.endsWith('"')
    ? line.slice(prefix.length, line.length - 1)
    : null;
}

export function generateLegacyWindowsDaemonWrapper(descriptor: ServiceDescriptor): string {
  const environmentLines = Object.entries(serviceEnvironment(descriptor)).map(
    ([key, value]) => `set "${key}=${legacyCmdSetValue(value)}"`,
  );
  const [executable, ...args] = serviceProgramArguments(descriptor);
  const command = `"${executable}" ${args.map((value) => `"${value.replaceAll('"', "")}"`).join(" ")} 1>> "${win32.join(logDir(descriptor.configDir), "daemon.log")}" 2>> "${win32.join(logDir(descriptor.configDir), "daemon.error.log")}"`;
  return ["@echo off", ...environmentLines, command, ""].join("\r\n");
}

export function matchesLegacyWindowsDaemonWrapper(
  wrapper: string,
  descriptor: ServiceDescriptor,
): boolean {
  const actualLines = wrapper.split("\r\n");
  if (actualLines.join("\r\n") !== wrapper) return false;
  const currentLines = generateLegacyWindowsDaemonWrapper(descriptor).split("\r\n");
  if (actualLines.length !== currentLines.length) return false;

  const lineFor = (key: string) => {
    const matches = actualLines.filter((line) => legacySetValue(line, key) !== null);
    return matches.length === 1 ? matches[0] : null;
  };
  const pathLine = lineFor("PATH");
  const versionLine = lineFor("SELFTUNE_VERSION");
  const serviceVersionLine = lineFor("SELFTUNE_SERVICE_VERSION");
  if (pathLine === null || versionLine === null || serviceVersionLine === null) return false;
  const path = legacySetValue(pathLine, "PATH");
  const version = legacySetValue(versionLine, "SELFTUNE_VERSION");
  const serviceVersion = legacySetValue(serviceVersionLine, "SELFTUNE_SERVICE_VERSION");
  if (
    path === null ||
    !serializedLegacyPathIsValid(path) ||
    version === null ||
    serviceVersion !== version ||
    !semverAtMost(version, descriptor.version)
  ) {
    return false;
  }

  const observedLines = new Map([
    ["PATH", pathLine],
    ["SELFTUNE_VERSION", versionLine],
    ["SELFTUNE_SERVICE_VERSION", serviceVersionLine],
  ]);
  const reconstructed = currentLines.map((line) => {
    for (const [key, observed] of observedLines) {
      if (legacySetValue(line, key) !== null) return observed;
    }
    return line;
  });
  return reconstructed.join("\r\n") === wrapper;
}

export function generateLegacyWindowsTaskXml(options: {
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

export function legacyWindowsUserId(identity: WindowsLegacyUserIdentity): string {
  return identity.domain ? `${identity.domain}\\${identity.username}` : identity.username;
}

export function generateWindowsTaskXml(options: {
  readonly boot: boolean;
  readonly commandPath: string;
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
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>",
    `  <Actions Context="Author"><Exec><Command>${xmlEscape(options.commandPath)}</Command><Arguments>&quot;${xmlEscape(options.launcherPath)}&quot;</Arguments></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
}
