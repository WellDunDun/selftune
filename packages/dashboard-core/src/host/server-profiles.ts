import type { DashboardFeatureFlags, DashboardHostKind } from "./capabilities";
import { z } from "zod";

export type ServerProfileAuthentication =
  | { readonly kind: "desktop_local" }
  | { readonly kind: "cookie" }
  | { readonly kind: "bearer_session" };

export type ServerProfileStatus =
  | { readonly state: "ready" }
  | {
      readonly state: "unreachable" | "unauthenticated" | "incompatible" | "upgrade_required";
      readonly message: string;
      readonly actionLabel: string;
      readonly actionHref?: string;
    };

export interface ServerProfile {
  readonly id: string;
  readonly kind: DashboardHostKind;
  readonly name: string;
  readonly origin: string;
  readonly authentication: ServerProfileAuthentication;
  readonly capabilities: DashboardFeatureFlags;
  readonly status: ServerProfileStatus;
  readonly system: boolean;
}

const serializedProfileSchema = z.object({
  id: z.string(),
  kind: z.enum(["local", "cloud", "selfhost"]),
  name: z.string(),
  origin: z.string(),
  authentication: z.object({ kind: z.enum(["desktop_local", "cookie", "bearer_session"]) }),
  capabilities: z.object({
    analytics: z.boolean(),
    registry: z.boolean(),
    signals: z.boolean(),
    proposals: z.boolean(),
    billing: z.boolean(),
    teamAdmin: z.boolean(),
    runtimeStatus: z.boolean(),
  }),
  status: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready") }),
    z.object({
      state: z.enum(["unreachable", "unauthenticated", "incompatible", "upgrade_required"]),
      message: z.string(),
      actionLabel: z.string(),
      actionHref: z.string().optional(),
    }),
  ]),
  system: z.boolean(),
}) satisfies z.ZodType<ServerProfile>;
const serializedProfilesSchema = z.array(serializedProfileSchema.nullable().catch(null));

export interface ManagedServerProfileInput {
  readonly id: string;
  readonly kind: Extract<DashboardHostKind, "cloud" | "selfhost">;
  readonly name: string;
  readonly origin: string;
  readonly authentication: Exclude<ServerProfileAuthentication, { kind: "desktop_local" }>;
  readonly capabilities: DashboardFeatureFlags;
  readonly status?: ServerProfileStatus;
}

type ManagedServerProfile = ServerProfile & {
  readonly kind: Extract<DashboardHostKind, "cloud" | "selfhost">;
  readonly authentication: Exclude<ServerProfileAuthentication, { kind: "desktop_local" }>;
  readonly system: false;
};

export class ProfileMutationError extends Error {
  readonly code:
    | "INVALID_PROFILE"
    | "PROFILE_NOT_FOUND"
    | "SYSTEM_PROFILE_PROTECTED"
    | "PROFILE_ID_RESERVED";

  constructor(code: ProfileMutationError["code"], message: string) {
    super(message);
    this.name = "ProfileMutationError";
    this.code = code;
  }
}

export const THIS_MAC_PROFILE_ID = "local:this-mac";

function normalizeOrigin(value: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfileMutationError("INVALID_PROFILE", "Enter a valid server URL.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && loopback)) {
    throw new ProfileMutationError("INVALID_PROFILE", "Server profiles require HTTPS.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function createThisMacProfile(input: {
  readonly origin: string;
  readonly capabilities: DashboardFeatureFlags;
}): ServerProfile {
  return {
    id: THIS_MAC_PROFILE_ID,
    kind: "local",
    name: "This Mac",
    origin: normalizeOrigin(input.origin, true),
    authentication: { kind: "desktop_local" },
    capabilities: input.capabilities,
    status: { state: "ready" },
    system: true,
  };
}

export function createManagedServerProfile(input: ManagedServerProfileInput): ServerProfile {
  if (input.id === THIS_MAC_PROFILE_ID || input.id.trim().length === 0) {
    throw new ProfileMutationError("PROFILE_ID_RESERVED", "This profile identity is reserved.");
  }
  const name = input.name.trim();
  if (!name) throw new ProfileMutationError("INVALID_PROFILE", "Enter a server name.");
  return {
    ...input,
    name,
    origin: normalizeOrigin(input.origin, false),
    status: input.status ?? { state: "ready" },
    system: false,
  };
}

function isManagedProfile(profile: ServerProfile): profile is ManagedServerProfile {
  return (
    profile.system === false &&
    profile.kind !== "local" &&
    profile.authentication.kind !== "desktop_local" &&
    profile.id !== THIS_MAC_PROFILE_ID
  );
}

export function normalizeServerProfiles(
  persisted: ReadonlyArray<ServerProfile>,
  thisMac?: ServerProfile,
): ServerProfile[] {
  const seen = new Set<string>();
  const profiles: ServerProfile[] = [];
  if (thisMac) {
    seen.add(thisMac.id);
    profiles.push(thisMac);
  }
  for (const profile of persisted) {
    if (!isManagedProfile(profile) || seen.has(profile.id)) continue;
    try {
      const validated = createManagedServerProfile(profile);
      seen.add(validated.id);
      profiles.push(validated);
    } catch {
      // Corrupt, insecure, and legacy Local entries are ignored during migration.
    }
  }
  return profiles;
}

function requireManagedProfile(
  profiles: ReadonlyArray<ServerProfile>,
  id: string,
): ManagedServerProfile {
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new ProfileMutationError("PROFILE_NOT_FOUND", "Server profile not found.");
  if (!isManagedProfile(profile)) {
    throw new ProfileMutationError(
      "SYSTEM_PROFILE_PROTECTED",
      "This Mac is managed by the SelfTune desktop app and cannot be changed.",
    );
  }
  return profile;
}

export function renameServerProfile(
  profiles: ReadonlyArray<ServerProfile>,
  id: string,
  name: string,
): ServerProfile[] {
  const current = requireManagedProfile(profiles, id);
  const replacement = createManagedServerProfile({ ...current, name });
  return profiles.map((profile) => (profile.id === id ? replacement : profile));
}

export function removeServerProfile(
  profiles: ReadonlyArray<ServerProfile>,
  id: string,
): ServerProfile[] {
  requireManagedProfile(profiles, id);
  return profiles.filter((profile) => profile.id !== id);
}

export function serializeManagedServerProfiles(profiles: ReadonlyArray<ServerProfile>): string {
  return JSON.stringify(
    profiles.filter(isManagedProfile).map((profile) => serializedProfileSchema.parse(profile)),
  );
}

export interface ServerProfilesSnapshot {
  readonly profiles: readonly ServerProfile[];
  readonly activeProfileId: string | null;
}

export interface ServerProfileController {
  snapshot(): ServerProfilesSnapshot;
  subscribe(listener: () => void): () => void;
  add(input: ManagedServerProfileInput, sessionCredential?: string): Promise<ServerProfile>;
  test(id: string): Promise<ServerProfile>;
  select(id: string): Promise<void>;
  rename(id: string, name: string): void;
  remove(id: string): void;
  reconcileExternal(serialized: string): void;
}

export type ServerProfileSwitchResult = "activated" | "opened_external";

export function createServerProfileController(options: {
  readonly initialProfiles: ReadonlyArray<ServerProfile>;
  readonly activeProfileId: string | null;
  readonly thisMac?: ServerProfile;
  readonly persist: (serialized: string) => void;
  readonly validate: (profile: ServerProfile) => Promise<ServerProfile>;
  readonly setSessionCredential?: (profileId: string, credential: string) => void;
  readonly switchProfile: (profile: ServerProfile) => Promise<ServerProfileSwitchResult>;
}): ServerProfileController {
  let profiles = normalizeServerProfiles(options.initialProfiles, options.thisMac);
  let activeProfileId = profiles.some((profile) => profile.id === options.activeProfileId)
    ? options.activeProfileId
    : (options.thisMac?.id ?? profiles[0]?.id ?? null);
  const listeners = new Set<() => void>();
  let currentSnapshot: ServerProfilesSnapshot = { profiles, activeProfileId };
  const notify = (): void => {
    currentSnapshot = { profiles, activeProfileId };
    for (const listener of listeners) listener();
  };
  const persist = (): void => options.persist(serializeManagedServerProfiles(profiles));

  const replace = (profile: ServerProfile): void => {
    profiles = profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate));
    persist();
    notify();
  };

  return {
    snapshot: () => currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async add(input, sessionCredential) {
      if (profiles.some((profile) => profile.id === input.id)) {
        throw new ProfileMutationError(
          "PROFILE_ID_RESERVED",
          "That server profile already exists.",
        );
      }
      const profile = createManagedServerProfile(input);
      if (sessionCredential) options.setSessionCredential?.(profile.id, sessionCredential);
      const validated = await options.validate(profile);
      profiles = [...profiles, validated];
      persist();
      notify();
      return validated;
    },
    async test(id) {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile)
        throw new ProfileMutationError("PROFILE_NOT_FOUND", "Server profile not found.");
      const validated = await options.validate(profile);
      replace(validated);
      return validated;
    },
    async select(id) {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile)
        throw new ProfileMutationError("PROFILE_NOT_FOUND", "Server profile not found.");
      const validated = await options.validate(profile);
      replace(validated);
      if (validated.status.state !== "ready") {
        throw new ProfileMutationError("INVALID_PROFILE", validated.status.message);
      }
      const result = await options.switchProfile(validated);
      if (result === "opened_external") return;
      activeProfileId = validated.id;
      notify();
    },
    rename(id, name) {
      profiles = renameServerProfile(profiles, id, name);
      persist();
      notify();
    },
    remove(id) {
      profiles = removeServerProfile(profiles, id);
      if (activeProfileId === id) activeProfileId = options.thisMac?.id ?? profiles[0]?.id ?? null;
      persist();
      notify();
    },
    reconcileExternal(serialized) {
      let parsed: Array<ServerProfile | null>;
      try {
        parsed = serializedProfilesSchema.parse(JSON.parse(serialized));
      } catch {
        return;
      }
      profiles = normalizeServerProfiles(
        parsed.filter((value) => value !== null),
        options.thisMac,
      );
      if (!profiles.some((profile) => profile.id === activeProfileId)) {
        activeProfileId = options.thisMac?.id ?? profiles[0]?.id ?? null;
      }
      notify();
    },
  };
}
