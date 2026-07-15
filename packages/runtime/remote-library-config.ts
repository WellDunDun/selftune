import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  defaultSyncPreferences,
  SyncPreferences,
  type SyncPreferences as SyncPreferencesType,
} from "@selftune/control-plane";
import { Schema } from "effect";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import {
  CredentialProvider,
  platformCredentialStore,
  type CredentialProvider as CredentialProviderType,
  type CredentialReference,
  type PlatformCredentialStore,
} from "./credential-store.js";
import { CLIError } from "./utils/cli-error.js";

const LegacyRemoteLibraryConfigFile = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  apiKey: Schema.String,
  preferences: SyncPreferences,
});

const RemoteLibraryConfigFile = Schema.Struct({
  version: Schema.Literal(2),
  url: Schema.String,
  credential: Schema.Struct({
    provider: CredentialProvider,
    account: Schema.String,
  }),
  preferences: SyncPreferences,
});

type StoredRemoteLibraryConfig = typeof RemoteLibraryConfigFile.Type;

export interface RemoteLibraryConfig {
  readonly apiKey: string;
  readonly credentialProvider: CredentialProviderType | "environment";
  readonly preferences: SyncPreferencesType;
  readonly url: string;
  readonly version: 2;
}

export interface RemoteLibraryConfigDeps {
  readonly credentialStore?: PlatformCredentialStore;
  readonly writeConfig?: (value: StoredRemoteLibraryConfig, configRoot: string) => void;
}

function configPath(configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(configRoot, "remote-library.json");
}

function credentialAccount(configRoot: string): string {
  const digest = createHash("sha256").update(resolve(configRoot)).digest("hex").slice(0, 20);
  return `remote-library:${digest}:${randomUUID()}`;
}

function normalizeRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CLIError("Remote Library URL is invalid.", "INVALID_FLAG");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CLIError("Remote Library URL must use HTTP or HTTPS.", "INVALID_FLAG");
  }
  if (url.username || url.password) {
    throw new CLIError("Remote Library URL must not contain embedded credentials.", "INVALID_FLAG");
  }
  if (url.search || url.hash) {
    throw new CLIError("Remote Library URL must not contain a query or fragment.", "INVALID_FLAG");
  }
  return url.toString().replace(/\/$/, "");
}

function writeStoredConfig(value: StoredRemoteLibraryConfig, configRoot: string): void {
  const path = configPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function runtimeConfig(value: StoredRemoteLibraryConfig, apiKey: string): RemoteLibraryConfig {
  return {
    version: 2,
    url: value.url,
    apiKey,
    preferences: value.preferences,
    credentialProvider: value.credential.provider,
  };
}

function missingConfig(): CLIError {
  return new CLIError(
    "Remote Library is not configured.",
    "FILE_NOT_FOUND",
    "selftune library configure --url <remote-url> --api-key <device-key>",
  );
}

function writeConfigTransaction(
  stored: StoredRemoteLibraryConfig,
  apiKey: string,
  configRoot: string,
  deps: RemoteLibraryConfigDeps,
  previousConfig: StoredRemoteLibraryConfig | null,
): RemoteLibraryConfig {
  const store = deps.credentialStore ?? platformCredentialStore;
  const writeConfig = deps.writeConfig ?? writeStoredConfig;
  const credential = store.set(credentialAccount(configRoot), apiKey, configRoot);
  const next: StoredRemoteLibraryConfig = { ...stored, credential };
  try {
    writeConfig(next, configRoot);
  } catch (cause) {
    try {
      store.delete(credential, configRoot);
    } catch {
      // Preserve the original configuration error; the new credential is unreferenced.
    }
    throw cause;
  }
  const previousCredential = previousConfig?.credential;
  if (previousCredential) {
    try {
      store.delete(previousCredential, configRoot);
    } catch (cause) {
      try {
        writeConfig(previousConfig, configRoot);
        store.delete(credential, configRoot);
      } catch {
        // The new committed configuration remains usable if rollback cleanup fails.
      }
      throw cause;
    }
  }
  return runtimeConfig(next, apiKey);
}

export function loadRemoteLibraryConfig(
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const envUrl = process.env.SELFTUNE_REMOTE_LIBRARY_URL;
  const envKey = process.env.SELFTUNE_REMOTE_LIBRARY_API_KEY;
  if (envUrl && envKey) {
    return {
      version: 2,
      url: normalizeRemoteUrl(envUrl),
      apiKey: envKey,
      preferences: defaultSyncPreferences,
      credentialProvider: "environment",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath(configRoot), "utf8"));
  } catch {
    throw missingConfig();
  }

  const store = deps.credentialStore ?? platformCredentialStore;
  try {
    const stored = Schema.decodeUnknownSync(RemoteLibraryConfigFile)(value);
    const apiKey = store.get(stored.credential, configRoot);
    if (!apiKey) {
      throw new CLIError(
        "Remote Library credentials are missing from the system credential store.",
        "FILE_NOT_FOUND",
        "selftune library configure --url <remote-url> --api-key <device-key>",
      );
    }
    return runtimeConfig(stored, apiKey);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
  }

  try {
    const legacy = Schema.decodeUnknownSync(LegacyRemoteLibraryConfigFile)(value);
    const url = normalizeRemoteUrl(legacy.url);
    const migrated: StoredRemoteLibraryConfig = {
      version: 2,
      url,
      credential: { provider: "file", account: "pending" },
      preferences: legacy.preferences,
    };
    return writeConfigTransaction(migrated, legacy.apiKey, configRoot, deps, null);
  } catch (cause) {
    if (cause instanceof CLIError) throw cause;
    throw missingConfig();
  }
}

export function saveRemoteLibraryConfig(
  input: Omit<RemoteLibraryConfig, "credentialProvider" | "version">,
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new CLIError("Remote Library API key is required.", "MISSING_FLAG");
  if (/[\r\n]/.test(apiKey)) {
    throw new CLIError("Remote Library API key must be a single line.", "INVALID_FLAG");
  }
  const url = normalizeRemoteUrl(input.url);
  const preferences = Schema.decodeUnknownSync(SyncPreferences)(input.preferences);
  const previousConfig = readStoredRemoteLibraryConfig(configRoot);
  const stored: StoredRemoteLibraryConfig = {
    version: 2,
    url,
    credential: { provider: "file", account: "pending" },
    preferences,
  };
  return writeConfigTransaction(stored, apiKey, configRoot, deps, previousConfig);
}

export function remoteLibrarySettings(configRoot = SELFTUNE_CONFIG_DIR): {
  configured: boolean;
  credential_provider: RemoteLibraryConfig["credentialProvider"] | null;
  url: string | null;
  preferences: SyncPreferencesType;
} {
  try {
    const config = loadRemoteLibraryConfig(configRoot);
    return {
      configured: true,
      url: config.url,
      preferences: config.preferences,
      credential_provider: config.credentialProvider,
    };
  } catch {
    return {
      configured: false,
      url: null,
      preferences: defaultSyncPreferences,
      credential_provider: null,
    };
  }
}

export function updateRemoteLibraryConfig(
  input: { url: string; api_key?: string; preferences: SyncPreferencesType },
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  let existingKey: string | null = null;
  try {
    existingKey = loadRemoteLibraryConfig(configRoot, deps).apiKey;
  } catch {
    // A new connection must provide a key.
  }
  const apiKey = input.api_key?.trim() || existingKey;
  if (!apiKey) throw new CLIError("Remote Library API key is required.", "MISSING_FLAG");
  const preferences = Schema.decodeUnknownSync(SyncPreferences)(input.preferences);
  return saveRemoteLibraryConfig({ url: input.url, apiKey, preferences }, configRoot, deps);
}

export function storedRemoteLibraryCredential(
  configRoot = SELFTUNE_CONFIG_DIR,
): CredentialReference | null {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(configRoot), "utf8"));
    return Schema.decodeUnknownSync(RemoteLibraryConfigFile)(value).credential;
  } catch {
    return null;
  }
}

function readStoredRemoteLibraryConfig(configRoot: string): StoredRemoteLibraryConfig | null {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(configRoot), "utf8"));
    return Schema.decodeUnknownSync(RemoteLibraryConfigFile)(value);
  } catch {
    return null;
  }
}
