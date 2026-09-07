import { Option, Schema } from "effect";
import { flow } from "effect/Function";

/** Semantic resources shared by dashboard queries, mutations, and live events. */
export const DashboardResource = {
  libraryInventory: "library-inventory",
  libraryDetail: "library-detail",
  skillIntelligence: "skill-intelligence",
  overview: "overview",
  sourceUpdate: "source-update",
  sourceMergeDecisions: "source-merge-decisions",
  decisions: "decisions",
  projects: "projects",
  insightsQueue: "insights-queue",
  proposals: "proposals",
  operationalState: "operational-state",
} as const;

export type DashboardResource = (typeof DashboardResource)[keyof typeof DashboardResource];

export const sourceUpdateResources = {
  preview: [DashboardResource.sourceUpdate],
  prepareMerge: [DashboardResource.sourceUpdate],
  apply: [
    DashboardResource.libraryInventory,
    DashboardResource.libraryDetail,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.sourceUpdate,
    DashboardResource.projects,
  ],
} as const satisfies Record<string, readonly DashboardResource[]>;

export const sourceMergeDecisionResources = {
  prepare: [
    DashboardResource.sourceUpdate,
    DashboardResource.sourceMergeDecisions,
    DashboardResource.decisions,
  ],
  decide: [DashboardResource.sourceMergeDecisions, DashboardResource.decisions],
  approve: [
    DashboardResource.sourceMergeDecisions,
    DashboardResource.decisions,
    DashboardResource.libraryInventory,
    DashboardResource.libraryDetail,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.sourceUpdate,
    DashboardResource.projects,
  ],
} as const satisfies Record<string, readonly DashboardResource[]>;

export const durableDecisionResources = {
  prepare: [DashboardResource.decisions],
  decide: [DashboardResource.decisions],
  approve: [
    DashboardResource.decisions,
    DashboardResource.sourceMergeDecisions,
    DashboardResource.libraryInventory,
    DashboardResource.libraryDetail,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.sourceUpdate,
    DashboardResource.projects,
  ],
  rollback: [
    DashboardResource.decisions,
    DashboardResource.libraryInventory,
    DashboardResource.libraryDetail,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.projects,
  ],
} as const satisfies Record<string, readonly DashboardResource[]>;

/** Project Skill Set catalog and materialization lifecycle resources. */
export type ProjectSkillSetMutation =
  | "create"
  | "update"
  | "remove"
  | "derive"
  | "export"
  | "plan"
  | "apply"
  | "rollback";

const projectMaterializationResources = [
  DashboardResource.projects,
  DashboardResource.libraryInventory,
  DashboardResource.libraryDetail,
  DashboardResource.skillIntelligence,
  DashboardResource.overview,
] as const satisfies readonly DashboardResource[];

export const projectSkillSetResources = {
  create: [DashboardResource.projects],
  update: [DashboardResource.projects],
  remove: [DashboardResource.projects],
  derive: [DashboardResource.projects],
  export: [DashboardResource.projects],
  plan: [DashboardResource.projects],
  apply: projectMaterializationResources,
  rollback: projectMaterializationResources,
} as const satisfies Record<ProjectSkillSetMutation, readonly DashboardResource[]>;

/** Insights queue decisions and their derived draft/release proposal lifecycle. */
export const insightDecisionResources = {
  review: [
    DashboardResource.insightsQueue,
    DashboardResource.overview,
    DashboardResource.proposals,
  ],
  draft: [
    DashboardResource.insightsQueue,
    DashboardResource.libraryInventory,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.proposals,
  ],
  evaluate: [DashboardResource.insightsQueue, DashboardResource.proposals],
  release: [
    DashboardResource.insightsQueue,
    DashboardResource.libraryInventory,
    DashboardResource.skillIntelligence,
    DashboardResource.overview,
    DashboardResource.proposals,
  ],
} as const satisfies Record<string, readonly DashboardResource[]>;

/** Removing or restoring an installed location can change each derived Library view. */
export const libraryLocationWriteResources = [
  DashboardResource.libraryInventory,
  DashboardResource.libraryDetail,
  DashboardResource.skillIntelligence,
  DashboardResource.overview,
  DashboardResource.sourceUpdate,
  DashboardResource.projects,
] as const satisfies readonly DashboardResource[];

/** SQLite WAL updates deliberately omit the expensive bounded intelligence analysis. */
export const databaseLiveResources = [
  DashboardResource.libraryInventory,
  DashboardResource.libraryDetail,
  DashboardResource.overview,
  DashboardResource.projects,
  DashboardResource.operationalState,
] as const satisfies readonly DashboardResource[];

/** Finished agent actions can change any locally-derived product view. */
export const dashboardActionFinishedResources = [
  ...databaseLiveResources,
  DashboardResource.skillIntelligence,
  DashboardResource.sourceUpdate,
  DashboardResource.decisions,
] as const satisfies readonly DashboardResource[];

const Resource = Schema.Literals(Object.values(DashboardResource));
export const DashboardUpdateEvent = Schema.Struct({
  type: Schema.Literal("update"),
  ts: Schema.Number,
  resources: Schema.Array(Resource),
});
export type DashboardUpdateEvent = typeof DashboardUpdateEvent.Type;
export const isDashboardResource = Schema.is(Resource);

// Older events can omit resources or contain a mix of recognized and retired names.
const ResourcePayload = Schema.Struct({ resources: Schema.Array(Schema.Unknown) });
function resourcesFromDecoded(
  payload: Option.Option<typeof ResourcePayload.Type>,
): readonly DashboardResource[] {
  if (Option.isNone(payload)) return databaseLiveResources;
  const resources = payload.value.resources.filter(isDashboardResource);
  return resources.length > 0 ? resources : databaseLiveResources;
}

export const dashboardUpdateResources = flow(
  Schema.decodeUnknownOption(ResourcePayload),
  resourcesFromDecoded,
);
export const dashboardUpdateResourcesFromJson = flow(
  Schema.decodeUnknownOption(Schema.fromJsonString(ResourcePayload)),
  resourcesFromDecoded,
);
