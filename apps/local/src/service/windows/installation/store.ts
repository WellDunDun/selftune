import { Buffer } from "node:buffer";
import { win32 } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  defineDurableReceiptContract,
  type ReceiptGenerationContract,
} from "../../authority/receipt.js";
import {
  createWindowsServiceInstallationReceipt,
  sameWindowsServiceInstallationReceipt,
  WindowsServiceInstallationReceiptSchema,
  windowsServiceInstallationReceiptPath,
  type WindowsServiceInstallationArtifacts,
  type WindowsServiceInstallationReceipt,
} from "./model.js";
import {
  createWindowsServiceLegacyCleanupJournal,
  expectAbsentWindowsServiceLegacyCleanup,
  expectWindowsServiceLegacyCleanup,
  matchesWindowsServiceLegacyCleanupExpectation,
  WindowsServiceLegacyCleanupJournalSchema,
  windowsServiceLegacyCleanupPath,
  type WindowsServiceLegacyCleanupExpectation,
  type WindowsServiceLegacyCleanupJournal,
  type WindowsServiceLegacyCleanupJournalInput,
  type PresentWindowsServiceLegacyCleanupExpectation,
} from "./legacy-cleanup.js";
import {
  canonicalWindowsServiceControlDir,
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsUserServiceMutationLockScopeSchema,
  type WindowsUserServiceMutationLockScope,
} from "../mutation-lock.js";
import { windowsSystemExecutable } from "../scheduler.js";

const WINDOWS_SYSTEM_SID = "S-1-5-18";
const ACL_VERIFICATION_MARKER = "SELFTUNE_ACL_VERIFIED_V1";
const RECEIPT_WRITE_MODE = 0o600;
const RECEIPT_JSON_SCHEMA = Schema.fromJsonString(WindowsServiceInstallationReceiptSchema);
const LEGACY_CLEANUP_JSON_SCHEMA = Schema.fromJsonString(WindowsServiceLegacyCleanupJournalSchema);
const WINDOWS_SID_PATTERN = /^S-\d(?:-\d+)+$/i;
const LOCAL_APP_DATA_MARKER = "SELFTUNE_LOCAL_APP_DATA_V1:";

export interface WindowsInstallationCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface WindowsInstallationFileSystem {
  readonly makeDirectory: (path: string) => Effect.Effect<void, unknown>;
  readonly readUtf8File: (path: string) => Effect.Effect<string | null, unknown>;
  readonly removeFile: (path: string) => Effect.Effect<void, unknown>;
  readonly rename: (from: string, to: string) => Effect.Effect<void, unknown>;
  readonly writeUtf8File: (
    path: string,
    contents: string,
    options: { readonly flag: "wx"; readonly mode: number },
  ) => Effect.Effect<void, unknown>;
}

export interface WindowsInstallationProcess {
  readonly execute: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<WindowsInstallationCommandResult, unknown>;
}

export interface WindowsInstallationClock {
  readonly now: () => Effect.Effect<Date, unknown>;
}

export interface WindowsInstallationRandom {
  readonly bytes: (length: number) => Effect.Effect<Uint8Array, unknown>;
}

export interface WindowsServiceInstallationStoreDependencies {
  readonly clock: WindowsInstallationClock;
  readonly fileSystem: WindowsInstallationFileSystem;
  readonly process: WindowsInstallationProcess;
  readonly random: WindowsInstallationRandom;
  readonly systemRoot?: string;
}

export interface WindowsServiceInstallationReceiptInput {
  readonly artifacts: WindowsServiceInstallationArtifacts;
  readonly boot: boolean;
  readonly configDir: string;
  readonly executableArgsPrefix: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly expectedArgvWithoutNonce: ReadonlyArray<string>;
  readonly owner: "desktop" | "cli";
  readonly port: number;
  readonly taskName: string;
}

export type WindowsServiceInstallationReceiptExpectation =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Present";
      readonly receipt: WindowsServiceInstallationReceipt;
    };

const WINDOWS_RECEIPT_GENERATION: ReceiptGenerationContract<
  WindowsServiceInstallationReceipt,
  WindowsServiceInstallationReceiptExpectation
> = {
  absent: () => ({ _tag: "Absent" }),
  fromReceipt: (receipt) => ({
    _tag: "Present",
    receipt,
  }),
  matches: (receipt, expected) => {
    if (expected._tag === "Absent") return receipt === null;
    return receipt !== null && sameWindowsServiceInstallationReceipt(receipt, expected.receipt);
  },
};

const WINDOWS_RECEIPT_CONTRACT = defineDurableReceiptContract({
  create: createWindowsServiceInstallationReceipt,
  decode: (input: unknown) => Schema.decodeUnknownEffect(RECEIPT_JSON_SCHEMA)(input),
  encodeForStorage: (receipt: WindowsServiceInstallationReceipt) =>
    Schema.encodeEffect(RECEIPT_JSON_SCHEMA)(receipt).pipe(Effect.map((encoded) => `${encoded}\n`)),
  generation: WINDOWS_RECEIPT_GENERATION,
});

export function expectAbsentWindowsServiceInstallationReceipt(): WindowsServiceInstallationReceiptExpectation {
  return WINDOWS_RECEIPT_CONTRACT.generation.absent();
}

export function expectWindowsServiceInstallationReceipt(
  receipt: WindowsServiceInstallationReceipt,
): WindowsServiceInstallationReceiptExpectation {
  return WINDOWS_RECEIPT_CONTRACT.generation.fromReceipt(receipt);
}

export class WindowsServiceInstallationStoreError extends Schema.TaggedErrorClass<WindowsServiceInstallationStoreError>()(
  "WindowsServiceInstallationStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export interface WindowsServiceInstallationStore {
  readonly createReceipt: (
    input: WindowsServiceInstallationReceiptInput,
  ) => Effect.Effect<WindowsServiceInstallationReceipt, WindowsServiceInstallationStoreError>;
  readonly persistReceipt: (
    input: WindowsServiceInstallationReceiptInput,
    expectedPrior: WindowsServiceInstallationReceiptExpectation,
  ) => Effect.Effect<WindowsServiceInstallationReceipt, WindowsServiceInstallationStoreError>;
  readonly prepareServerControl: (
    configDir: string,
  ) => Effect.Effect<string, WindowsServiceInstallationStoreError>;
  readonly readReceipt: (
    configDir: string,
  ) => Effect.Effect<
    WindowsServiceInstallationReceipt | null,
    WindowsServiceInstallationStoreError
  >;
  readonly removeReceiptAfterCleanup: <E, R>(
    configDir: string,
    expected: WindowsServiceInstallationReceiptExpectation,
    cleanup: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E | WindowsServiceInstallationStoreError, R>;
  readonly resolveCurrentUserSid: () => Effect.Effect<string, WindowsServiceInstallationStoreError>;
  readonly writeReceipt: (
    receipt: WindowsServiceInstallationReceipt,
    expectedPrior: WindowsServiceInstallationReceiptExpectation,
  ) => Effect.Effect<void, WindowsServiceInstallationStoreError>;
}

export interface WindowsServiceInstallationStoreWithLegacyCleanup extends WindowsServiceInstallationStore {
  readonly createLegacyCleanup: (
    input: WindowsServiceLegacyCleanupJournalInput,
  ) => Effect.Effect<WindowsServiceLegacyCleanupJournal, WindowsServiceInstallationStoreError>;
  readonly readLegacyCleanup: (
    configDir: string,
  ) => Effect.Effect<
    WindowsServiceLegacyCleanupJournal | null,
    WindowsServiceInstallationStoreError
  >;
  readonly removeLegacyCleanup: (
    configDir: string,
    expected: PresentWindowsServiceLegacyCleanupExpectation,
  ) => Effect.Effect<void, WindowsServiceInstallationStoreError>;
  readonly requireLegacyCleanup: (
    configDir: string,
    expected: WindowsServiceLegacyCleanupExpectation,
    operation: string,
  ) => Effect.Effect<void, WindowsServiceInstallationStoreError>;
}

export interface WindowsServiceInstallationStoreWithUserControl extends WindowsServiceInstallationStoreWithLegacyCleanup {
  readonly resolveUserServiceControl: () => Effect.Effect<
    WindowsUserServiceMutationLockScope,
    WindowsServiceInstallationStoreError
  >;
  readonly prepareUserServiceControl: () => Effect.Effect<
    WindowsUserServiceMutationLockScope,
    WindowsServiceInstallationStoreError
  >;
}

interface CsvRow {
  readonly fields: ReadonlyArray<string>;
  readonly valid: boolean;
}

function parseCsvRow(line: string): CsvRow {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') {
        current += character;
      } else if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = false;
        quoteClosed = true;
      }
      continue;
    }
    if (character === ",") {
      fields.push(current);
      current = "";
      quoteClosed = false;
    } else if (character === '"' && current.length === 0 && !quoteClosed) {
      quoted = true;
    } else if (!quoteClosed || /\s/.test(character)) {
      current += character;
    } else {
      return { fields: [], valid: false };
    }
  }
  if (quoted) return { fields: [], valid: false };
  fields.push(current);
  return { fields, valid: true };
}

export function parseWhoamiUserCsv(output: string): string | null {
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\ufeff/, "").trim())
    .filter((line) => line.length > 0);
  if (rows.length !== 1) return null;
  const parsed = parseCsvRow(rows[0]);
  if (!parsed.valid || parsed.fields.length !== 2 || parsed.fields[0].trim().length === 0) {
    return null;
  }
  const sid = parsed.fields[1].trim();
  return WINDOWS_SID_PATTERN.test(sid) ? sid.toUpperCase() : null;
}

export function parseLocalAppDataOutput(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0].startsWith(LOCAL_APP_DATA_MARKER)) return null;
  const encoded = lines[0].slice(LOCAL_APP_DATA_MARKER.length);
  if (
    encoded.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return null;
  const path = decoded.toString("utf8");
  return path.length > 0 && !path.includes("\0") && !path.includes("\ufffd") ? path : null;
}

function failure(operation: string, cause: unknown): WindowsServiceInstallationStoreError {
  return WindowsServiceInstallationStoreError.make({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

function mapFailure<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WindowsServiceInstallationStoreError, R> {
  return effect.pipe(Effect.mapError((cause) => failure(operation, cause)));
}

function commandFailure(command: string, result: WindowsInstallationCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    detail
      ? `${command} failed (exit ${result.code}): ${detail}`
      : `${command} failed (exit ${result.code}).`,
  );
}

function uuidV4FromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error(`Expected 16 UUID bytes, received ${bytes.length}.`);
  const normalized = Uint8Array.from(bytes);
  normalized[6] = (normalized[6] & 0x0f) | 0x40;
  normalized[8] = (normalized[8] & 0x3f) | 0x80;
  const hex = [...normalized].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nonceFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error(`Expected 32 nonce bytes, received ${bytes.length}.`);
  return Buffer.from(bytes).toString("base64url");
}

function resolveReceiptPath(
  configDir: string,
): Effect.Effect<string, WindowsServiceInstallationStoreError> {
  return Effect.try({
    try: () => windowsServiceInstallationReceiptPath(configDir),
    catch: (cause) => failure("resolve-receipt-path", cause),
  });
}

function resolveLegacyCleanupPath(
  configDir: string,
): Effect.Effect<string, WindowsServiceInstallationStoreError> {
  return Effect.try({
    try: () => windowsServiceLegacyCleanupPath(configDir),
    catch: (cause) => failure("resolve-legacy-cleanup-path", cause),
  });
}

export function makeWindowsServiceInstallationStore(
  dependencies: WindowsServiceInstallationStoreDependencies,
): WindowsServiceInstallationStoreWithUserControl {
  const whoami = windowsSystemExecutable("whoami.exe", dependencies.systemRoot);
  const powershell = win32.join(
    win32.dirname(whoami),
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  const resolveCurrentUserSid = Effect.fn("SelfTuneService.windowsInstallation.resolveUserSid")(
    function* () {
      const result = yield* mapFailure(
        "resolve-user-sid",
        dependencies.process.execute(whoami, ["/user", "/fo", "csv", "/nh"]),
      );
      if (result.code !== 0) {
        return yield* Effect.fail(failure("resolve-user-sid", commandFailure("whoami", result)));
      }
      const sid = parseWhoamiUserCsv(result.stdout);
      if (sid === null) {
        return yield* Effect.fail(
          failure("resolve-user-sid", "whoami returned an invalid structured user record."),
        );
      }
      return sid;
    },
  );

  const resolveLocalAppData = Effect.fn("SelfTuneService.windowsInstallation.resolveLocalAppData")(
    function* () {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "Set-StrictMode -Version Latest",
        "$path = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
        "if ([String]::IsNullOrWhiteSpace($path)) { exit 61 }",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($path)",
        `$encoded = [Convert]::ToBase64String($bytes)`,
        `Write-Output ('${LOCAL_APP_DATA_MARKER}' + $encoded)`,
      ].join("\n");
      const result = yield* mapFailure(
        "resolve-local-app-data",
        dependencies.process.execute(powershell, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ]),
      );
      if (result.code !== 0) {
        return yield* Effect.fail(
          failure(
            "resolve-local-app-data",
            commandFailure("PowerShell Known Folder lookup", result),
          ),
        );
      }
      const localAppData = parseLocalAppDataOutput(result.stdout);
      if (localAppData === null || !win32.isAbsolute(localAppData)) {
        return yield* Effect.fail(
          failure(
            "resolve-local-app-data",
            "PowerShell returned an invalid structured LocalApplicationData path.",
          ),
        );
      }
      return localAppData;
    },
  );

  const buildReceipt = Effect.fn("SelfTuneService.windowsInstallation.createReceipt")(function* (
    input: WindowsServiceInstallationReceiptInput,
    userSid: string,
  ) {
    const now = yield* mapFailure("read-clock", dependencies.clock.now());
    const uuidBytes = yield* mapFailure("generate-install-id", dependencies.random.bytes(16));
    const nonceBytes = yield* mapFailure(
      "generate-installation-nonce",
      dependencies.random.bytes(32),
    );
    return yield* Effect.try({
      try: () => {
        const nonce = nonceFromBytes(nonceBytes);
        return WINDOWS_RECEIPT_CONTRACT.create({
          ...input,
          expectedArgv: [...input.expectedArgvWithoutNonce, "--service-installation-nonce", nonce],
          installId: uuidV4FromBytes(uuidBytes),
          installedAt: now.toISOString(),
          nonce,
          userSid,
        });
      },
      catch: (cause) => failure("create-receipt", cause),
    });
  });

  const createReceipt = Effect.fn("SelfTuneService.windowsInstallation.prepareReceipt")(function* (
    input: WindowsServiceInstallationReceiptInput,
  ) {
    const userSid = yield* resolveCurrentUserSid();
    return yield* buildReceipt(input, userSid);
  });

  const hardenControlDirectory = Effect.fn("SelfTuneService.windowsInstallation.hardenAcl")(
    function* (
      controlDir: string,
      userSid: string,
      operations: { readonly harden: string; readonly verify: string },
    ) {
      const encodedPath = Buffer.from(controlDir, "utf8").toString("base64");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "Set-StrictMode -Version Latest",
        "$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
        "Import-Module -Name $securityModule -Force -ErrorAction Stop",
        `$path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))`,
        `$userSid = [System.Security.Principal.SecurityIdentifier]::new('${userSid}')`,
        `$systemSid = [System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')`,
        "$item = Get-Item -LiteralPath $path -Force",
        "if (-not $item.PSIsContainer) { exit 41 }",
        "if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 42 }",
        "$security = [System.Security.AccessControl.DirectorySecurity]::new()",
        "$security.SetAccessRuleProtection($true, $false)",
        "$security.SetOwner($userSid)",
        "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
        "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
        "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
        "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
        "$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($userSid, $fullControl, $inheritance, $propagation, $allow)) | Out-Null",
        "$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $fullControl, $inheritance, $propagation, $allow)) | Out-Null",
        "Set-Acl -LiteralPath $path -AclObject $security",
        "$actualItem = Get-Item -LiteralPath $path -Force",
        "if (-not $actualItem.PSIsContainer) { exit 43 }",
        "if (($actualItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 44 }",
        "$actual = Get-Acl -LiteralPath $path",
        "if (-not $actual.AreAccessRulesProtected) { exit 45 }",
        "if (-not $actual.AreAccessRulesCanonical) { exit 46 }",
        "if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) { exit 47 }",
        "$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
        "if ($rules.Count -ne 2) { exit 48 }",
        "$seen = @{}",
        "foreach ($rule in $rules) {",
        "  $identity = $rule.IdentityReference.Value",
        "  if (($identity -ne $userSid.Value) -and ($identity -ne $systemSid.Value)) { exit 49 }",
        "  if ($rule.AccessControlType -ne $allow) { exit 50 }",
        "  if ([int]$rule.FileSystemRights -ne [int]$fullControl) { exit 51 }",
        "  if ($rule.InheritanceFlags -ne $inheritance) { exit 52 }",
        "  if ($rule.PropagationFlags -ne $propagation) { exit 53 }",
        "  $seen[$identity] = 1 + [int]$seen[$identity]",
        "}",
        "if (($seen[$userSid.Value] -ne 1) -or ($seen[$systemSid.Value] -ne 1)) { exit 54 }",
        `Write-Output '${ACL_VERIFICATION_MARKER}'`,
      ].join("\n");
      const result = yield* mapFailure(
        operations.harden,
        dependencies.process.execute(powershell, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ]),
      );
      if (result.code !== 0) {
        return yield* Effect.fail(
          failure(operations.harden, commandFailure("PowerShell ACL setup", result)),
        );
      }
      const output = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (output.length !== 1 || output[0] !== ACL_VERIFICATION_MARKER) {
        return yield* Effect.fail(
          failure(
            operations.verify,
            "ACL setup completed without an exact read-back verification marker.",
          ),
        );
      }
    },
  );

  const prepareServerControlForSid = Effect.fn(
    "SelfTuneService.windowsInstallation.prepareServerControlForSid",
  )(function* (configDir: string, userSid: string) {
    const receiptPath = yield* resolveReceiptPath(configDir);
    const serverControlDir = win32.dirname(receiptPath);
    yield* mapFailure(
      "create-server-control-directory",
      dependencies.fileSystem.makeDirectory(serverControlDir),
    );
    yield* hardenControlDirectory(serverControlDir, userSid, {
      harden: "harden-server-control-acl",
      verify: "verify-server-control-acl",
    });
    return serverControlDir;
  });

  const prepareServerControl = Effect.fn(
    "SelfTuneService.windowsInstallation.prepareServerControl",
  )(function* (configDir: string) {
    const currentUserSid = yield* resolveCurrentUserSid();
    return yield* prepareServerControlForSid(configDir, currentUserSid);
  });

  const resolveUserServiceControl = Effect.fn(
    "SelfTuneService.windowsInstallation.resolveUserServiceControl",
  )(function* () {
    const userSid = yield* resolveCurrentUserSid();
    const localAppData = yield* resolveLocalAppData();
    const controlDir = yield* Effect.try({
      try: () =>
        canonicalWindowsServiceControlDir(win32.join(localAppData, "SelfTune", "service-control")),
      catch: (cause) => failure("resolve-user-service-control", cause),
    });
    return yield* Schema.decodeUnknownEffect(WindowsUserServiceMutationLockScopeSchema)({
      controlDir,
      namespace: WINDOWS_USER_SERVICE_NAMESPACE,
      userSid,
    }).pipe(Effect.mapError((cause) => failure("validate-user-service-lock-scope", cause)));
  });

  const prepareUserServiceControl = Effect.fn(
    "SelfTuneService.windowsInstallation.prepareUserServiceControl",
  )(function* () {
    const scope = yield* resolveUserServiceControl();
    yield* mapFailure(
      "create-user-service-control-directory",
      dependencies.fileSystem.makeDirectory(scope.controlDir),
    );
    yield* hardenControlDirectory(scope.controlDir, scope.userSid, {
      harden: "harden-user-service-control-acl",
      verify: "verify-user-service-control-acl",
    });
    return scope;
  });

  const readReceipt = Effect.fn("SelfTuneService.windowsInstallation.readReceipt")(function* (
    configDir: string,
  ) {
    const receiptPath = yield* resolveReceiptPath(configDir);
    const contents = yield* mapFailure(
      "read-receipt",
      dependencies.fileSystem.readUtf8File(receiptPath),
    );
    if (contents === null) return null;
    return yield* WINDOWS_RECEIPT_CONTRACT.decode(contents).pipe(
      Effect.mapError((cause) => failure("decode-receipt", cause)),
    );
  });

  const readLegacyCleanup = Effect.fn("SelfTuneService.windowsInstallation.readLegacyCleanup")(
    function* (configDir: string) {
      const journalPath = yield* resolveLegacyCleanupPath(configDir);
      const contents = yield* mapFailure(
        "read-legacy-cleanup",
        dependencies.fileSystem.readUtf8File(journalPath),
      );
      if (contents === null) return null;
      return yield* Schema.decodeUnknownEffect(LEGACY_CLEANUP_JSON_SCHEMA)(contents).pipe(
        Effect.mapError((cause) => failure("decode-legacy-cleanup", cause)),
      );
    },
  );

  const requireLegacyCleanup = Effect.fn(
    "SelfTuneService.windowsInstallation.requireLegacyCleanup",
  )(function* (
    configDir: string,
    expected: WindowsServiceLegacyCleanupExpectation,
    operation: string,
  ) {
    const actual = yield* readLegacyCleanup(configDir);
    if (!matchesWindowsServiceLegacyCleanupExpectation(actual, expected)) {
      return yield* Effect.fail(
        failure(operation, "Windows legacy cleanup journal generation changed."),
      );
    }
  });

  const requireReceiptExpectation = Effect.fn(
    "SelfTuneService.windowsInstallation.requireReceiptExpectation",
  )(function* (
    configDir: string,
    expected: WindowsServiceInstallationReceiptExpectation,
    operation: string,
  ) {
    const actual = yield* readReceipt(configDir);
    if (!WINDOWS_RECEIPT_CONTRACT.generation.matches(actual, expected)) {
      return yield* Effect.fail(
        failure(operation, "Windows service installation receipt generation changed."),
      );
    }
  });

  const writeReceiptForSid = Effect.fn("SelfTuneService.windowsInstallation.writeReceipt")(
    function* (
      receipt: WindowsServiceInstallationReceipt,
      currentUserSid: string,
      expectedPrior: WindowsServiceInstallationReceiptExpectation,
    ) {
      if (receipt.userSid.toUpperCase() !== currentUserSid.toUpperCase()) {
        return yield* Effect.fail(
          failure(
            "verify-receipt-user-sid",
            `Receipt SID ${receipt.userSid} does not match current user SID ${currentUserSid}.`,
          ),
        );
      }
      const receiptPath = yield* resolveReceiptPath(receipt.configDir);
      const temporaryPath = `${receiptPath}.${receipt.installId}.tmp`;
      const encoded = yield* WINDOWS_RECEIPT_CONTRACT.encodeForStorage(receipt).pipe(
        Effect.mapError((cause) => failure("encode-receipt", cause)),
      );
      yield* prepareServerControlForSid(receipt.configDir, currentUserSid);

      const writeAndRename = Effect.gen(function* () {
        yield* mapFailure(
          "write-receipt-temp",
          dependencies.fileSystem.writeUtf8File(temporaryPath, encoded, {
            flag: "wx",
            mode: RECEIPT_WRITE_MODE,
          }),
        );
        // This is a fail-closed generation check, not a filesystem compare-and-swap.
        // The lifecycle mutation lock remains the cross-process serialization boundary.
        yield* requireReceiptExpectation(
          receipt.configDir,
          expectedPrior,
          "verify-prior-receipt-generation",
        );
        yield* mapFailure(
          "promote-receipt",
          dependencies.fileSystem.rename(temporaryPath, receiptPath),
        );
        yield* requireReceiptExpectation(
          receipt.configDir,
          expectWindowsServiceInstallationReceipt(receipt),
          "verify-promoted-receipt-generation",
        );
      });
      const result = yield* Effect.result(writeAndRename);
      if (Result.isSuccess(result)) return;
      yield* Effect.result(dependencies.fileSystem.removeFile(temporaryPath));
      return yield* Effect.fail(result.failure);
    },
  );

  const writeReceipt = Effect.fn("SelfTuneService.windowsInstallation.writeValidatedReceipt")(
    function* (
      receipt: WindowsServiceInstallationReceipt,
      expectedPrior: WindowsServiceInstallationReceiptExpectation,
    ) {
      const currentUserSid = yield* resolveCurrentUserSid();
      return yield* writeReceiptForSid(receipt, currentUserSid, expectedPrior);
    },
  );

  const persistReceipt = Effect.fn("SelfTuneService.windowsInstallation.persistReceipt")(function* (
    input: WindowsServiceInstallationReceiptInput,
    expectedPrior: WindowsServiceInstallationReceiptExpectation,
  ) {
    const currentUserSid = yield* resolveCurrentUserSid();
    const receipt = yield* buildReceipt(input, currentUserSid);
    yield* writeReceiptForSid(receipt, currentUserSid, expectedPrior);
    return receipt;
  });

  const createLegacyCleanup = Effect.fn("SelfTuneService.windowsInstallation.createLegacyCleanup")(
    function* (input: WindowsServiceLegacyCleanupJournalInput) {
      const currentUserSid = yield* resolveCurrentUserSid();
      if (input.userSid !== currentUserSid) {
        return yield* Effect.fail(
          failure(
            "verify-legacy-cleanup-user-sid",
            `Cleanup SID ${input.userSid} does not match current user SID ${currentUserSid}.`,
          ),
        );
      }
      const now = yield* mapFailure("read-legacy-cleanup-clock", dependencies.clock.now());
      const uuidBytes = yield* mapFailure(
        "generate-legacy-cleanup-id",
        dependencies.random.bytes(16),
      );
      const journal = yield* Effect.try({
        try: () =>
          createWindowsServiceLegacyCleanupJournal(input, {
            cleanupId: uuidV4FromBytes(uuidBytes),
            createdAt: now.toISOString(),
          }),
        catch: (cause) => failure("create-legacy-cleanup", cause),
      });
      const journalPath = yield* resolveLegacyCleanupPath(input.configDir);
      const temporaryPath = `${journalPath}.${journal.cleanupId}.tmp`;
      const encoded = yield* Schema.encodeEffect(LEGACY_CLEANUP_JSON_SCHEMA)(journal).pipe(
        Effect.mapError((cause) => failure("encode-legacy-cleanup", cause)),
      );
      yield* prepareServerControlForSid(input.configDir, currentUserSid);
      const expectedAbsent = expectAbsentWindowsServiceLegacyCleanup();
      const writeAndPromote = Effect.uninterruptible(
        Effect.gen(function* () {
          yield* mapFailure(
            "write-legacy-cleanup-temp",
            dependencies.fileSystem.writeUtf8File(temporaryPath, `${encoded}\n`, {
              flag: "wx",
              mode: RECEIPT_WRITE_MODE,
            }),
          );
          yield* requireLegacyCleanup(
            input.configDir,
            expectedAbsent,
            "verify-prior-legacy-cleanup-generation",
          );
          yield* mapFailure(
            "promote-legacy-cleanup",
            dependencies.fileSystem.rename(temporaryPath, journalPath),
          );
          yield* requireLegacyCleanup(
            input.configDir,
            expectWindowsServiceLegacyCleanup(journal),
            "verify-promoted-legacy-cleanup-generation",
          );
        }),
      );
      const result = yield* Effect.result(writeAndPromote);
      if (Result.isSuccess(result)) return journal;
      yield* Effect.result(dependencies.fileSystem.removeFile(temporaryPath));
      return yield* Effect.fail(result.failure);
    },
  );

  const removeLegacyCleanup = Effect.fn("SelfTuneService.windowsInstallation.removeLegacyCleanup")(
    function* (configDir: string, expected: PresentWindowsServiceLegacyCleanupExpectation) {
      yield* requireLegacyCleanup(
        configDir,
        expected,
        "verify-legacy-cleanup-generation-before-remove",
      );
      const journalPath = yield* resolveLegacyCleanupPath(configDir);
      yield* mapFailure("remove-legacy-cleanup", dependencies.fileSystem.removeFile(journalPath));
      yield* requireLegacyCleanup(
        configDir,
        expectAbsentWindowsServiceLegacyCleanup(),
        "verify-legacy-cleanup-absence",
      );
    },
  );

  const removeReceiptAfterCleanup = <E, R>(
    configDir: string,
    expected: WindowsServiceInstallationReceiptExpectation,
    cleanup: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E | WindowsServiceInstallationStoreError, R> =>
    Effect.gen(function* () {
      yield* requireReceiptExpectation(
        configDir,
        expected,
        "verify-receipt-generation-before-cleanup",
      );
      yield* cleanup;
      // This immediate pre-unlink check is fail-closed, not an atomic filesystem CAS.
      // The lifecycle mutation lock remains the cross-process serialization boundary.
      yield* requireReceiptExpectation(
        configDir,
        expected,
        "verify-receipt-generation-before-remove",
      );
      const receiptPath = yield* resolveReceiptPath(configDir);
      yield* mapFailure("remove-receipt", dependencies.fileSystem.removeFile(receiptPath));
      yield* requireReceiptExpectation(
        configDir,
        expectAbsentWindowsServiceInstallationReceipt(),
        "verify-receipt-absence",
      );
    });

  return {
    createLegacyCleanup,
    createReceipt,
    persistReceipt,
    prepareServerControl,
    prepareUserServiceControl,
    readLegacyCleanup,
    readReceipt,
    resolveUserServiceControl,
    removeLegacyCleanup,
    removeReceiptAfterCleanup,
    resolveCurrentUserSid,
    requireLegacyCleanup,
    writeReceipt,
  };
}
