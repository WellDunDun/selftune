import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  aggregateSkillIntelligenceObservations,
  analyzeSkillIntelligence,
  type SkillClassificationOverride,
  type SkillIntelligenceCalibration,
  type SkillIntelligenceInstalledSkill,
  type SkillIntelligenceObservationGroups,
  type SkillIntelligenceReport,
  type SkillIntelligenceSessionRow,
  type SkillSetOutcome,
  type SkillSetSuggestionReview,
  type CatalogExpansionCatalogEntry,
  type CatalogExpansionProjectSignals,
  type SkillTraceSignal,
} from "@selftune/skill-intelligence";
import { getDb } from "@selftune/local-store";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import {
  queryKnownWorkspacePaths,
  querySessionTelemetry,
  querySessionTelemetryForReports,
} from "../localdb/queries/raw.js";
import {
  iterateTrustedSkillObservationRows,
  queryTrustedSkillObservationRows,
  type TrustedSkillObservationRow,
} from "../localdb/queries/trust.js";
import { listQuarantinedSkills, QUARANTINE_DIR } from "../skill-portfolio.js";
import {
  normalizeGitHubRepository,
  resolveTrackedSkillSources,
} from "../source-management/metadata-adapter.js";
import {
  listSkillSets,
  type SkillSetManifest,
  type SkillSetServiceOptions,
} from "@selftune/library";
import {
  extendSkillSearchDirsForWorkspaces,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "../utils/skill-discovery.js";
import { inferSkillHarness } from "../utils/skill-harness.js";
import { loadSkillIntelligenceFeedback, persistSkillSetSuggestionSnapshots } from "./feedback.js";
import { refreshSkillSetOutcomes, type RefreshSkillSetOutcomesOptions } from "./outcome-store.js";
import {
  buildRecentProjectSignals,
  RECENT_PROJECT_SIGNAL_SESSION_LIMIT,
} from "./project-signals.js";

export * from "@selftune/skill-intelligence";

export interface LoadSkillIntelligenceOptions {
  db?: Database;
  searchDirs?: string[];
  configRoot?: string;
  quarantineRoot?: string;
  installedSkills?: ReadonlyArray<SkillIntelligenceInstalledSkill>;
  observations?: ReadonlyArray<TrustedSkillObservationRow>;
  observationGroups?: SkillIntelligenceObservationGroups;
  sessions?: ReadonlyArray<SkillIntelligenceSessionRow>;
  existingSets?: ReadonlyArray<SkillSetManifest>;
  classificationOverrides?: ReadonlyArray<SkillClassificationOverride>;
  suggestionReviews?: ReadonlyArray<SkillSetSuggestionReview>;
  minOccurrences?: number;
  minAffinity?: number;
  holdoutRatio?: number;
  minValidationOccurrences?: number;
  minEvidenceScore?: number;
  calibration?: SkillIntelligenceCalibration;
  outcomes?: ReadonlyArray<SkillSetOutcome>;
  maxSuggestions?: number;
  now?: Date;
  contentLoader?: (skillPath: string) => string;
  workspacePaths?: ReadonlyArray<string>;
  catalogEntries?: ReadonlyArray<CatalogExpansionCatalogEntry>;
  projectSignals?: CatalogExpansionProjectSignals;
  /** Analytical snapshots are supplied by the host; runtime never queries trace storage. */
  traceSignals?: ReadonlyArray<SkillTraceSignal>;
}

interface InstalledSkillDiscoveryOptions {
  readonly db: Database;
  readonly sessions: ReadonlyArray<SkillIntelligenceSessionRow>;
  readonly searchDirs?: ReadonlyArray<string>;
  readonly workspacePaths?: ReadonlyArray<string>;
  readonly configRoot: string;
  readonly quarantineRoot?: string;
  readonly contentLoader: (skillPath: string) => string;
}

function normalizedSourceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return (normalizeGitHubRepository(trimmed) ?? trimmed).toLowerCase();
}

function loadContent(skillPath: string, loader: (path: string) => string): string {
  try {
    return loader(skillPath);
  } catch {
    return "";
  }
}

function attachTrackedSourceIds(
  skills: ReadonlyArray<SkillIntelligenceInstalledSkill>,
): SkillIntelligenceInstalledSkill[] {
  const trackedSources = resolveTrackedSkillSources(skills);
  return skills.map((skill) => ({
    ...skill,
    source_id:
      skill.source_id === undefined
        ? normalizedSourceId(trackedSources.get(skill.skill_path)?.entry.source)
        : normalizedSourceId(skill.source_id),
  }));
}

export function discoverSkillIntelligenceInstalledSkills(
  options: InstalledSkillDiscoveryOptions,
): SkillIntelligenceInstalledSkill[] {
  const contentPool = new Map<string, string>();
  const loadInternedContent = (skillPath: string): string => {
    const content = loadContent(skillPath, options.contentLoader);
    const interned = contentPool.get(content);
    if (interned !== undefined) return interned;
    contentPool.set(content, content);
    return content;
  };
  const searchDirs =
    options.searchDirs === undefined
      ? extendSkillSearchDirsForWorkspaces(
          getDefaultSkillSearchDirs(),
          options.workspacePaths ?? queryKnownWorkspacePaths(options.db),
        )
      : [...options.searchDirs];
  const active = findInstalledSkillPackages(searchDirs).map(
    (skill): SkillIntelligenceInstalledSkill => ({
      ...skill,
      content: loadInternedContent(skill.skill_path),
      harness: inferSkillHarness(`${skill.registry_dir}${sep}`),
      active: true,
    }),
  );
  const passive = findInstalledSkillPackages([
    join(options.configRoot, "library", "drafts"),
    join(options.configRoot, "library", "packages"),
  ]).map(
    (skill): SkillIntelligenceInstalledSkill => ({
      ...skill,
      content: loadInternedContent(skill.skill_path),
      harness: null,
      active: false,
    }),
  );
  const archived = listQuarantinedSkills(options.quarantineRoot ?? QUARANTINE_DIR).flatMap(
    (record): SkillIntelligenceInstalledSkill[] => {
      const skillPath = join(record.quarantined_package_path, "SKILL.md");
      if (!existsSync(skillPath)) return [];
      return [
        {
          name: record.skill_name,
          skill_path: skillPath,
          package_path: record.quarantined_package_path,
          registry_dir: dirname(record.quarantined_package_path),
          modified_at: record.quarantined_at,
          skill_scope: record.skill_scope,
          content: loadInternedContent(skillPath),
          harness: null,
          active: false,
        },
      ];
    },
  );
  return attachTrackedSourceIds([
    ...new Map(
      [...active, ...passive, ...archived].map((skill) => [skill.skill_path, skill]),
    ).values(),
  ]);
}

function loadSkillIntelligenceWithObservationMode(
  options: LoadSkillIntelligenceOptions,
  observationMode: "pre-grouped" | "legacy-array",
): SkillIntelligenceReport {
  const db = options.db ?? getDb();
  const sessions =
    options.sessions ??
    (observationMode === "legacy-array"
      ? querySessionTelemetry(db)
      : querySessionTelemetryForReports(db, RECENT_PROJECT_SIGNAL_SESSION_LIMIT));
  const contentLoader = options.contentLoader ?? ((path: string) => readFileSync(path, "utf8"));
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const installedSkills = options.installedSkills
    ? attachTrackedSourceIds(options.installedSkills)
    : discoverSkillIntelligenceInstalledSkills({
        db,
        sessions,
        searchDirs: options.searchDirs,
        workspacePaths:
          options.workspacePaths ??
          (options.sessions ? sessions.map((session) => session.cwd) : undefined),
        configRoot,
        quarantineRoot: options.quarantineRoot,
        contentLoader,
      });
  const feedback = loadSkillIntelligenceFeedback(db);
  const serviceOptions: SkillSetServiceOptions = options.configRoot
    ? { configRoot: options.configRoot }
    : {};
  const existingSets = options.existingSets ?? listSkillSets(serviceOptions);
  const outcomeOptions: RefreshSkillSetOutcomesOptions = {
    db,
    configRoot: options.configRoot,
    sets: existingSets,
    now: options.now,
  };
  const outcomes = options.outcomes ?? refreshSkillSetOutcomes(outcomeOptions);
  const calibration = options.calibration ?? feedback.calibration;
  const observationGroups =
    options.observationGroups ??
    (options.observations === undefined && observationMode === "pre-grouped"
      ? aggregateSkillIntelligenceObservations(iterateTrustedSkillObservationRows(db))
      : undefined);
  const observations =
    options.observations ??
    (observationGroups === undefined ? queryTrustedSkillObservationRows(db) : undefined);
  const traceSignals = options.traceSignals ?? [];
  const report = analyzeSkillIntelligence({
    installedSkills,
    observations,
    observationGroups,
    sessions,
    existingSets,
    classificationOverrides: options.classificationOverrides ?? feedback.classificationOverrides,
    suggestionReviews: options.suggestionReviews ?? feedback.suggestionReviews,
    minOccurrences: options.minOccurrences,
    minAffinity: options.minAffinity,
    holdoutRatio: options.holdoutRatio,
    minValidationOccurrences: options.minValidationOccurrences,
    minEvidenceScore: options.minEvidenceScore ?? calibration.applied_min_evidence_score,
    calibration,
    outcomes,
    maxSuggestions: options.maxSuggestions,
    catalogEntries: options.catalogEntries,
    projectSignals:
      options.projectSignals ?? buildRecentProjectSignals(sessions, options.workspacePaths),
    traceSignals,
    now: options.now,
  });
  // Learned suggestion snapshots are intentional report bookkeeping. The dashboard cache
  // records its dependency watermark after computation and excludes this table, so this
  // write cannot cause a self-triggered refresh loop.
  persistSkillSetSuggestionSnapshots(db, report);
  return report;
}

export function loadSkillIntelligence(
  options: LoadSkillIntelligenceOptions = {},
): SkillIntelligenceReport {
  return loadSkillIntelligenceWithObservationMode(options, "pre-grouped");
}

/** @internal Differential-test seam for the pre-aggregation report implementation. */
export function loadSkillIntelligenceLegacyForTest(
  options: LoadSkillIntelligenceOptions = {},
): SkillIntelligenceReport {
  return loadSkillIntelligenceWithObservationMode(options, "legacy-array");
}
