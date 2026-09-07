import { z } from "zod";
import { FEATURE_KEYS, type DashboardFeatureFlags } from "./capabilities";
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

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);
const runtimeProfileSchema = z
  .object({
    schema_version: z.literal(1),
    host: z.enum(["local", "cloud", "selfhost"]),
    profile: z.object({
      id: nonEmptyString,
      name: nonEmptyString,
      origin: z.url().transform((value) => new URL(value).origin),
      authentication: z.enum(["cookie", "desktop_local"]),
    }),
  })
  .refine(({ host, profile }) => {
    if (host === "local")
      return profile.id === "local:this-mac" && profile.authentication === "desktop_local";
    if (host === "cloud")
      return profile.id === "cloud:selftune" && profile.authentication === "cookie";
    return profile.id.startsWith("selfhost:") && profile.authentication === "cookie";
  }, "This server profile identity does not match its host kind.")
  .transform(({ schema_version, host, profile }) => ({
    schemaVersion: schema_version,
    host,
    profile,
  }));

export type ServerRuntimeProfile = z.output<typeof runtimeProfileSchema>;
export const decodeServerRuntimeProfile = runtimeProfileSchema.parse;

const persistedFlag = z.boolean().optional().catch(undefined);
const persistedProfileSchema = z.object({
  id: z.string(),
  kind: z.enum(["cloud", "selfhost"]),
  name: z.string(),
  origin: z.string(),
  capabilities: z
    .object({
      analytics: persistedFlag,
      registry: persistedFlag,
      signals: persistedFlag,
      proposals: persistedFlag,
      billing: persistedFlag,
      teamAdmin: persistedFlag,
      runtimeStatus: persistedFlag,
    })
    .catch({}),
});
const persistedProfilesSchema = z.array(persistedProfileSchema.nullable().catch(null));
const handoffPath = z
  .object({
    handoff_path: z.string().startsWith("/api/auth/session/handoff?"),
  })
  .transform((response) => response.handoff_path).parse;

export type BrowserServerProfileNavigation =
  | {
      readonly mode: "same_window";
      readonly navigate: (url: string) => void;
    }
  | {
      readonly mode: "external";
      readonly navigate: (url: string) => void | Promise<void>;
    };

export type BrowserProfileFetch = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export async function fetchServerRuntimeProfile(
  fetchImpl: BrowserProfileFetch,
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
  serialized: string,
  fallbackCapabilities: DashboardFeatureFlags,
): ServerProfile[] {
  const candidates = persistedProfilesSchema.parse(JSON.parse(serialized));

  const profiles: ServerProfile[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const { id, kind, name, origin, capabilities: persistedCapabilities } = candidate;
    const capabilities = { ...fallbackCapabilities };
    for (const key of FEATURE_KEYS) {
      const flag = persistedCapabilities[key];
      if (flag !== undefined) capabilities[key] = flag;
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
  try {
    const profiles = parsePersistedProfiles(handoff, fallbackCapabilities);
    if (profiles.length === 0) return null;
    return { cleanUrl: url.toString(), serialized: serializeManagedServerProfiles(profiles) };
  } catch {
    return null;
  }
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
) {
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

export function createBrowserServerProfileController(options: {
  readonly origin: string;
  readonly capabilities: DashboardFeatureFlags;
  readonly runtime?: ServerRuntimeProfile;
  readonly load: () => string | null;
  readonly persist: (serialized: string) => void;
  readonly clearHostState: () => void | Promise<void>;
  readonly currentPath?: () => string;
  readonly navigation: BrowserServerProfileNavigation;
  readonly fetch: BrowserProfileFetch;
}) {
  const credentials = new Map<string, string>();
  let persisted: ServerProfile[] = [];
  try {
    persisted = parsePersistedProfiles(options.load() ?? "[]", options.capabilities);
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
    [...persisted, ...requiredProfiles].filter(
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
      let profiles: ServerProfile[];
      try {
        profiles = parsePersistedProfiles(serialized, options.capabilities);
      } catch {
        return;
      }
      const ids = new Set(profiles.map((profile) => profile.id));
      controller.reconcileExternal(
        JSON.stringify([
          ...profiles,
          ...requiredProfiles.filter((profile) => !ids.has(profile.id)),
        ]),
      );
    },
  };
}
