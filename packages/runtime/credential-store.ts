import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CredentialProvider as CredentialProviderSchema,
  type CredentialProvider as CredentialProviderType,
  type CredentialReference,
} from "@selftune/library/remote/config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export { CredentialProviderSchema as CredentialProvider };
export type { CredentialReference };

export interface PlatformCredentialStore {
  readonly delete: (reference: CredentialReference, configRoot: string) => void;
  readonly get: (reference: CredentialReference, configRoot: string) => string | null;
  readonly set: (account: string, value: string, configRoot: string) => CredentialReference;
}

export interface AsyncPlatformCredentialStore {
  readonly delete: (reference: CredentialReference, configRoot: string) => Promise<void>;
  readonly set: (
    account: string,
    value: string,
    configRoot: string,
  ) => Promise<CredentialReference>;
}

export class CredentialStoreFailure extends Schema.TaggedErrorClass<CredentialStoreFailure>()(
  "CredentialStoreFailure",
  {
    operation: Schema.String,
    provider: CredentialProviderSchema,
    message: Schema.String,
  },
) {}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly delete: (
      reference: CredentialReference,
      configRoot: string,
    ) => Effect.Effect<void, CredentialStoreFailure>;
    readonly get: (
      reference: CredentialReference,
      configRoot: string,
    ) => Effect.Effect<string | null, CredentialStoreFailure>;
    readonly set: (
      account: string,
      value: string,
      configRoot: string,
    ) => Effect.Effect<CredentialReference, CredentialStoreFailure>;
  }
>()("@selftune/cli/CredentialStore") {}

const SERVICE_NAME = "dev.selftune.remote-library";

function failure(
  operation: string,
  provider: CredentialProviderType,
  cause: unknown,
): CredentialStoreFailure {
  return CredentialStoreFailure.make({
    operation,
    provider,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function requireSuccess(
  operation: string,
  provider: CredentialProviderType,
  result: ReturnType<typeof spawnSync>,
): void {
  if (result.status === 0) return;
  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString().trim();
  throw failure(
    operation,
    provider,
    stderr || stdout || result.error || "Credential command failed.",
  );
}

interface CommandResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  input: string | null,
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("close", (status) =>
      resolveCommand({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? undefined);
  });
}

function requireAsyncSuccess(
  operation: string,
  provider: CredentialProviderType,
  result: CommandResult,
): void {
  if (result.status === 0) return;
  throw failure(
    operation,
    provider,
    result.stderr.trim() || result.stdout.trim() || "Credential command failed.",
  );
}

function setMacOsCredential(account: string, value: string): void {
  const provider = "macos-keychain";
  const result = spawnSync(
    "security",
    ["add-generic-password", "-a", account, "-s", SERVICE_NAME, "-U", "-w"],
    {
      encoding: "utf8",
      input: `${value}\n${value}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  requireSuccess("set", provider, result);
}

function getMacOsCredential(account: string): string | null {
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", account, "-s", SERVICE_NAME, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return null;
  return result.stdout.toString().trim() || null;
}

function deleteMacOsCredential(account: string): void {
  const result = spawnSync(
    "security",
    ["delete-generic-password", "-a", account, "-s", SERVICE_NAME],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0 || result.status === 44) return;
  requireSuccess("delete", "macos-keychain", result);
}

function hasSecretTool(): boolean {
  const result = spawnSync("secret-tool", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function setLinuxCredential(account: string, value: string): void {
  const provider = "linux-secret-service";
  const result = spawnSync(
    "secret-tool",
    ["store", "--label=SelfTune Sync & Backup", "service", SERVICE_NAME, "account", account],
    { encoding: "utf8", input: value, stdio: ["pipe", "pipe", "pipe"] },
  );
  requireSuccess("set", provider, result);
}

function getLinuxCredential(account: string): string | null {
  const result = spawnSync("secret-tool", ["lookup", "service", SERVICE_NAME, "account", account], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return result.stdout.toString().trim() || null;
}

function deleteLinuxCredential(account: string): void {
  const result = spawnSync("secret-tool", ["clear", "service", SERVICE_NAME, "account", account], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  requireSuccess("delete", "linux-secret-service", result);
}

const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = "Stop"
$inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
if ($inputValue.operation -eq "set") {
  try { $existing = $vault.Retrieve($inputValue.service, $inputValue.account); $vault.Remove($existing) } catch {}
  $credential = New-Object Windows.Security.Credentials.PasswordCredential($inputValue.service, $inputValue.account, $inputValue.value)
  $vault.Add($credential)
} elseif ($inputValue.operation -eq "get") {
  try { $credential = $vault.Retrieve($inputValue.service, $inputValue.account); $credential.RetrievePassword(); [Console]::Out.Write($credential.Password) } catch { exit 44 }
} elseif ($inputValue.operation -eq "delete") {
  try { $credential = $vault.Retrieve($inputValue.service, $inputValue.account) }
  catch {
    if ($_.Exception.HResult -eq -2147023728) { exit 0 }
    throw
  }
  $vault.Remove($credential)
}
`;

function runWindowsCredential(
  operation: "delete" | "get" | "set",
  account: string,
  value?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
    {
      encoding: "utf8",
      input: JSON.stringify({ operation, service: SERVICE_NAME, account, value }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function setWindowsCredential(account: string, value: string): void {
  const provider = "windows-credential-manager";
  requireSuccess("set", provider, runWindowsCredential("set", account, value));
}

function getWindowsCredential(account: string): string | null {
  const result = runWindowsCredential("get", account);
  if (result.status !== 0) return null;
  return result.stdout.toString().trim() || null;
}

function deleteWindowsCredential(account: string): void {
  requireSuccess("delete", "windows-credential-manager", runWindowsCredential("delete", account));
}

function fileStorePath(configRoot: string): string {
  return join(configRoot, "credential-store.json");
}

function readFileStore(configRoot: string): Record<string, string> {
  try {
    const value = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
    )(readFileSync(fileStorePath(configRoot), "utf8"));
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] =>
        Schema.is(Schema.String)(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeFileStore(configRoot: string, values: Record<string, string>): void {
  const path = fileStorePath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function setFileCredential(account: string, value: string, configRoot: string): void {
  writeFileStore(configRoot, { ...readFileStore(configRoot), [account]: value });
}

function deleteFileCredential(account: string, configRoot: string): void {
  const values = readFileStore(configRoot);
  if (!(account in values)) return;
  delete values[account];
  writeFileStore(configRoot, values);
}

export const platformCredentialStore: PlatformCredentialStore = {
  set(account, value, configRoot) {
    if (process.platform === "darwin") {
      setMacOsCredential(account, value);
      return { provider: "macos-keychain", account };
    }
    if (process.platform === "win32") {
      setWindowsCredential(account, value);
      return { provider: "windows-credential-manager", account };
    }
    if (process.platform === "linux" && hasSecretTool()) {
      setLinuxCredential(account, value);
      return { provider: "linux-secret-service", account };
    }
    setFileCredential(account, value, configRoot);
    return { provider: "file", account };
  },
  get(reference, configRoot) {
    switch (reference.provider) {
      case "macos-keychain":
        return getMacOsCredential(reference.account);
      case "linux-secret-service":
        return getLinuxCredential(reference.account);
      case "windows-credential-manager":
        return getWindowsCredential(reference.account);
      case "file":
        return readFileStore(configRoot)[reference.account] ?? null;
    }
  },
  delete(reference, configRoot) {
    switch (reference.provider) {
      case "macos-keychain":
        deleteMacOsCredential(reference.account);
        return;
      case "linux-secret-service":
        deleteLinuxCredential(reference.account);
        return;
      case "windows-credential-manager":
        deleteWindowsCredential(reference.account);
        return;
      case "file":
        deleteFileCredential(reference.account, configRoot);
    }
  },
};

/** Non-blocking credential writes for long-lived local HTTP hosts. */
export const asyncPlatformCredentialStore: AsyncPlatformCredentialStore = {
  async set(account, value, configRoot) {
    if (process.platform === "darwin") {
      const result = await runCommand(
        "security",
        ["add-generic-password", "-a", account, "-s", SERVICE_NAME, "-U", "-w"],
        `${value}\n${value}\n`,
      );
      requireAsyncSuccess("set", "macos-keychain", result);
      return { provider: "macos-keychain", account };
    }
    if (process.platform === "linux" && hasSecretTool()) {
      const result = await runCommand(
        "secret-tool",
        ["store", "--label=SelfTune Sync & Backup", "service", SERVICE_NAME, "account", account],
        value,
      );
      requireAsyncSuccess("set", "linux-secret-service", result);
      return { provider: "linux-secret-service", account };
    }
    if (process.platform === "win32") {
      const result = await runCommand(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
        JSON.stringify({ operation: "set", service: SERVICE_NAME, account, value }),
      );
      requireAsyncSuccess("set", "windows-credential-manager", result);
      return { provider: "windows-credential-manager", account };
    }
    return platformCredentialStore.set(account, value, configRoot);
  },
  async delete(reference, configRoot) {
    if (reference.provider === "macos-keychain") {
      const result = await runCommand(
        "security",
        ["delete-generic-password", "-a", reference.account, "-s", SERVICE_NAME],
        null,
      );
      if (result.status !== 0 && result.status !== 44) {
        requireAsyncSuccess("delete", "macos-keychain", result);
      }
      return;
    }
    platformCredentialStore.delete(reference, configRoot);
  },
};

export const CredentialStoreLive = Layer.succeed(CredentialStore)({
  set: (account, value, configRoot) =>
    Effect.try({
      try: () => platformCredentialStore.set(account, value, configRoot),
      catch: (cause) =>
        cause instanceof CredentialStoreFailure ? cause : failure("set", "file", cause),
    }),
  get: (reference, configRoot) =>
    Effect.try({
      try: () => platformCredentialStore.get(reference, configRoot),
      catch: (cause) =>
        cause instanceof CredentialStoreFailure ? cause : failure("get", reference.provider, cause),
    }),
  delete: (reference, configRoot) =>
    Effect.try({
      try: () => platformCredentialStore.delete(reference, configRoot),
      catch: (cause) =>
        cause instanceof CredentialStoreFailure
          ? cause
          : failure("delete", reference.provider, cause),
    }),
});

export function credentialStoreFileExists(configRoot: string): boolean {
  return existsSync(fileStorePath(configRoot));
}
