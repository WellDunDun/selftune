import { FEATURE_KEYS, type DashboardFeatureFlags, type DashboardHostKind } from "./capabilities";
import {
  createManagedServerProfile,
  createServerProfileController,
  createThisMacProfile,
  normalizeServerProfiles,
  serializeManagedServerProfiles,
  type ServerProfile,
  type ServerProfileStatus,
} from "./server-profiles";

export const SERVER_PROFILES_STORAGE_KEY = "selftune.server-profiles.v1";
export const SERVER_PROFILES_HANDOFF_PARAM = "selftune_profile_handoff";
export const SERVER_PROFILE_CONTRACT_PATH = "/api/server-profile";

const MAX_HANDOFF_BYTES = 16_384;

export interface ServerRuntimeProfile {
  readonly schemaVersion: 1;
  readonly host: DashboardHostKind;
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly authentication: "cookie" | "desktop_local";
  };
}

export type BrowserServerProfileNavigation =
  | {
      readonly mode: "same_window";
      readonly navigate: (url: string) => void;
    }
  | {
      readonly mode: "external";
      readonly navigate: (url: string) => void | Promise<void>;
    };

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function requiredString(value: object, key: string): string {
  const candidate = property(value, key);
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`Server profile contract field ${key} must be a non-empty string.`);
  }
  return candidate;
}

export function decodeServerRuntimeProfile(value: unknown): ServerRuntimeProfile {
  if (typeof value !== "object" || value === null || property(value, "schema_version") !== 1) {
    throw new TypeError("This server does not expose the SelfTune profile contract.");
  }
  const host = property(value, "host");
  if (host !== "local" && host !== "cloud" && host !== "selfhost") {
    throw new TypeError("This server reports an unsupported dashboard host.");
  }
  const rawProfile = property(value, "profile");
  if (typeof rawProfile !== "object" || rawProfile === null) {
    throw new TypeError("This server profile contract is missing its profile.");
  }
  const id = requiredString(rawProfile, "id");
  const name = requiredString(rawProfile, "name");
  const origin = new URL(requiredString(rawProfile, "origin")).origin;
  const authentication = property(rawProfile, "authentication");
  if (authentication !== "cookie" && authentication !== "desktop_local") {
    throw new TypeError("This server reports an unsupported authentication method.");
  }
  if (
    (host === "local" && (id !== "local:this-mac" || authentication !== "desktop_local")) ||
    (host === "cloud" && (id !== "cloud:selftune" || authentication !== "cookie")) ||
    (host === "selfhost" && (!id.startsWith("selfhost:") || authentication !== "cookie"))
  ) {
    throw new TypeError("This server profile identity does not match its host kind.");
  }
  return {
    schemaVersion: 1,
    host,
    profile: { id, name, origin, authentication },
  };
}

export async function fetchServerRuntimeProfile(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
): Promise<ServerRuntimeProfile> {
  const response = await fetchImpl(new URL(SERVER_PROFILE_CONTRACT_PATH, origin), {
    credentials: "include",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new TypeError(`The dashboard host contract returned HTTP ${response.status}.`);
  }
  return decodeServerRuntimeProfile(await response.json());
}

function parsePersistedProfiles(
  value: unknown,
  fallbackCapabilities: DashboardFeatureFlags,
): ServerProfile[] {
  if (!Array.isArray(value)) return [];

  const profiles: ServerProfile[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const id = property(candidate, "id");
    const kind = property(candidate, "kind");
    const name = property(candidate, "name");
    const origin = property(candidate, "origin");
    if (
      typeof id !== "string" ||
      (kind !== "cloud" && kind !== "selfhost") ||
      typeof name !== "string" ||
      typeof origin !== "string"
    ) {
      continue;
    }

    const persistedCapabilities = property(candidate, "capabilities");
    const capabilities = { ...fallbackCapabilities };
    if (typeof persistedCapabilities === "object" && persistedCapabilities !== null) {
      for (const key of FEATURE_KEYS) {
        const flag = property(persistedCapabilities, key);
        if (typeof flag === "boolean") capabilities[key] = flag;
      }
    }

    try {
      profiles.push(
        createManagedServerProfile({
          id,
          kind,
          name,
          origin,
          authentication: kind === "cloud" ? { kind: "cookie" } : { kind: "bearer_session" },
          capabilities,
          status: {
            state: "unreachable",
            message: "This server has not been checked in this session.",
            actionLabel: "Test server",
          },
        }),
      );
    } catch {
      // Ignore tampered, insecure, and obsolete profile records.
    }
  }
  return profiles;
}

export function consumeServerProfilesHandoff(
  rawUrl: string,
  fallbackCapabilities: DashboardFeatureFlags,
): { readonly cleanUrl: string; readonly serialized: string } | null {
  const url = new URL(rawUrl);
  const handoff = url.searchParams.get(SERVER_PROFILES_HANDOFF_PARAM);
  if (!handoff) return null;
  url.searchParams.delete(SERVER_PROFILES_HANDOFF_PARAM);
  if (new TextEncoder().encode(handoff).byteLength > MAX_HANDOFF_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(handoff);
  } catch {
    return null;
  }
  const profiles = parsePersistedProfiles(parsed, fallbackCapabilities);
  if (profiles.length === 0) return null;
  return { cleanUrl: url.toString(), serialized: serializeManagedServerProfiles(profiles) };
}

function statusForResponse(response: Response): ServerProfileStatus {
  if (response.status === 401 || response.status === 403) {
    return {
      state: "unauthenticated",
      message: "Authentication is required.",
      actionLabel: "Enter API key",
    };
  }
  if (response.status === 426) {
    return {
      state: "upgrade_required",
      message: "This server must be upgraded.",
      actionLabel: "Upgrade server",
    };
  }
  return {
    state: "incompatible",
    message: `This server returned HTTP ${response.status}.`,
    actionLabel: "Review server",
  };
}

function incompatibleProfile(profile: ServerProfile, message: string): ServerProfile {
  return {
    ...profile,
    status: { state: "incompatible", message, actionLabel: "Review server" },
  };
}

function profileForCurrentRuntime(
  runtime: ServerRuntimeProfile | undefined,
  capabilities: DashboardFeatureFlags,
): { readonly currentServer?: ServerProfile; readonly thisMac?: ServerProfile } {
  if (!runtime) return {};
  if (runtime.host === "local") {
    return {
      thisMac: createThisMacProfile({ origin: runtime.profile.origin, capabilities }),
    };
  }
  if (runtime.host === "selfhost") {
    return {
      currentServer: createManagedServerProfile({
        id: runtime.profile.id,
        kind: "selfhost",
        name: runtime.profile.name,
        origin: runtime.profile.origin,
        authentication: { kind: "bearer_session" },
        capabilities,
      }),
    };
  }
  return {};
}

function handoffPath(response: unknown): string {
  if (typeof response !== "object" || response === null) {
    throw new TypeError("The Self-host session handoff response is invalid.");
  }
  const value = property(response, "handoff_path");
  if (typeof value !== "string" || !value.startsWith("/api/auth/session/handoff?")) {
    throw new TypeError("The Self-host session handoff response is invalid.");
  }
  return value;
}

export function createBrowserServerProfileController(options: {
  readonly origin: string;
  readonly capabilities: DashboardFeatureFlags;
  readonly runtime?: ServerRuntimeProfile;
  readonly load: () => string | null;
  readonly persist: (serialized: string) => void;
  readonly clearHostState: () => void | Promise<void>;
  readonly currentPath?: () => string;
  readonly navigation: BrowserServerProfileNavigation;
  readonly fetch: typeof globalThis.fetch;
}) {
  const credentials = new Map<string, string>();
  let persisted: unknown = [];
  try {
    persisted = JSON.parse(options.load() ?? "[]");
  } catch {
    persisted = [];
  }
  const { currentServer, thisMac } = profileForCurrentRuntime(
    options.runtime,
    options.capabilities,
  );
  const cloud = createManagedServerProfile({
    id: "cloud:selftune",
    kind: "cloud",
    name: "SelfTune Cloud",
    origin: "https://app.selftune.dev",
    authentication: { kind: "cookie" },
    capabilities: options.capabilities,
    status:
      options.origin === "https://app.selftune.dev"
        ? { state: "ready" }
        : { state: "unreachable", message: "Not checked yet.", actionLabel: "Test server" },
  });
  const requiredProfiles = [cloud, ...(currentServer ? [currentServer] : [])];
  const initial = normalizeServerProfiles(
    [...parsePersistedProfiles(persisted, options.capabilities), ...requiredProfiles].filter(
      (profile, index, profiles) =>
        profiles.findIndex((candidate) => candidate.id === profile.id) === index,
    ),
    thisMac,
  );

  const validate = async (profile: ServerProfile): Promise<ServerProfile> => {
    if (profile.system) return profile;
    try {
      const credential = credentials.get(profile.id);
      const response = await options.fetch(new URL(SERVER_PROFILE_CONTRACT_PATH, profile.origin), {
        credentials: credential ? "omit" : profile.origin === options.origin ? "include" : "omit",
        headers: credential ? { Authorization: `Bearer ${credential}` } : undefined,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { ...profile, status: statusForResponse(response) };
      let runtime: ServerRuntimeProfile;
      try {
        runtime = decodeServerRuntimeProfile(await response.json());
      } catch (cause) {
        return incompatibleProfile(
          profile,
          cause instanceof Error ? cause.message : "This is not a compatible SelfTune server.",
        );
      }
      if (runtime.host !== profile.kind || runtime.profile.origin !== profile.origin) {
        return incompatibleProfile(profile, "The server identity does not match this profile.");
      }
      return { ...profile, status: { state: "ready" } };
    } catch {
      return {
        ...profile,
        status: {
          state: "unreachable",
          message: "The server could not be reached.",
          actionLabel: "Test again",
        },
      };
    }
  };

  const controller = createServerProfileController({
    initialProfiles: initial,
    activeProfileId:
      thisMac?.origin === options.origin
        ? thisMac.id
        : (initial.find((profile) => profile.origin === options.origin)?.id ?? null),
    thisMac,
    persist: options.persist,
    setSessionCredential: (id, credential) => credentials.set(id, credential),
    validate,
    switchProfile: async (profile) => {
      const serialized = serializeManagedServerProfiles(controller.snapshot().profiles);
      const currentPath = options.currentPath?.() ?? "/";
      const destination = new URL(currentPath, profile.origin);
      destination.searchParams.set(SERVER_PROFILES_HANDOFF_PARAM, serialized);

      if (profile.kind === "selfhost" && profile.origin !== options.origin) {
        const credential = credentials.get(profile.id);
        if (!credential) {
          throw new TypeError("Enter this Self-host server's API key before switching.");
        }
        const response = await options.fetch(new URL("/api/auth/session/handoff", profile.origin), {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          throw new TypeError(`Session handoff failed with HTTP ${response.status}.`);
        const handoff = new URL(handoffPath(await response.json()), profile.origin);
        handoff.searchParams.set("return_to", `${destination.pathname}${destination.search}`);
        destination.href = handoff.href;
      }

      if (options.navigation.mode === "external") {
        await options.navigation.navigate(destination.toString());
        return "opened_external";
      }
      await options.clearHostState();
      options.navigation.navigate(destination.toString());
      return "activated";
    },
  });

  return {
    ...controller,
    reconcileExternal(serialized: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        controller.reconcileExternal(serialized);
        return;
      }
      if (!Array.isArray(parsed)) {
        controller.reconcileExternal(serialized);
        return;
      }
      const ids = new Set(
        parsed.flatMap((candidate) => {
          if (typeof candidate !== "object" || candidate === null) return [];
          const id = property(candidate, "id");
          return typeof id === "string" ? [id] : [];
        }),
      );
      controller.reconcileExternal(
        JSON.stringify([...parsed, ...requiredProfiles.filter((profile) => !ids.has(profile.id))]),
      );
    },
  };
}
