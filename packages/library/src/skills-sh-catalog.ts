import { Duration, Effect, Schema } from "effect";

const DEFAULT_API_BASE_URL = "https://skills.sh";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 200;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = Duration.seconds(10);

const SkillsShWireSkill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  installs: Schema.optionalKey(Schema.Number),
});

const SkillsShWireSearchResponse = Schema.Struct({
  skills: Schema.Array(SkillsShWireSkill),
});

export class SkillsShCatalogEntry extends Schema.Class<SkillsShCatalogEntry>(
  "SkillsShCatalogEntry",
)({
  catalog_id: Schema.String,
  name: Schema.String,
  source: Schema.String,
  owner: Schema.String,
  repository: Schema.String,
  install_spec: Schema.String,
  details_url: Schema.String,
  download_url: Schema.String,
  installs: Schema.Number,
}) {}

export class SkillsShCatalogInputError extends Schema.TaggedErrorClass<SkillsShCatalogInputError>()(
  "SkillsShCatalogInputError",
  { message: Schema.String },
) {}

export class SkillsShCatalogTransportError extends Schema.TaggedErrorClass<SkillsShCatalogTransportError>()(
  "SkillsShCatalogTransportError",
  { message: Schema.String },
) {}

export class SkillsShCatalogHttpError extends Schema.TaggedErrorClass<SkillsShCatalogHttpError>()(
  "SkillsShCatalogHttpError",
  { status: Schema.Number, message: Schema.String },
) {}

export class SkillsShCatalogDecodeError extends Schema.TaggedErrorClass<SkillsShCatalogDecodeError>()(
  "SkillsShCatalogDecodeError",
  { message: Schema.String },
) {}

export type SkillsShCatalogSearchError =
  | SkillsShCatalogInputError
  | SkillsShCatalogTransportError
  | SkillsShCatalogHttpError
  | SkillsShCatalogDecodeError;

export type SkillsShCatalogFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SkillsShCatalogSearchOptions {
  readonly apiBaseUrl?: string;
  readonly fetcher?: SkillsShCatalogFetch;
  readonly limit?: number;
}

function inputError(message: string): SkillsShCatalogInputError {
  return SkillsShCatalogInputError.make({ message });
}

function normalizeQuery(query: string): Effect.Effect<string, SkillsShCatalogInputError> {
  return Effect.try({
    try: () => {
      const normalized = query.trim();
      if (normalized.length < 2) throw new Error("Catalog search requires at least 2 characters");
      if (normalized.length > MAX_QUERY_LENGTH) {
        throw new Error(`Catalog search cannot exceed ${MAX_QUERY_LENGTH} characters`);
      }
      return normalized;
    },
    catch: (cause) => inputError(cause instanceof Error ? cause.message : String(cause)),
  });
}

function normalizeLimit(
  limit: number | undefined,
): Effect.Effect<number, SkillsShCatalogInputError> {
  return Effect.try({
    try: () => {
      const value = limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw new Error(`Catalog search limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      return value;
    },
    catch: (cause) => inputError(cause instanceof Error ? cause.message : String(cause)),
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizeApiBaseUrl(value: string): Effect.Effect<URL, SkillsShCatalogInputError> {
  return Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
        throw new Error("Catalog API URL must use HTTPS (HTTP is allowed only for loopback)");
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new Error("Catalog API URL cannot contain credentials, a query, or a fragment");
      }
      if (url.pathname !== "/") {
        throw new Error("Catalog API URL cannot contain a path");
      }
      return url;
    },
    catch: (cause) => inputError(cause instanceof Error ? cause.message : String(cause)),
  });
}

function githubSource(value: string): { owner: string; repository: string; source: string } | null {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    return null;
  }
  return { owner: match[1], repository: match[2], source: `${match[1]}/${match[2]}` };
}

function sourceFromWireSkill(
  skill: typeof SkillsShWireSkill.Type,
): ReturnType<typeof githubSource> {
  const explicit = skill.source ? githubSource(skill.source) : null;
  if (explicit) return explicit;
  const [owner, repository] = skill.id.split("/");
  return owner && repository ? githubSource(`${owner}/${repository}`) : null;
}

function validCatalogText(value: string): string | null {
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  return normalized;
}

function toCatalogEntry(
  skill: typeof SkillsShWireSkill.Type,
  baseUrl: URL,
): SkillsShCatalogEntry | null {
  const source = sourceFromWireSkill(skill);
  const name = validCatalogText(skill.name);
  const catalogId = validCatalogText(skill.id);
  if (!source || !name || !catalogId) return null;
  const catalogSegments = catalogId.split("/");
  const slug = catalogSegments[2];
  if (
    catalogSegments.length !== 3 ||
    catalogSegments[0] !== source.owner ||
    catalogSegments[1] !== source.repository ||
    !slug ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)
  ) {
    return null;
  }

  return SkillsShCatalogEntry.make({
    catalog_id: catalogId,
    name,
    source: source.source,
    owner: source.owner,
    repository: source.repository,
    install_spec: `${source.source}@${slug}`,
    details_url: new URL(
      `/${catalogId.split("/").map(encodeURIComponent).join("/")}`,
      baseUrl,
    ).toString(),
    download_url: new URL(
      `/api/download/${catalogSegments.map(encodeURIComponent).join("/")}`,
      baseUrl,
    ).toString(),
    installs: Math.max(0, Math.floor(skill.installs ?? 0)),
  });
}

const readResponseBody = Effect.fn("SkillsShCatalog.readResponseBody")(function* (
  response: Response,
) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    return yield* SkillsShCatalogDecodeError.make({
      message: "Catalog response exceeds the 1 MiB size limit",
    });
  }
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      SkillsShCatalogTransportError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    return yield* SkillsShCatalogDecodeError.make({
      message: "Catalog response exceeds the 1 MiB size limit",
    });
  }
  return text;
});

/**
 * Searches the same public catalog endpoint used by `npx skills find`.
 * Results carry an exact install spec and download identity, but are not local
 * packages yet. Callers must materialize a result before adding it to a Skill Set.
 */
export const searchSkillsShCatalog = Effect.fn("SkillsShCatalog.search")(function* (
  query: string,
  options: SkillsShCatalogSearchOptions = {},
) {
  const normalizedQuery = yield* normalizeQuery(query);
  const limit = yield* normalizeLimit(options.limit);
  const baseUrl = yield* normalizeApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("limit", String(limit));

  const response = yield* Effect.tryPromise({
    try: (signal) =>
      (options.fetcher ?? globalThis.fetch)(url, {
        headers: { Accept: "application/json", "User-Agent": "selftune-catalog" },
        signal,
      }),
    catch: (cause) =>
      SkillsShCatalogTransportError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", () =>
      SkillsShCatalogTransportError.make({ message: "Catalog request timed out after 10 seconds" }),
    ),
  );

  if (!response.ok) {
    return yield* SkillsShCatalogHttpError.make({
      status: response.status,
      message: `Catalog request failed with HTTP ${response.status}`,
    });
  }

  const text = yield* readResponseBody(response);
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      SkillsShCatalogDecodeError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const payload = yield* Schema.decodeUnknownEffect(SkillsShWireSearchResponse)(json).pipe(
    Effect.mapError((cause) => SkillsShCatalogDecodeError.make({ message: cause.message })),
  );

  const unique = new Map<string, SkillsShCatalogEntry>();
  for (const skill of payload.skills) {
    const entry = toCatalogEntry(skill, baseUrl);
    if (!entry) continue;
    const key = entry.install_spec.toLowerCase();
    const current = unique.get(key);
    if (!current || entry.installs > current.installs) unique.set(key, entry);
  }
  return [...unique.values()].toSorted(
    (left, right) =>
      right.installs - left.installs || left.install_spec.localeCompare(right.install_spec),
  );
});

export * from "./skills-sh-materializer.js";
