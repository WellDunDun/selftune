import { win32 } from "node:path";

import * as Schema from "effect/Schema";

import { sha256Hex as authoritySha256Hex } from "../../authority/durable-artifact.js";
import {
  authorityMatch,
  authorityMismatch,
  type AuthorityMatch,
} from "../../authority/evidence.js";

export const WINDOWS_SERVICE_INSTALLATION_RECEIPT_FILENAME = "windows-service-installation.json";
export const WINDOWS_SERVICE_INSTALLATION_RECEIPT_KIND = "selftune-windows-service-installation";

const WindowsAbsolutePath = Schema.String.check(
  Schema.makeFilter((path) => win32.isAbsolute(path), {
    expected: "an absolute Windows path",
  }),
);
const InstallationNonce = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/, {
    expected: "a 32-128 character base64url installation nonce",
  }),
);
const WindowsUserSid = Schema.String.check(
  Schema.isPattern(/^S-\d(?:-\d+)+$/i, { expected: "a Windows user SID" }),
);
const ServicePort = Schema.Number.check(
  Schema.makeFilter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535, {
    expected: "a valid TCP service port",
  }),
);
const CanonicalIsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { expected: "a canonical ISO 8601 UTC timestamp" },
  ),
);
const Sha256Hex = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    expected: "a lowercase 64-character SHA-256 digest",
  }),
);
const WindowsInstallationArtifact = Schema.Struct({
  path: WindowsAbsolutePath,
  sha256: Sha256Hex,
});
const WindowsInstallationArtifacts = Schema.Struct({
  launcher: WindowsInstallationArtifact,
  taskDefinition: WindowsInstallationArtifact,
  wrapper: WindowsInstallationArtifact,
});

class WindowsServiceInstallationReceiptModel extends Schema.Class<WindowsServiceInstallationReceiptModel>(
  "WindowsServiceInstallationReceipt",
)({
  artifacts: WindowsInstallationArtifacts,
  boot: Schema.Boolean,
  configDir: WindowsAbsolutePath,
  executableArgsPrefix: Schema.Array(Schema.String),
  executablePath: WindowsAbsolutePath,
  expectedArgv: Schema.Array(Schema.String).check(Schema.isNonEmpty()),
  installId: Schema.String.check(Schema.isUUID(4)),
  installedAt: CanonicalIsoTimestamp,
  kind: Schema.Literal(WINDOWS_SERVICE_INSTALLATION_RECEIPT_KIND),
  nonce: InstallationNonce,
  owner: Schema.Literals(["desktop", "cli"]),
  port: ServicePort,
  taskName: Schema.NonEmptyString,
  userSid: WindowsUserSid,
  version: Schema.Literal(1),
}) {}

export type WindowsServiceInstallationArtifactRecord = typeof WindowsInstallationArtifact.Type;
export type WindowsServiceInstallationArtifacts = typeof WindowsInstallationArtifacts.Type;

export interface WindowsServiceInstallationCreationInput {
  readonly artifacts: WindowsServiceInstallationArtifacts;
  readonly boot: boolean;
  readonly configDir: string;
  readonly executableArgsPrefix: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly expectedArgv: ReadonlyArray<string>;
  readonly installId: string;
  readonly installedAt: string;
  readonly nonce: string;
  readonly owner: "desktop" | "cli";
  readonly port: number;
  readonly taskName: string;
  readonly userSid: string;
}

export interface WindowsServiceInstallationIdentity {
  readonly argv: ReadonlyArray<string>;
  readonly configDir: string;
  readonly executablePath: string;
  readonly owner: "desktop" | "cli";
  readonly port: number;
  readonly taskName: string;
  readonly userSid: string;
}

export type WindowsServiceInstallationMismatch =
  | "argv-mismatch"
  | "config-dir-mismatch"
  | "executable-path-mismatch"
  | "installation-nonce-duplicate"
  | "installation-nonce-mismatch"
  | "installation-nonce-missing"
  | "owner-mismatch"
  | "port-mismatch"
  | "required-service-argv-mismatch"
  | "task-name-mismatch"
  | "user-sid-mismatch";

export type WindowsServiceInstallationMatch = AuthorityMatch<WindowsServiceInstallationMismatch>;

interface FlagValues {
  readonly attached: number;
  readonly separate: number;
  readonly values: ReadonlyArray<string | undefined>;
}

function flagValues(argv: ReadonlyArray<string>, flag: string): FlagValues {
  const values: Array<string | undefined> = [];
  let attached = 0;
  let separate = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === flag) {
      separate += 1;
      values.push(argv[index + 1]);
      continue;
    }
    if (argument.startsWith(`${flag}=`)) {
      attached += 1;
      values.push(argument.slice(flag.length + 1));
    }
  }
  return { attached, separate, values };
}

function exactlyOneSeparateFlagValue(
  argv: ReadonlyArray<string>,
  flag: string,
  expected: string,
): boolean {
  const found = flagValues(argv, flag);
  return (
    found.attached === 0 &&
    found.separate === 1 &&
    found.values.length === 1 &&
    found.values[0] === expected
  );
}

function exactlyOneBooleanFlag(argv: ReadonlyArray<string>, flag: string): boolean {
  return argv.filter((argument) => argument === flag).length === 1;
}

function validExpectedArgv(receipt: WindowsServiceInstallationReceiptModel): boolean {
  const argv = receipt.expectedArgv;
  const prefixLength = receipt.executableArgsPrefix.length;
  const serviceArgv = argv.slice(prefixLength);
  return (
    arraysEqual(
      canonicalWindowsExecutableArgsPrefixIdentity(argv.slice(0, prefixLength)),
      canonicalWindowsExecutableArgsPrefixIdentity(receipt.executableArgsPrefix),
    ) &&
    serviceArgv[0] === "daemon" &&
    serviceArgv[1] === "run" &&
    exactlyOneBooleanFlag(serviceArgv, "--foreground") &&
    exactlyOneBooleanFlag(serviceArgv, "--supervised") &&
    exactlyOneSeparateFlagValue(serviceArgv, "--owner", receipt.owner) &&
    exactlyOneSeparateFlagValue(serviceArgv, "--port", String(receipt.port)) &&
    exactlyOneSeparateFlagValue(serviceArgv, "--hostname", "127.0.0.1") &&
    exactlyOneSeparateFlagValue(serviceArgv, "--runtime-mode", "standalone") &&
    exactlyOneSeparateFlagValue(serviceArgv, "--service-installation-nonce", receipt.nonce)
  );
}

function validArtifactPaths(receipt: WindowsServiceInstallationReceiptModel): boolean {
  const serverControlDir = canonicalWindowsPathIdentity(
    win32.join(receipt.configDir, "server-control"),
  );
  if (serverControlDir === null) return false;
  const artifactPaths = [
    receipt.artifacts.wrapper.path,
    receipt.artifacts.launcher.path,
    receipt.artifacts.taskDefinition.path,
  ].map(canonicalWindowsPathIdentity);
  if (artifactPaths.some((path) => path === null)) return false;
  const requiredPrefix = `${serverControlDir}\\`;
  return (
    new Set(artifactPaths).size === artifactPaths.length &&
    artifactPaths.every((path) => path?.startsWith(requiredPrefix) === true)
  );
}

export const WindowsServiceInstallationReceiptSchema = WindowsServiceInstallationReceiptModel.check(
  Schema.makeFilter((receipt) => validExpectedArgv(receipt) && validArtifactPaths(receipt), {
    expected: "canonical supervised SelfTune daemon arguments and installation artifacts",
  }),
);

export type WindowsServiceInstallationReceipt = typeof WindowsServiceInstallationReceiptSchema.Type;

export function decodeWindowsServiceInstallationReceipt(
  input: unknown,
): WindowsServiceInstallationReceipt {
  return Schema.decodeUnknownSync(WindowsServiceInstallationReceiptSchema)(input);
}

export function createWindowsServiceInstallationReceipt(
  input: WindowsServiceInstallationCreationInput,
): WindowsServiceInstallationReceipt {
  return decodeWindowsServiceInstallationReceipt({
    ...input,
    kind: WINDOWS_SERVICE_INSTALLATION_RECEIPT_KIND,
    version: 1,
  });
}

export function sha256Hex(input: string | Uint8Array): string {
  return authoritySha256Hex(input);
}

export function canonicalWindowsPathIdentity(path: string): string | null {
  if (!win32.isAbsolute(path)) return null;
  const normalized = win32.normalize(path);
  const withoutTrailingSeparators =
    normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized;
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}

function canonicalWindowsExecutableArgsPrefixIdentity(
  prefix: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return prefix.map((argument) => canonicalWindowsPathIdentity(argument) ?? argument);
}

export function canonicalWindowsArgvIdentity(
  argv: ReadonlyArray<string>,
  executableArgsPrefix: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return argv.map((argument, index) => {
    if (index < executableArgsPrefix.length) {
      const expectedPath = canonicalWindowsPathIdentity(executableArgsPrefix[index]);
      return expectedPath === null
        ? argument
        : (canonicalWindowsPathIdentity(argument) ?? argument);
    }
    if (index > executableArgsPrefix.length && argv[index - 1] === "--spa-dir") {
      return canonicalWindowsPathIdentity(argument) ?? argument;
    }
    return argument;
  });
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameWindowsServiceInstallationReceipt(
  left: WindowsServiceInstallationReceipt,
  right: WindowsServiceInstallationReceipt,
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.installId === right.installId &&
    left.installedAt === right.installedAt &&
    left.nonce === right.nonce &&
    left.taskName === right.taskName &&
    left.userSid === right.userSid &&
    left.boot === right.boot &&
    left.configDir === right.configDir &&
    left.executablePath === right.executablePath &&
    arraysEqual(left.executableArgsPrefix, right.executableArgsPrefix) &&
    arraysEqual(left.expectedArgv, right.expectedArgv) &&
    left.owner === right.owner &&
    left.port === right.port &&
    left.artifacts.launcher.path === right.artifacts.launcher.path &&
    left.artifacts.launcher.sha256 === right.artifacts.launcher.sha256 &&
    left.artifacts.taskDefinition.path === right.artifacts.taskDefinition.path &&
    left.artifacts.taskDefinition.sha256 === right.artifacts.taskDefinition.sha256 &&
    left.artifacts.wrapper.path === right.artifacts.wrapper.path &&
    left.artifacts.wrapper.sha256 === right.artifacts.wrapper.sha256
  );
}

function mismatch(reason: WindowsServiceInstallationMismatch): WindowsServiceInstallationMatch {
  return authorityMismatch(reason);
}

export function matchWindowsServiceInstallation(
  receipt: WindowsServiceInstallationReceipt,
  identity: WindowsServiceInstallationIdentity,
): WindowsServiceInstallationMatch {
  if (receipt.taskName !== identity.taskName) return mismatch("task-name-mismatch");
  if (receipt.userSid.toLocaleLowerCase("en-US") !== identity.userSid.toLocaleLowerCase("en-US")) {
    return mismatch("user-sid-mismatch");
  }
  if (receipt.owner !== identity.owner) return mismatch("owner-mismatch");
  if (receipt.port !== identity.port) return mismatch("port-mismatch");
  if (
    canonicalWindowsPathIdentity(receipt.configDir) !==
    canonicalWindowsPathIdentity(identity.configDir)
  ) {
    return mismatch("config-dir-mismatch");
  }
  if (
    canonicalWindowsPathIdentity(receipt.executablePath) !==
    canonicalWindowsPathIdentity(identity.executablePath)
  ) {
    return mismatch("executable-path-mismatch");
  }

  const nonce = flagValues(identity.argv, "--service-installation-nonce");
  if (nonce.values.length === 0) return mismatch("installation-nonce-missing");
  if (nonce.values.length !== 1) return mismatch("installation-nonce-duplicate");
  if (nonce.attached !== 0 || nonce.separate !== 1 || nonce.values[0] !== receipt.nonce) {
    return mismatch("installation-nonce-mismatch");
  }
  const observedReceipt: WindowsServiceInstallationReceiptModel = {
    ...receipt,
    expectedArgv: identity.argv,
  };
  if (!validExpectedArgv(observedReceipt)) return mismatch("required-service-argv-mismatch");
  return arraysEqual(
    canonicalWindowsArgvIdentity(receipt.expectedArgv, receipt.executableArgsPrefix),
    canonicalWindowsArgvIdentity(identity.argv, receipt.executableArgsPrefix),
  )
    ? authorityMatch()
    : mismatch("argv-mismatch");
}

export function windowsServiceInstallationReceiptPath(configDir: string): string {
  if (!win32.isAbsolute(configDir)) {
    throw new Error("Windows service installation receipt requires an absolute config path.");
  }
  return win32.join(
    win32.normalize(configDir),
    "server-control",
    WINDOWS_SERVICE_INSTALLATION_RECEIPT_FILENAME,
  );
}
