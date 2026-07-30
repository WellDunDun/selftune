import { Duration, Effect, Layer, Option } from "effect";
import { readFileSync } from "node:fs";

import {
  searchSkillsShCatalog,
  type SkillsShCatalogEntry,
  type SkillsShCatalogSearchError,
} from "@selftune/library";
import type {
  CatalogExpansionCapabilityId,
  CatalogExpansionCatalogEntry,
  CatalogExpansionProfileId,
  SkillIntelligenceInstalledSkill,
  SkillIntelligenceReport,
  SkillIntelligenceSessionRow,
} from "@selftune/skill-intelligence";
import { getDb } from "@selftune/local-store";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { querySessionTelemetryForReports } from "../localdb/queries/raw.js";
import {
  discoverSkillIntelligenceInstalledSkills,
  loadSkillIntelligence,
  type LoadSkillIntelligenceOptions,
} from "./index.js";
import {
  buildRecentProjectSignals,
  RECENT_PROJECT_SIGNAL_SESSION_LIMIT,
} from "./project-signals.js";
import {
  DuckDbAnalyticalStore,
  DuckDbAnalyticalStoreFailure,
} from "@selftune/observability/duckdb-store";

const CACHE_TTL_MS = 60 * 60 * 1_000;

interface CatalogTarget {
  readonly profile: CatalogExpansionProfileId;
  readonly capability: CatalogExpansionCapabilityId;
  readonly query: string;
  readonly identity: RegExp;
  readonly preferredSource?: string;
}

const TARGETS: ReadonlyArray<CatalogTarget> = [
  target("web_full_stack", "platform", "cloudflare", /\bcloudflare\b/),
  target("web_full_stack", "platform_operations", "wrangler", /\bwrangler\b/),
  target("web_full_stack", "frontend_components", "shadcn", /\bshadcn\b/),
  target(
    "web_full_stack",
    "react_quality",
    "react best practices",
    /\b(?:vercel )?react best practices\b/,
    "vercel-labs/agent-skills",
  ),
  target("mobile", "mobile_framework", "flutter", /\bflutter\b/),
  target("mobile", "language", "dart", /\bdart\b/),
  target("mobile", "simulator_tooling", "serve-sim", /\bserve sim\b/, "evanbacon/serve-sim"),
  target(
    "high_rigor_review",
    "rigorous_review",
    "thermonuclear review",
    /\bthermonuclear review\b/,
  ),
  target("high_rigor_review", "diagnostics", "diagnose", /\bdiagnos(?:e|is|tic)\b/),
  target("high_rigor_review", "testing", "tdd", /\b(?:tdd|test driven)\b/, "mattpocock/skills"),
  target(
    "high_rigor_review",
    "architecture",
    "codebase design",
    /\b(?:codebase design|domain model)\b/,
  ),
];

const PROFILE_SIGNALS: Record<CatalogExpansionProfileId, RegExp> = {
  web_full_stack: /\b(?:cloudflare|wrangler|react|next ?js|web|frontend|worker)\b/,
  mobile: /\b(?:mobile|flutter|dart|ios|android|serve sim|simulator|emulator)\b/,
  high_rigor_review: /\b(?:review|audit|quality|refactor|regression|architecture)\b/,
};

const catalogCache = new Map<
  string,
  { readonly expiresAt: number; readonly entries: ReadonlyArray<SkillsShCatalogEntry> }
>();

export interface LoadSkillIntelligenceWithCatalogOptions extends LoadSkillIntelligenceOptions {
  /** Explicit host-owned DuckDB file used when this runtime acquires a trace snapshot. */
  readonly traceAnalyticsPath?: string;
  readonly catalogSearch?: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<SkillsShCatalogEntry>, SkillsShCatalogSearchError>;
}

function target(
  profile: CatalogExpansionProfileId,
  capability: CatalogExpansionCapabilityId,
  query: string,
  identity: RegExp,
  preferredSource?: string,
): CatalogTarget {
  return { profile, capability, query, identity, preferredSource };
}

function semanticText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasInstalledTarget(
  installedSkills: ReadonlyArray<SkillIntelligenceInstalledSkill>,
  catalogTarget: CatalogTarget,
): boolean {
  return installedSkills.some(
    (skill) => skill.active !== false && catalogTarget.identity.test(semanticText(skill.name)),
  );
}

// Sessions arrive newest-first; recent activity decides which profiles are worth expanding,
// and the bounded window keeps this from re-normalizing the entire session history per request.
function relevantProfiles(
  sessions: ReadonlyArray<SkillIntelligenceSessionRow>,
): Set<CatalogExpansionProfileId> {
  const remaining = new Map(
    Object.entries(PROFILE_SIGNALS) as Array<[CatalogExpansionProfileId, RegExp]>,
  );
  const matched = new Set<CatalogExpansionProfileId>();
  for (const session of sessions.slice(0, RECENT_PROJECT_SIGNAL_SESSION_LIMIT)) {
    if (remaining.size === 0) break;
    const signals = semanticText(`${session.cwd} ${session.last_user_query}`);
    for (const [profile, expression] of remaining) {
      if (expression.test(signals)) {
        matched.add(profile);
        remaining.delete(profile);
      }
    }
  }
  return matched;
}

function cachedSearch(
  catalogTarget: CatalogTarget,
  search: LoadSkillIntelligenceWithCatalogOptions["catalogSearch"],
): Effect.Effect<ReadonlyArray<SkillsShCatalogEntry>, never> {
  const cached = catalogCache.get(catalogTarget.query);
  if (cached && cached.expiresAt > Date.now()) return Effect.succeed(cached.entries);
  const effect = search
    ? search(catalogTarget.query)
    : searchSkillsShCatalog(catalogTarget.query, { limit: 10 });
  return effect.pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.catch(() => Effect.succeed([])),
    Effect.tap((entries) =>
      Effect.sync(() => {
        catalogCache.set(catalogTarget.query, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          entries,
        });
      }),
    ),
  );
}

/**
 * Trace signals are an optional analytical projection. A live store is
 * supplied by the host only when a caller has not already supplied a snapshot;
 * an unavailable reader therefore degrades just this projection, not the
 * product-report pipeline around it.
 */
export const loadTraceSignalsEffect = Effect.fn("SkillIntelligence.loadTraceSignals")(function* (
  supplied: LoadSkillIntelligenceWithCatalogOptions["traceSignals"],
) {
  if (supplied !== undefined) return supplied;

  return yield* Effect.serviceOption(DuckDbAnalyticalStore).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([]),
        onSome: (store) =>
          store
            .querySkillSignals()
            .pipe(Effect.catchTag("DuckDbAnalyticalStoreFailure", () => Effect.succeed([]))),
      }),
    ),
  );
});

/**
 * Acquires the analytical reader only long enough to load its projection. The
 * typed fallback is outside Layer acquisition, so a writer-held DuckDB lock is
 * treated the same as a failed read and cannot replay product-report work.
 */
export function loadFailSoftTraceSignalsEffect(
  liveLayer: Layer.Layer<DuckDbAnalyticalStore, DuckDbAnalyticalStoreFailure>,
) {
  return Effect.scoped(loadTraceSignalsEffect(undefined).pipe(Effect.provide(liveLayer))).pipe(
    Effect.catchTag("DuckDbAnalyticalStoreFailure", () => Effect.succeed([])),
  );
}

function bestEntry(
  catalogTarget: CatalogTarget,
  entries: ReadonlyArray<SkillsShCatalogEntry>,
): SkillsShCatalogEntry | null {
  const matches = entries.filter((entry) =>
    catalogTarget.identity.test(semanticText(`${entry.name} ${entry.install_spec}`)),
  );
  return (
    matches.find(
      (entry) => entry.source.toLowerCase() === catalogTarget.preferredSource?.toLowerCase(),
    ) ??
    matches[0] ??
    null
  );
}

function mergeCatalogEntries(
  entries: ReadonlyArray<{ readonly target: CatalogTarget; readonly entry: SkillsShCatalogEntry }>,
): CatalogExpansionCatalogEntry[] {
  const merged = new Map<string, CatalogExpansionCatalogEntry>();
  for (const { target: catalogTarget, entry } of entries) {
    const current = merged.get(entry.catalog_id);
    merged.set(entry.catalog_id, {
      catalog_id: entry.catalog_id,
      name: entry.name,
      source: entry.source,
      install_spec: entry.install_spec,
      download_url: entry.download_url,
      capabilities: [...new Set([...(current?.capabilities ?? []), catalogTarget.capability])],
    });
  }
  return [...merged.values()];
}

export const loadSkillIntelligenceWithCatalogEffect = Effect.fn(
  "SkillIntelligence.loadWithCatalog",
)(function* (options: LoadSkillIntelligenceWithCatalogOptions = {}) {
  const db = options.db ?? getDb();
  const sessions =
    options.sessions ?? querySessionTelemetryForReports(db, RECENT_PROJECT_SIGNAL_SESSION_LIMIT);
  const configRoot = options.configRoot ?? SELFTUNE_CONFIG_DIR;
  const installedSkills =
    options.installedSkills ??
    discoverSkillIntelligenceInstalledSkills({
      db,
      sessions,
      searchDirs: options.searchDirs,
      workspacePaths: options.workspacePaths,
      configRoot,
      quarantineRoot: options.quarantineRoot,
      contentLoader: options.contentLoader ?? ((path) => readFileSync(path, "utf8")),
    });
  const profiles = relevantProfiles(sessions);
  const missingTargets = TARGETS.filter(
    (catalogTarget) =>
      profiles.has(catalogTarget.profile) && !hasInstalledTarget(installedSkills, catalogTarget),
  );
  const resolved = yield* Effect.all(
    missingTargets.map((catalogTarget) =>
      cachedSearch(catalogTarget, options.catalogSearch).pipe(
        Effect.map((entries) => {
          const entry = bestEntry(catalogTarget, entries);
          return entry ? { target: catalogTarget, entry } : null;
        }),
      ),
    ),
    { concurrency: 4 },
  );
  const catalogEntries = mergeCatalogEntries(
    resolved.filter(
      (result): result is { target: CatalogTarget; entry: SkillsShCatalogEntry } => result !== null,
    ),
  );
  const traceSignals = yield* loadTraceSignalsEffect(options.traceSignals);
  return loadSkillIntelligence({
    ...options,
    db,
    sessions,
    installedSkills,
    catalogEntries: [...(options.catalogEntries ?? []), ...catalogEntries],
    traceSignals,
    projectSignals:
      options.projectSignals ?? buildRecentProjectSignals(sessions, options.workspacePaths),
  });
});

export function loadSkillIntelligenceWithCatalog(
  options: LoadSkillIntelligenceWithCatalogOptions = {},
): Promise<SkillIntelligenceReport> {
  const report = loadSkillIntelligenceWithCatalogEffect(options);
  if (options.traceSignals !== undefined) return Effect.runPromise(Effect.scoped(report));

  // The native adapter packages libduckdb. Keep it out of the ordinary report
  // path, including callers that already hold a host-projected trace snapshot.
  return import("@selftune/observability/duckdb-node-api").then(
    ({ makeDuckDbNodeApiAnalyticalStoreLive }) => {
      const traceSignalSnapshotEffect = loadFailSoftTraceSignalsEffect(
        makeDuckDbNodeApiAnalyticalStoreLive(options.traceAnalyticsPath),
      );
      return Effect.runPromise(
        traceSignalSnapshotEffect.pipe(
          Effect.flatMap((traceSignalSnapshot) =>
            loadSkillIntelligenceWithCatalogEffect({
              ...options,
              traceSignals: traceSignalSnapshot,
            }),
          ),
        ),
      );
    },
  );
}
