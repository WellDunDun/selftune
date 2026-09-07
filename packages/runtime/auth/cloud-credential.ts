import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  SELFTUNE_CONFIG_PATH,
  writeConfigSync,
  type AlphaIdentity,
  type SelftuneConfig,
} from "@selftune/config";

import {
  asyncPlatformCredentialStore,
  platformCredentialStore,
  type AsyncPlatformCredentialStore,
  type CredentialReference,
  type PlatformCredentialStore,
} from "../credential-store.js";

export interface CloudCredentialDependencies {
  readonly configPath?: string;
  readonly configRoot?: string;
  readonly credentialStore?: PlatformCredentialStore;
  readonly writeConfig?: (path: string, config: SelftuneConfig) => void;
}

export interface AsyncCloudCredentialDependencies extends Omit<
  CloudCredentialDependencies,
  "credentialStore"
> {
  readonly credentialStore?: AsyncPlatformCredentialStore;
}

export interface PersistedCloudCredential {
  readonly config: SelftuneConfig;
  readonly credential: CredentialReference;
  readonly replaced: boolean;
}

function credentialAccount(configRoot: string): string {
  const digest = createHash("sha256").update(resolve(configRoot)).digest("hex").slice(0, 20);
  return `alpha:${digest}:${randomUUID()}`;
}

function resolveDependencies(deps: CloudCredentialDependencies) {
  const configPath = deps.configPath ?? SELFTUNE_CONFIG_PATH;
  return {
    configPath,
    configRoot: deps.configRoot ?? dirname(configPath),
    store: deps.credentialStore ?? platformCredentialStore,
    write: deps.writeConfig ?? writeConfigSync,
  };
}

export function persistCloudCredential(
  config: SelftuneConfig,
  apiKey: string,
  deps: CloudCredentialDependencies = {},
): PersistedCloudCredential {
  if (!config.alpha) throw new Error("Cannot persist a cloud credential without alpha identity.");

  const { configPath, configRoot, store, write } = resolveDependencies(deps);
  const previousConfig = structuredClone(config);
  const previousCredential = config.alpha.credential;
  const credential = store.set(credentialAccount(configRoot), apiKey, configRoot);
  const next = structuredClone(config);
  const nextAlpha: AlphaIdentity = { ...config.alpha, credential };
  delete nextAlpha.api_key;
  next.alpha = nextAlpha;

  try {
    write(configPath, next);
  } catch (cause) {
    try {
      store.delete(credential, configRoot);
    } catch {
      // Preserve the configuration error; the staged credential is unreferenced.
    }
    throw cause;
  }

  if (previousCredential) {
    try {
      store.delete(previousCredential, configRoot);
    } catch (cause) {
      try {
        write(configPath, previousConfig);
        store.delete(credential, configRoot);
      } catch {
        // The newly committed reference remains usable if rollback cleanup fails.
      }
      throw cause;
    }
  }

  return {
    config: next,
    credential,
    replaced: Boolean(previousCredential || config.alpha.api_key),
  };
}

export async function persistCloudCredentialAsync(
  config: SelftuneConfig,
  apiKey: string,
  deps: AsyncCloudCredentialDependencies = {},
): Promise<PersistedCloudCredential> {
  if (!config.alpha) throw new Error("Cannot persist a cloud credential without alpha identity.");

  const configPath = deps.configPath ?? SELFTUNE_CONFIG_PATH;
  const configRoot = deps.configRoot ?? dirname(configPath);
  const store = deps.credentialStore ?? asyncPlatformCredentialStore;
  const write = deps.writeConfig ?? writeConfigSync;
  const previousConfig = structuredClone(config);
  const previousCredential = config.alpha.credential;
  const credential = await store.set(credentialAccount(configRoot), apiKey, configRoot);
  const next = structuredClone(config);
  const nextAlpha: AlphaIdentity = { ...config.alpha, credential };
  delete nextAlpha.api_key;
  next.alpha = nextAlpha;

  try {
    write(configPath, next);
  } catch (cause) {
    try {
      await store.delete(credential, configRoot);
    } catch {
      // Preserve the configuration error; the staged credential is unreferenced.
    }
    throw cause;
  }

  if (previousCredential) {
    try {
      await store.delete(previousCredential, configRoot);
    } catch (cause) {
      try {
        write(configPath, previousConfig);
        await store.delete(credential, configRoot);
      } catch {
        // The newly committed reference remains usable if rollback cleanup fails.
      }
      throw cause;
    }
  }

  return {
    config: next,
    credential,
    replaced: Boolean(previousCredential || config.alpha.api_key),
  };
}

export function resolveCloudCredential(
  config: SelftuneConfig | null,
  deps: CloudCredentialDependencies = {},
): string | null {
  const alpha = config?.alpha;
  if (!alpha) return null;

  const { configRoot, store } = resolveDependencies(deps);
  if (alpha.credential) return store.get(alpha.credential, configRoot)?.trim() || null;

  const legacyKey = alpha.api_key?.trim();
  if (!legacyKey || !config) return null;
  persistCloudCredential(config, legacyKey, deps);
  return legacyKey;
}

export function hasCloudCredentialMetadata(identity: AlphaIdentity | null): boolean {
  const legacyKey = identity?.api_key?.trim();
  return Boolean(
    identity?.credential || legacyKey?.startsWith("st_live_") || legacyKey?.startsWith("st_test_"),
  );
}

export function separateInlineCloudCredential(identity: AlphaIdentity) {
  const copy = structuredClone(identity);
  const apiKey = copy.api_key?.trim() || null;
  delete copy.api_key;
  return { identity: copy, apiKey } as const;
}
