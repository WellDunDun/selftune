import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { defaultSyncPreferences, type SyncPreferences } from "@selftune/control-plane";
import { loadConfigSync } from "@selftune/config";
import {
  decodeLegacyRemoteLibraryConfig,
  decodeStoredRemoteLibraryConfig,
  decodeSyncPreferences,
  makeRemoteLibraryConfig,
  normalizeRemoteLibraryApiKey,
  normalizeRemoteLibraryUrl,
  remoteLibraryConfigFromEnvironment,
  type RemoteLibraryConfig,
  type RemoteLibraryEnvironment,
  type StoredRemoteLibraryConfig,
} from "@selftune/library/remote/config";
import { LibraryError } from "@selftune/library/errors";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { resolveCloudCredential } from "../auth/cloud-credential.js";
import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";
import {
  platformCredentialStore,
  type CredentialReference,
  type PlatformCredentialStore,
} from "../credential-store.js";

export type { RemoteLibraryConfig } from "@selftune/library/remote/config";

export interface RemoteLibraryConfigDeps {
  readonly credentialStore?: PlatformCredentialStore;
  readonly environment?: RemoteLibraryEnvironment;
  readonly writeConfig?: (value: StoredRemoteLibraryConfig, configRoot: string) => void;
}

function configPath(configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(configRoot, "remote-library.json");
}

function cloudPreferencesPath(configRoot = SELFTUNE_CONFIG_DIR): string {
  return join(configRoot, "cloud-remote-library.json");
}

function credentialAccount(configRoot: string): string {
  const digest = createHash("sha256").update(resolve(configRoot)).digest("hex").slice(0, 20);
  return `remote-library:${digest}:${randomUUID()}`;
}

function writeStoredConfig(value: StoredRemoteLibraryConfig, configRoot: string): void {
  const path = configPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function loadCloudPreferences(configRoot: string): SyncPreferences {
  try {
    const value: unknown = JSON.parse(readFileSync(cloudPreferencesPath(configRoot), "utf8"));
    return decodeSyncPreferences(value);
  } catch {
    return defaultSyncPreferences;
  }
}

function writeCloudPreferences(preferences: SyncPreferences, configRoot: string): void {
  const path = cloudPreferencesPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function missingConfig(): LibraryError {
  return new LibraryError(
    "Sync & Backup is not configured.",
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
  return makeRemoteLibraryConfig(next, apiKey);
}

function processEnvironment(): RemoteLibraryEnvironment {
  return {
    url: process.env.SELFTUNE_REMOTE_LIBRARY_URL,
    apiKey: process.env.SELFTUNE_REMOTE_LIBRARY_API_KEY,
  };
}

export function loadRemoteLibraryConfig(
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const environmentConfig = remoteLibraryConfigFromEnvironment(
    deps.environment ?? processEnvironment(),
  );
  if (environmentConfig) return environmentConfig;

  const explicitConfigPath = configPath(configRoot);
  if (!existsSync(explicitConfigPath)) {
    const selftuneConfigPath = join(configRoot, "config.json");
    const selftuneConfig = loadConfigSync(selftuneConfigPath);
    if (!selftuneConfig?.alpha?.enrolled) throw missingConfig();
    const apiKey = resolveCloudCredential(selftuneConfig, {
      configPath: selftuneConfigPath,
      configRoot,
      credentialStore: deps.credentialStore,
    });
    if (!apiKey) throw missingConfig();
    const migratedConfig = loadConfigSync(selftuneConfigPath);
    const alpha = migratedConfig?.alpha ?? selftuneConfig.alpha;
    return {
      version: 2,
      url: normalizeRemoteLibraryUrl(alpha.cloud_api_url ?? DEFAULT_CLOUD_API_URL),
      apiKey,
      preferences: loadCloudPreferences(configRoot),
      credentialProvider: alpha.credential?.provider ?? "file",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(explicitConfigPath, "utf8"));
  } catch {
    throw missingConfig();
  }

  const store = deps.credentialStore ?? platformCredentialStore;
  try {
    const stored = decodeStoredRemoteLibraryConfig(value);
    const apiKey = store.get(stored.credential, configRoot);
    if (!apiKey) {
      throw new LibraryError(
        "Sync & Backup credentials are missing from the system credential store.",
        "FILE_NOT_FOUND",
        "selftune library configure --url <remote-url> --api-key <device-key>",
      );
    }
    return makeRemoteLibraryConfig(stored, apiKey);
  } catch (cause) {
    if (cause instanceof LibraryError) throw cause;
  }

  try {
    const legacy = decodeLegacyRemoteLibraryConfig(value);
    const url = normalizeRemoteLibraryUrl(legacy.url);
    const migrated: StoredRemoteLibraryConfig = {
      version: 2,
      url,
      credential: { provider: "file", account: "pending" },
      preferences: legacy.preferences,
    };
    return writeConfigTransaction(migrated, legacy.apiKey, configRoot, deps, null);
  } catch (cause) {
    if (cause instanceof LibraryError) throw cause;
    throw missingConfig();
  }
}

export function saveRemoteLibraryConfig(
  input: Omit<RemoteLibraryConfig, "credentialProvider" | "version">,
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const apiKey = normalizeRemoteLibraryApiKey(input.apiKey);
  const url = normalizeRemoteLibraryUrl(input.url);
  const preferences = decodeSyncPreferences(input.preferences);
  const previousConfig = readStoredRemoteLibraryConfig(configRoot);
  const stored: StoredRemoteLibraryConfig = {
    version: 2,
    url,
    credential: { provider: "file", account: "pending" },
    preferences,
  };
  return writeConfigTransaction(stored, apiKey, configRoot, deps, previousConfig);
}

export function remoteLibrarySettings(
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): {
  configured: boolean;
  credential_provider: RemoteLibraryConfig["credentialProvider"] | null;
  url: string | null;
  preferences: SyncPreferences;
} {
  try {
    const config = loadRemoteLibraryConfig(configRoot, deps);
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
  input: { url: string; api_key?: string; preferences: SyncPreferences },
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const url = normalizeRemoteLibraryUrl(input.url);
  if (url === normalizeRemoteLibraryUrl(DEFAULT_CLOUD_API_URL) && !input.api_key?.trim()) {
    return activateCloudRemoteLibraryConfig(input.preferences, configRoot, deps);
  }
  let existingKey: string | null = null;
  try {
    const existing = loadRemoteLibraryConfig(configRoot, deps);
    if (normalizeRemoteLibraryUrl(existing.url) === url) existingKey = existing.apiKey;
  } catch {
    // A new connection must provide a key.
  }
  const apiKey = input.api_key?.trim() || existingKey;
  if (!apiKey) throw new LibraryError("Sync & Backup API key is required.", "MISSING_FLAG");
  const preferences = decodeSyncPreferences(input.preferences);
  return saveRemoteLibraryConfig({ url: input.url, apiKey, preferences }, configRoot, deps);
}

/** Select the linked Cloud account as the Sync & Backup credential source. */
export function activateCloudRemoteLibraryConfig(
  preferences: SyncPreferences,
  configRoot = SELFTUNE_CONFIG_DIR,
  deps: RemoteLibraryConfigDeps = {},
): RemoteLibraryConfig {
  const decodedPreferences = decodeSyncPreferences(preferences);
  const selftuneConfigPath = join(configRoot, "config.json");
  const selftuneConfig = loadConfigSync(selftuneConfigPath);
  if (!selftuneConfig?.alpha?.enrolled) {
    throw new LibraryError(
      "Connect a SelfTune Cloud account before selecting SelfTune Cloud.",
      "OPERATION_FAILED",
    );
  }
  const apiKey = resolveCloudCredential(selftuneConfig, {
    configPath: selftuneConfigPath,
    configRoot,
    credentialStore: deps.credentialStore,
  });
  if (!apiKey) {
    throw new LibraryError(
      "The linked SelfTune Cloud credential is missing.",
      "OPERATION_FAILED",
      "Reconnect the Cloud account from Desktop Settings.",
    );
  }

  writeCloudPreferences(decodedPreferences, configRoot);
  const explicitPath = configPath(configRoot);
  if (existsSync(explicitPath)) {
    const backupPath = `${explicitPath}.switch-to-cloud-${process.pid}`;
    const previousCredential = storedRemoteLibraryCredential(configRoot);
    renameSync(explicitPath, backupPath);
    try {
      if (previousCredential) {
        (deps.credentialStore ?? platformCredentialStore).delete(previousCredential, configRoot);
      }
      rmSync(backupPath, { force: true });
    } catch (cause) {
      renameSync(backupPath, explicitPath);
      throw cause;
    }
  }

  const migratedConfig = loadConfigSync(selftuneConfigPath);
  const alpha = migratedConfig?.alpha ?? selftuneConfig.alpha;
  return {
    version: 2,
    url: normalizeRemoteLibraryUrl(alpha.cloud_api_url ?? DEFAULT_CLOUD_API_URL),
    apiKey,
    preferences: decodedPreferences,
    credentialProvider: alpha.credential?.provider ?? "file",
  };
}

export function storedRemoteLibraryCredential(
  configRoot = SELFTUNE_CONFIG_DIR,
): CredentialReference | null {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(configRoot), "utf8"));
    return decodeStoredRemoteLibraryConfig(value).credential;
  } catch {
    return null;
  }
}

function readStoredRemoteLibraryConfig(configRoot: string): StoredRemoteLibraryConfig | null {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(configRoot), "utf8"));
    return decodeStoredRemoteLibraryConfig(value);
  } catch {
    return null;
  }
}
