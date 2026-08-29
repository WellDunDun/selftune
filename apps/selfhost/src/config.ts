import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ConfiguredUser, isUuid, type UserRole } from "./contract.js";

const ConfiguredUserInput = Schema.Struct({
  email: Schema.String,
  token: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  org_id: Schema.optional(Schema.String),
  org_name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(["admin", "member", "viewer"])),
});

const ConfiguredUsersInput = Schema.Array(ConfiguredUserInput);

export class SelfHostConfigFailure extends Schema.TaggedErrorClass<SelfHostConfigFailure>()(
  "SelfHostConfigFailure",
  { message: Schema.String },
) {}

export interface SelfHostConfig {
  readonly accounts: ReadonlyArray<ConfiguredUser>;
  readonly adminToken: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly dataDir: string;
  readonly host: string;
  readonly maxObjectBytes: number;
  readonly packLinkSecret?: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly spaDir: string | undefined;
}

function configFailure(message: string): SelfHostConfigFailure {
  return SelfHostConfigFailure.make({ message });
}

function isPlaceholderToken(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return (
    normalized === "changeme" ||
    normalized === "change-me" ||
    normalized === "replace-me" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "placeholder" ||
    normalized.includes("placeholder") ||
    normalized.startsWith("change-me-") ||
    normalized.startsWith("example-") ||
    normalized.startsWith("insert-") ||
    normalized.startsWith("replace-") ||
    normalized.startsWith("sample-") ||
    (normalized.startsWith("your-") && normalized.includes("token")) ||
    /^(.)\1{31,}$/.test(normalized) ||
    /^<[^>]+>$/.test(normalized)
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configFailure(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configFailure(`${name} must be an absolute http or https URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configFailure(`${name} must use http or https.`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw configFailure(`${name} must contain only an origin.`);
  }
  return url.origin;
}

function validateAccount(account: ConfiguredUser, index: number): ConfiguredUser {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) {
    throw configFailure(`Account ${index + 1} has an invalid email address.`);
  }
  if (account.token.length < 32) {
    throw configFailure(`Account ${index + 1} token must contain at least 32 characters.`);
  }
  if (isPlaceholderToken(account.token)) {
    throw configFailure(`Account ${index + 1} token must be replaced with a random secret.`);
  }
  if (account.orgId !== null && !isUuid(account.orgId)) {
    throw configFailure(`Account ${index + 1} org_id must be a UUID.`);
  }
  return account;
}

function configuredUser(
  input: typeof ConfiguredUserInput.Type,
  defaultRole: UserRole,
): ConfiguredUser {
  return {
    email: input.email.trim().toLowerCase(),
    token: input.token,
    name: input.name?.trim() || null,
    orgId: input.org_id ?? null,
    orgName: input.org_name?.trim() || "SelfTune",
    role: input.role ?? defaultRole,
  };
}

const decodeConfiguredUsers = Schema.decodeUnknownEffect(ConfiguredUsersInput);

export const loadSelfHostConfig = Effect.fn("SelfHostConfig.load")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const adminToken = environment.SELFTUNE_AUTH_TOKEN?.trim();
  if (!adminToken) {
    return yield* Effect.fail(
      configFailure("SELFTUNE_AUTH_TOKEN is required and must contain at least 32 characters."),
    );
  }

  const parsedUsers = yield* Effect.try({
    try: (): unknown => JSON.parse(environment.SELFTUNE_SELFHOST_USERS_JSON ?? "[]"),
    catch: () => configFailure("SELFTUNE_SELFHOST_USERS_JSON must be valid JSON."),
  }).pipe(
    Effect.flatMap(decodeConfiguredUsers),
    Effect.mapError((error) =>
      error instanceof SelfHostConfigFailure
        ? error
        : configFailure(`SELFTUNE_SELFHOST_USERS_JSON is invalid: ${error.message}`),
    ),
  );

  const admin = configuredUser(
    {
      email: environment.SELFTUNE_SELFHOST_ADMIN_EMAIL ?? "admin@selftune.local",
      token: adminToken,
      name: environment.SELFTUNE_SELFHOST_ADMIN_NAME ?? "SelfTune Admin",
      org_id: environment.SELFTUNE_SELFHOST_ADMIN_ORG_ID,
      org_name: environment.SELFTUNE_SELFHOST_ADMIN_ORG_NAME ?? "SelfTune",
      role: "admin",
    },
    "admin",
  );
  const accounts = [
    validateAccount(admin, 0),
    ...parsedUsers.map((input, index) =>
      validateAccount(configuredUser(input, "member"), index + 1),
    ),
  ];
  const emails = new Set<string>();
  const tokens = new Set<string>();
  for (const account of accounts) {
    if (emails.has(account.email)) {
      return yield* Effect.fail(configFailure(`Duplicate account email: ${account.email}`));
    }
    if (tokens.has(account.token)) {
      return yield* Effect.fail(configFailure("Each self-hosted account must use a unique token."));
    }
    emails.add(account.email);
    tokens.add(account.token);
  }

  const host = environment.SELFTUNE_HOST?.trim() || "0.0.0.0";
  const port = yield* Effect.try({
    try: () => parsePositiveInteger(environment.SELFTUNE_PORT, 8787, "SELFTUNE_PORT"),
    catch: (error) =>
      error instanceof SelfHostConfigFailure ? error : configFailure(String(error)),
  });
  if (port > 65_535) {
    return yield* Effect.fail(configFailure("SELFTUNE_PORT must be at most 65535."));
  }
  const maxObjectBytes = yield* Effect.try({
    try: () =>
      parsePositiveInteger(
        environment.SELFTUNE_REMOTE_LIBRARY_MAX_OBJECT_BYTES,
        50 * 1024 * 1024,
        "SELFTUNE_REMOTE_LIBRARY_MAX_OBJECT_BYTES",
      ),
    catch: (error) =>
      error instanceof SelfHostConfigFailure ? error : configFailure(String(error)),
  });
  const publicUrl = yield* Effect.try({
    try: () =>
      normalizeOrigin(
        environment.SELFTUNE_PUBLIC_URL ?? `http://localhost:${port}`,
        "SELFTUNE_PUBLIC_URL",
      ),
    catch: (error) =>
      error instanceof SelfHostConfigFailure ? error : configFailure(String(error)),
  });
  const extraOrigins = (environment.SELFTUNE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = yield* Effect.try({
    try: () => [
      publicUrl,
      ...extraOrigins.map((origin, index) =>
        normalizeOrigin(origin, `SELFTUNE_ALLOWED_ORIGINS entry ${index + 1}`),
      ),
    ],
    catch: (error) =>
      error instanceof SelfHostConfigFailure ? error : configFailure(String(error)),
  });
  const dataDir = resolve(environment.SELFTUNE_DATA_DIR ?? join(homedir(), ".selftune-selfhost"));
  const packLinkSecret = environment.SELFTUNE_PACK_LINK_SECRET?.trim() || adminToken;
  if (packLinkSecret.length < 32 || isPlaceholderToken(packLinkSecret)) {
    return yield* Effect.fail(
      configFailure("SELFTUNE_PACK_LINK_SECRET must contain at least 32 random characters."),
    );
  }

  return {
    accounts,
    adminToken,
    allowedOrigins: [...new Set(allowedOrigins)],
    dataDir,
    host,
    maxObjectBytes,
    packLinkSecret,
    port,
    publicUrl,
    spaDir: environment.SELFTUNE_SPA_DIR ? resolve(environment.SELFTUNE_SPA_DIR) : undefined,
  } satisfies SelfHostConfig;
});
