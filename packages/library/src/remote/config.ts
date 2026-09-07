import {
  defaultSyncPreferences,
  SyncPreferences,
  type SyncPreferences as SyncPreferencesType,
} from "@selftune/control-plane";
import * as Schema from "effect/Schema";

import { LibraryError } from "../errors.js";

export const CredentialProvider = Schema.Literals([
  "macos-keychain",
  "linux-secret-service",
  "windows-credential-manager",
  "file",
]);
export type CredentialProvider = typeof CredentialProvider.Type;

export interface CredentialReference {
  readonly account: string;
  readonly provider: CredentialProvider;
}

export const LegacyRemoteLibraryConfigFile = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  apiKey: Schema.String,
  preferences: SyncPreferences,
});
export type LegacyRemoteLibraryConfig = typeof LegacyRemoteLibraryConfigFile.Type;

export const RemoteLibraryConfigFile = Schema.Struct({
  version: Schema.Literal(2),
  url: Schema.String,
  credential: Schema.Struct({
    provider: CredentialProvider,
    account: Schema.String,
  }),
  preferences: SyncPreferences,
});
export type StoredRemoteLibraryConfig = typeof RemoteLibraryConfigFile.Type;

export interface RemoteLibraryConfig {
  readonly apiKey: string;
  readonly credentialProvider: CredentialProvider | "environment";
  readonly preferences: SyncPreferencesType;
  readonly url: string;
  readonly version: 2;
}

export interface RemoteLibraryEnvironment {
  readonly apiKey?: string;
  readonly url?: string;
}

export function normalizeRemoteLibraryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LibraryError("Sync & Backup URL is invalid.", "INVALID_FLAG");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LibraryError("Sync & Backup URL must use HTTP or HTTPS.", "INVALID_FLAG");
  }
  if (url.username || url.password) {
    throw new LibraryError(
      "Sync & Backup URL must not contain embedded credentials.",
      "INVALID_FLAG",
    );
  }
  if (url.search || url.hash) {
    throw new LibraryError(
      "Sync & Backup URL must not contain a query or fragment.",
      "INVALID_FLAG",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizeRemoteLibraryApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) throw new LibraryError("Sync & Backup API key is required.", "MISSING_FLAG");
  if (/[\r\n]/.test(apiKey)) {
    throw new LibraryError("Sync & Backup API key must be a single line.", "INVALID_FLAG");
  }
  return apiKey;
}

export const decodeStoredRemoteLibraryConfig = Schema.decodeUnknownSync(RemoteLibraryConfigFile);
export const decodeLegacyRemoteLibraryConfig = Schema.decodeUnknownSync(
  LegacyRemoteLibraryConfigFile,
);
export const decodeSyncPreferences = Schema.decodeUnknownSync(SyncPreferences);

export function makeRemoteLibraryConfig(
  stored: StoredRemoteLibraryConfig,
  apiKey: string,
): RemoteLibraryConfig {
  return {
    version: 2,
    url: stored.url,
    apiKey,
    preferences: stored.preferences,
    credentialProvider: stored.credential.provider,
  };
}

export function remoteLibraryConfigFromEnvironment(
  environment: RemoteLibraryEnvironment,
): RemoteLibraryConfig | null {
  if (!environment.url || !environment.apiKey) return null;
  return {
    version: 2,
    url: normalizeRemoteLibraryUrl(environment.url),
    apiKey: normalizeRemoteLibraryApiKey(environment.apiKey),
    preferences: defaultSyncPreferences,
    credentialProvider: "environment",
  };
}
