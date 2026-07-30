export type CatalogExpansionProfileId = "web_full_stack" | "mobile" | "high_rigor_review";
export type CatalogExpansionHarnessId = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export type CatalogExpansionCapabilityId =
  | "architecture"
  | "diagnostics"
  | "frontend_components"
  | "language"
  | "mobile_framework"
  | "planning"
  | "platform"
  | "platform_operations"
  | "react_quality"
  | "rigorous_review"
  | "simulator_tooling"
  | "testing";

export interface CatalogExpansionRelation {
  /** Suppress this entry only when the referenced equivalent is also selected. */
  equivalent_to?: string;
  /** Suppress this child only when the referenced umbrella is also selected. */
  bundled_by?: string;
}

export interface CatalogExpansionCatalogEntry {
  catalog_id: string;
  name: string;
  source: string;
  install_spec: string;
  download_url?: string;
  description?: string;
  capabilities?: ReadonlyArray<CatalogExpansionCapabilityId>;
  relation?: CatalogExpansionRelation;
}

export interface CatalogExpansionInstalledSkill {
  name: string;
  package_path: string;
  source_id?: string | null;
  description?: string;
  content?: string;
  capabilities?: ReadonlyArray<CatalogExpansionCapabilityId>;
  catalog_id?: string;
  relation?: CatalogExpansionRelation;
  harness?: CatalogExpansionHarnessId | null;
}

export interface CatalogExpansionProjectSignals {
  project_root?: string | null;
  dependencies?: ReadonlyArray<string>;
  frameworks?: ReadonlyArray<string>;
  languages?: ReadonlyArray<string>;
  files?: ReadonlyArray<string>;
  intents?: ReadonlyArray<string>;
}

export interface CatalogExpansionInput {
  installed_skills: ReadonlyArray<CatalogExpansionInstalledSkill>;
  catalog_entries: ReadonlyArray<CatalogExpansionCatalogEntry>;
  project_signals: CatalogExpansionProjectSignals;
  max_skills_per_set?: number;
}

export interface CatalogExpansionSkill {
  name: string;
  capability: CatalogExpansionCapabilityId;
  role: string;
  why_included: string;
  provenance: "installed" | "catalog";
  source: string | null;
  catalog_id: string | null;
  install_spec: string | null;
  download_url: string | null;
  package_path: string | null;
}

export interface CatalogSkillSetExpansion {
  expansion_id: string;
  profile_id: CatalogExpansionProfileId;
  name: string;
  description: string;
  evidence_state: "exploratory";
  evidence_basis: "project_context_and_catalog";
  project_root: string | null;
  context_score: number;
  matched_signal_count: number;
  matched_signals: string[];
  skills: CatalogExpansionSkill[];
  harnesses: CatalogExpansionHarnessId[];
  reason: string;
}

interface CapabilitySlot {
  capability: CatalogExpansionCapabilityId;
  required: boolean;
  role: string;
  expressions: ReadonlyArray<RegExp>;
  scoreKey: string;
}

interface ExpansionProfile {
  id: CatalogExpansionProfileId;
  name: string;
  description: string;
  signalExpressions: ReadonlyArray<RegExp>;
  slots: ReadonlyArray<CapabilitySlot>;
  minSignalMatches: number;
  minRequiredCoverage: number;
}

interface Candidate {
  name: string;
  normalizedName: string;
  description: string;
  semanticText: string;
  capabilities: ReadonlySet<CatalogExpansionCapabilityId>;
  provenance: "installed" | "catalog";
  source: string | null;
  catalogId: string | null;
  installSpec: string | null;
  downloadUrl: string | null;
  packagePath: string | null;
  relation: CatalogExpansionRelation;
  harness: CatalogExpansionHarnessId | null;
}

interface SlotSelection {
  slot: CapabilitySlot;
  candidate: Candidate;
  score: number;
}

type CandidateSlotScoreCache = Map<string, Map<Candidate, number>>;

const MATCHED_SIGNAL_SAMPLE_LIMIT = 8;
const MATCHED_SIGNAL_SAMPLE_MAX_LENGTH = 240;

const WEB_SLOTS: ReadonlyArray<CapabilitySlot> = [
  defineSlot("platform", true, "Defines the web runtime and deployment platform.", [
    /\bcloudflare\b/,
    /\bworkers?\b/,
    /\bedge runtime\b/,
    /\bserverless platform\b/,
  ]),
  defineSlot("platform_operations", true, "Operates local development, deployment, and releases.", [
    /\bwrangler\b/,
    /\bdeploy(?:ment)? cli\b/,
    /\bplatform operations?\b/,
  ]),
  defineSlot(
    "frontend_components",
    true,
    "Provides the frontend component and interface workflow.",
    [/\bshadcn\b/, /\bcomponent library\b/, /\bui components?\b/, /\bfrontend components?\b/],
  ),
  defineSlot(
    "react_quality",
    true,
    "Applies React-specific performance and correctness practices.",
    [/\breact best practices?\b/, /\breact performance\b/, /\bnext(?:js| js)? best practices?\b/],
  ),
  defineSlot("architecture", false, "Keeps domain and module boundaries coherent.", [
    /\bcodebase design\b/,
    /\bdomain model(?:ing)?\b/,
    /\bsoftware architecture\b/,
  ]),
  defineSlot("planning", false, "Turns product intent into implementable engineering work.", [
    /\bto issues\b/,
    /\bimplementation plan\b/,
    /\bproject planning\b/,
  ]),
  defineSlot("diagnostics", false, "Provides the debugging and failure-analysis workflow.", [
    /\bdiagnos(?:e|is|tic)\b/,
    /\bdebug(?:ging)?\b/,
    /\broot cause\b/,
  ]),
];

const MOBILE_SLOTS: ReadonlyArray<CapabilitySlot> = [
  defineSlot(
    "mobile_framework",
    true,
    "Provides the cross-platform mobile application framework.",
    [/\bflutter\b/, /\breact native\b/, /\bcross platform mobile\b/],
  ),
  defineSlot("language", true, "Provides language-specific implementation guidance.", [
    /\bdart\b/,
    /\bswift\b/,
    /\bkotlin\b/,
  ]),
  defineSlot("simulator_tooling", true, "Runs and inspects the app in mobile simulators.", [
    /\b(?:serve|surf)[ -]?sim\b/,
    /\bsimulator tooling\b/,
    /\bios simulator\b/,
    /\bandroid emulator\b/,
  ]),
  defineSlot("architecture", false, "Keeps application boundaries and state flows coherent.", [
    /\bcodebase design\b/,
    /\bdomain model(?:ing)?\b/,
    /\bmobile architecture\b/,
  ]),
  defineSlot("planning", false, "Turns the mobile feature into implementable slices.", [
    /\bto issues\b/,
    /\bimplementation plan\b/,
    /\bproject planning\b/,
  ]),
  defineSlot("diagnostics", false, "Provides the debugging and failure-analysis workflow.", [
    /\bdiagnos(?:e|is|tic)\b/,
    /\bdebug(?:ging)?\b/,
    /\broot cause\b/,
  ]),
  defineSlot("testing", false, "Adds a repeatable test-first and regression workflow.", [
    /\btest driven\b/,
    /\btdd\b/,
    /\bregression test\b/,
  ]),
];

const REVIEW_SLOTS: ReadonlyArray<CapabilitySlot> = [
  defineSlot("rigorous_review", true, "Performs adversarial, high-rigor code review.", [
    /\bthermonuclear review\b/,
    /\br(?:igorous|isk) review\b/,
    /\badversarial review\b/,
    /\bcode audit\b/,
  ]),
  defineSlot("diagnostics", true, "Reproduces failures and establishes root cause.", [
    /\bdiagnos(?:e|is|tic)\b/,
    /\bdebug(?:ging)?\b/,
    /\broot cause\b/,
  ]),
  defineSlot("testing", true, "Proves fixes with test-first regression coverage.", [
    /\btest driven\b/,
    /\btdd\b/,
    /\bregression test\b/,
  ]),
  defineSlot("architecture", true, "Reviews module boundaries and codebase design.", [
    /\bcodebase design\b/,
    /\bdomain model(?:ing)?\b/,
    /\bsoftware architecture\b/,
  ]),
];

const PROFILES: ReadonlyArray<ExpansionProfile> = [
  {
    id: "web_full_stack",
    name: "Cloudflare Full-Stack",
    description: "A full-stack web workflow spanning platform, UI, React quality, and delivery.",
    signalExpressions: [
      /\bcloudflare\b/,
      /\bwrangler\b/,
      /\breact\b/,
      /\bnext(?:js| js)?\b/,
      /\bweb\b/,
      /\bfrontend\b/,
      /\bworkers?\b/,
    ],
    slots: WEB_SLOTS,
    minSignalMatches: 1,
    minRequiredCoverage: 1,
  },
  {
    id: "mobile",
    name: "Mobile Engineering",
    description:
      "A mobile workflow spanning implementation, simulator feedback, and engineering rigor.",
    signalExpressions: [
      /\bmobile\b/,
      /\bflutter\b/,
      /\bdart\b/,
      /\bios\b/,
      /\bandroid\b/,
      /\b(?:serve|surf)[ -]?sim\b/,
      /\bsimulator\b/,
      /\bemulator\b/,
    ],
    slots: MOBILE_SLOTS,
    minSignalMatches: 1,
    minRequiredCoverage: 1,
  },
  {
    id: "high_rigor_review",
    name: "High-Rigor Review",
    description: "A review workflow spanning adversarial inspection, diagnosis, tests, and design.",
    signalExpressions: [
      /\breview\b/,
      /\baudit\b/,
      /\bquality\b/,
      /\brefactor\b/,
      /\bregression\b/,
      /\barchitecture\b/,
    ],
    slots: REVIEW_SLOTS,
    minSignalMatches: 1,
    minRequiredCoverage: 1,
  },
];

function defineSlot(
  capability: CatalogExpansionCapabilityId,
  required: boolean,
  role: string,
  expressions: ReadonlyArray<RegExp>,
): CapabilitySlot {
  return {
    capability,
    required,
    role,
    expressions,
    scoreKey: `${capability}\u0000${expressions
      .map((expression) => `${expression.source}/${expression.flags}`)
      .join("\u0000")}`,
  };
}

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function validIdentity(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function catalogCandidate(entry: CatalogExpansionCatalogEntry): Candidate | null {
  const catalogId = validIdentity(entry.catalog_id);
  const name = validIdentity(entry.name);
  const source = validIdentity(entry.source);
  const installSpec = validIdentity(entry.install_spec);
  if (!catalogId || !name || !source || !installSpec) return null;
  const description = entry.description?.trim() ?? "";
  return {
    name,
    normalizedName: normalize(name),
    description,
    semanticText: normalize(`${name} ${description}`),
    capabilities: new Set(entry.capabilities ?? []),
    provenance: "catalog",
    source,
    catalogId,
    installSpec,
    downloadUrl: entry.download_url?.trim() || null,
    packagePath: null,
    relation: entry.relation ?? {},
    harness: null,
  };
}

function installedCandidate(skill: CatalogExpansionInstalledSkill): Candidate | null {
  const name = validIdentity(skill.name);
  const packagePath = validIdentity(skill.package_path);
  if (!name || !packagePath) return null;
  const description = skill.description?.trim() ?? "";
  return {
    name,
    normalizedName: normalize(name),
    description,
    semanticText: normalize(`${name} ${description} ${skill.content ?? ""}`),
    capabilities: new Set(skill.capabilities ?? []),
    provenance: "installed",
    source: skill.source_id?.trim() || null,
    catalogId: skill.catalog_id?.trim() || null,
    installSpec: null,
    downloadUrl: null,
    packagePath,
    relation: skill.relation ?? {},
    harness: skill.harness ?? null,
  };
}

function candidateIdentity(candidate: Candidate): string {
  return candidate.catalogId
    ? `catalog:${candidate.catalogId.toLowerCase()}`
    : candidate.source
      ? `source:${candidate.source.toLowerCase()}@${candidate.normalizedName}`
      : `local:${candidate.packagePath?.toLowerCase() ?? candidate.normalizedName}`;
}

function mergeInstalledWithCatalog(installed: Candidate, catalog: Candidate): Candidate {
  return {
    ...installed,
    source: installed.source ?? catalog.source,
    catalogId: installed.catalogId ?? catalog.catalogId,
    installSpec: catalog.installSpec,
    downloadUrl: catalog.downloadUrl,
    description: installed.description || catalog.description,
    semanticText: normalize(
      `${installed.semanticText} ${catalog.semanticText} ${[...catalog.capabilities].join(" ")}`,
    ),
    capabilities: new Set([...installed.capabilities, ...catalog.capabilities]),
    relation:
      installed.relation.equivalent_to || installed.relation.bundled_by
        ? installed.relation
        : catalog.relation,
    harness: installed.harness,
  };
}

function buildCandidates(input: CatalogExpansionInput): Candidate[] {
  const catalog = input.catalog_entries
    .map(catalogCandidate)
    .filter((candidate): candidate is Candidate => candidate !== null);
  const catalogByIdentity = new Map(
    catalog.map((candidate) => [candidateIdentity(candidate), candidate]),
  );
  const catalogBySourceAndName = new Map(
    catalog
      .filter((candidate) => candidate.source !== null)
      .map((candidate) => [
        `${candidate.source?.toLowerCase()}@${candidate.normalizedName}`,
        candidate,
      ]),
  );
  const installed = input.installed_skills
    .map(installedCandidate)
    .filter((candidate): candidate is Candidate => candidate !== null)
    .map((candidate) => {
      const exact = catalogByIdentity.get(candidateIdentity(candidate));
      const bySource = candidate.source
        ? catalogBySourceAndName.get(
            `${candidate.source.toLowerCase()}@${candidate.normalizedName}`,
          )
        : undefined;
      const matchingCatalog = exact ?? bySource;
      return matchingCatalog ? mergeInstalledWithCatalog(candidate, matchingCatalog) : candidate;
    });
  const installedIdentities = new Set(installed.map(candidateIdentity));
  return [
    ...installed,
    ...catalog.filter((candidate) => !installedIdentities.has(candidateIdentity(candidate))),
  ];
}

function projectSignalText(signals: CatalogExpansionProjectSignals): string[] {
  return [
    ...(signals.dependencies ?? []),
    ...(signals.frameworks ?? []),
    ...(signals.languages ?? []),
    ...(signals.files ?? []),
    ...(signals.intents ?? []),
  ]
    .map(normalize)
    .filter(Boolean);
}

function matchingSignals(profile: ExpansionProfile, signals: ReadonlyArray<string>): string[] {
  return signals.filter((signal) =>
    profile.signalExpressions.some((expression) => expression.test(signal)),
  );
}

function canonicalCapabilityNameScore(
  capability: CatalogExpansionCapabilityId,
  normalizedName: string,
): number {
  if (capability === "platform") return normalizedName === "cloudflare" ? 200 : 0;
  if (capability === "platform_operations") return normalizedName === "wrangler" ? 200 : 0;
  if (capability === "frontend_components") return normalizedName === "shadcn" ? 200 : 0;
  if (capability === "react_quality") {
    return /\breact best practices\b/.test(normalizedName) ? 200 : 0;
  }
  if (capability === "mobile_framework") {
    if (normalizedName === "flutter apply architecture best practices") return 250;
    if (/^flutter\b/.test(normalizedName) && !/\b(?:test|testing)\b/.test(normalizedName))
      return 150;
    if (/^react native\b/.test(normalizedName)) return 150;
    return /\b(?:test|testing)\b/.test(normalizedName) ? -100 : 0;
  }
  if (capability === "language") {
    if (normalizedName === "dart run static analysis") return 250;
    if (/^(?:dart|swift|kotlin)\b/.test(normalizedName)) {
      return /\b(?:test|testing)\b/.test(normalizedName) ? -100 : 200;
    }
    return 0;
  }
  if (capability === "simulator_tooling") return normalizedName === "serve sim" ? 250 : 0;
  if (capability === "rigorous_review") {
    return normalizedName === "thermonuclear review" ? 250 : 0;
  }
  if (capability === "diagnostics") return normalizedName === "diagnose" ? 250 : 0;
  if (capability === "testing") return normalizedName === "tdd" ? 250 : 0;
  if (capability === "architecture") {
    return /^(?:codebase design|domain model|domain modeling)$/.test(normalizedName) ? 200 : 0;
  }
  if (capability === "planning") return normalizedName === "to issues" ? 200 : 0;
  return 0;
}

function candidateSlotScore(candidate: Candidate, slot: CapabilitySlot): number {
  const declared = candidate.capabilities.has(slot.capability);
  const canonicalNameScore = canonicalCapabilityNameScore(
    slot.capability,
    candidate.normalizedName,
  );
  let nameMatches = 0;
  let semanticMatches = 0;
  for (const expression of slot.expressions) {
    if (expression.test(candidate.normalizedName)) nameMatches += 1;
    if (expression.test(candidate.semanticText)) semanticMatches += 1;
  }
  if (!declared && semanticMatches === 0) return 0;
  if (slot.capability === "rigorous_review" && !declared && canonicalNameScore === 0) return 0;
  return (
    (declared ? 100 : 0) +
    canonicalNameScore +
    nameMatches * 50 +
    semanticMatches * 10 +
    (candidate.provenance === "installed" ? 3 : 0) +
    (candidate.installSpec ? 1 : 0) -
    (relationTarget(candidate.relation) ? 2 : 0)
  );
}

function cachedCandidateSlotScore(
  candidate: Candidate,
  slot: CapabilitySlot,
  cache: CandidateSlotScoreCache,
): number {
  let scores = cache.get(slot.scoreKey);
  if (!scores) {
    scores = new Map();
    cache.set(slot.scoreKey, scores);
  }
  const cached = scores.get(candidate);
  if (cached !== undefined) return cached;
  const score = candidateSlotScore(candidate, slot);
  scores.set(candidate, score);
  return score;
}

function selectSlots(
  profile: ExpansionProfile,
  candidates: ReadonlyArray<Candidate>,
  scoreCache: CandidateSlotScoreCache,
): SlotSelection[] {
  const used = new Set<string>();
  const selections: SlotSelection[] = [];
  for (const capabilitySlot of profile.slots) {
    const ranked = candidates
      .map((candidate) => ({
        slot: capabilitySlot,
        candidate,
        score: cachedCandidateSlotScore(candidate, capabilitySlot, scoreCache),
      }))
      .filter(
        (selection) => selection.score > 0 && !used.has(candidateIdentity(selection.candidate)),
      )
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          left.candidate.normalizedName.localeCompare(right.candidate.normalizedName) ||
          candidateIdentity(left.candidate).localeCompare(candidateIdentity(right.candidate)),
      );
    const selected = ranked[0];
    if (!selected) continue;
    selections.push(selected);
    used.add(candidateIdentity(selected.candidate));
  }
  return selections;
}

function relationTarget(relation: CatalogExpansionRelation): string | null {
  return relation.equivalent_to?.trim() || relation.bundled_by?.trim() || null;
}

function removeExplicitDuplicates(selections: ReadonlyArray<SlotSelection>): SlotSelection[] {
  const selectedCatalogIds = new Set(
    selections
      .map(({ candidate }) => candidate.catalogId)
      .filter((catalogId): catalogId is string => catalogId !== null),
  );
  return selections.filter(({ candidate }) => {
    const target = relationTarget(candidate.relation);
    return !target || !selectedCatalogIds.has(target);
  });
}

function requiredCoverage(
  profile: ExpansionProfile,
  selections: ReadonlyArray<SlotSelection>,
): number {
  const required = profile.slots.filter((capabilitySlot) => capabilitySlot.required);
  const selected = new Set(selections.map(({ slot: selectedSlot }) => selectedSlot.capability));
  return required.length === 0
    ? 1
    : required.filter((capabilitySlot) => selected.has(capabilitySlot.capability)).length /
        required.length;
}

function stableId(profile: ExpansionProfile, selections: ReadonlyArray<SlotSelection>): string {
  const identities = selections.map(({ candidate }) => candidateIdentity(candidate)).toSorted();
  let hash = 2166136261;
  for (const character of `${profile.id}\u0000${identities.join("\u0000")}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `catalog-${profile.id}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function includedReason(selection: SlotSelection): string {
  const origin =
    selection.candidate.provenance === "installed"
      ? "It is already installed"
      : `It is an authoritative catalog result from ${selection.candidate.source}`;
  return `${origin} and matches the ${selection.slot.capability.replaceAll("_", " ")} capability.`;
}

function toExpansionSkill(selection: SlotSelection): CatalogExpansionSkill {
  const candidate = selection.candidate;
  return {
    name: candidate.name,
    capability: selection.slot.capability,
    role: selection.slot.role,
    why_included: includedReason(selection),
    provenance: candidate.provenance,
    source: candidate.source,
    catalog_id: candidate.catalogId,
    install_spec: candidate.installSpec,
    download_url: candidate.downloadUrl,
    package_path: candidate.packagePath,
  };
}

/**
 * Builds exploratory project sets from local semantics plus caller-supplied catalog results.
 * It does not consume or relabel observed usage suggestions; those remain the evidence-backed
 * output of `analyzeSkillIntelligence`.
 */
export function suggestCatalogSkillSetExpansions(
  input: CatalogExpansionInput,
): CatalogSkillSetExpansion[] {
  const candidates = buildCandidates(input);
  const signalText = projectSignalText(input.project_signals);
  const maxSkills = Math.max(3, Math.min(12, input.max_skills_per_set ?? 7));
  const expansions: CatalogSkillSetExpansion[] = [];
  const scoreCache: CandidateSlotScoreCache = new Map();

  for (const profile of PROFILES) {
    const matchedSignals = [...new Set(matchingSignals(profile, signalText))].toSorted();
    if (matchedSignals.length < profile.minSignalMatches) continue;
    const selections = removeExplicitDuplicates(selectSlots(profile, candidates, scoreCache)).slice(
      0,
      maxSkills,
    );
    const coverage = requiredCoverage(profile, selections);
    if (coverage < profile.minRequiredCoverage) continue;
    expansions.push({
      expansion_id: stableId(profile, selections),
      profile_id: profile.id,
      name: profile.name,
      description: profile.description,
      evidence_state: "exploratory",
      evidence_basis: "project_context_and_catalog",
      project_root: input.project_signals.project_root ?? null,
      context_score: Number(
        Math.min(
          1,
          matchedSignals.length / profile.signalExpressions.length + coverage * 0.5,
        ).toFixed(3),
      ),
      matched_signal_count: matchedSignals.length,
      matched_signals: matchedSignals
        .slice(0, MATCHED_SIGNAL_SAMPLE_LIMIT)
        .map((signal) => signal.slice(0, MATCHED_SIGNAL_SAMPLE_MAX_LENGTH)),
      skills: selections.map(toExpansionSkill),
      harnesses: [
        ...new Set(
          selections
            .map(({ candidate }) => candidate.harness)
            .filter((harness): harness is CatalogExpansionHarnessId => harness !== null),
        ),
      ].toSorted(),
      reason: input.project_signals.project_root
        ? "Suggested from project semantics and catalog-resolved identities. This set has not been validated by recurring local usage or measured outcomes."
        : "Suggested from portfolio and workspace history plus catalog-resolved identities. This set has not been validated by recurring local usage or measured outcomes.",
    });
  }

  return expansions.toSorted(
    (left, right) =>
      right.context_score - left.context_score || left.name.localeCompare(right.name),
  );
}
