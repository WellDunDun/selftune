import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CapabilityUnavailable extends Schema.TaggedErrorClass<CapabilityUnavailable>()(
  "CapabilityUnavailable",
  {
    capability: Schema.String,
    reason: Schema.String,
  },
) {}

export class ScenarioFailure extends Schema.TaggedErrorClass<ScenarioFailure>()("ScenarioFailure", {
  step: Schema.String,
  message: Schema.String,
}) {}

export function capabilityUnavailable(
  capability: string,
  reason: string,
): Effect.Effect<never, CapabilityUnavailable> {
  return Effect.fail(CapabilityUnavailable.make({ capability, reason }));
}

export interface BrowserUpdateResult {
  receipt_id: string;
  receipt_status: "applied";
  installed_hash: string;
}

export class Target extends Context.Service<
  Target,
  { readonly id: string; readonly worktree: string }
>()("@selftune/e2e/Target") {}

export class Browser extends Context.Service<
  Browser,
  {
    readonly reviewAndApplyLibraryUpdate: (
      skillName: string,
    ) => Effect.Effect<BrowserUpdateResult, CapabilityUnavailable | ScenarioFailure>;
  }
>()("@selftune/e2e/Browser") {}

export class DesktopApplication extends Context.Service<
  DesktopApplication,
  {
    readonly applyLibraryUpdate: (
      fixture: TrackedUpdateFixture,
    ) => Effect.Effect<BrowserUpdateResult, CapabilityUnavailable | ScenarioFailure>;
  }
>()("@selftune/e2e/DesktopApplication") {}

export interface LibrarySkillState {
  name: string;
  update_status: "available" | "current" | "unknown" | "untracked";
  installed_hash: string | null;
}

export class LocalApi extends Context.Service<
  LocalApi,
  {
    readonly skillState: (
      skillName: string,
    ) => Effect.Effect<LibrarySkillState, CapabilityUnavailable | ScenarioFailure>;
  }
>()("@selftune/e2e/LocalApi") {}

export class RuntimeRestart extends Context.Service<
  RuntimeRestart,
  { readonly restart: () => Effect.Effect<void, CapabilityUnavailable | ScenarioFailure> }
>()("@selftune/e2e/RuntimeRestart") {}

export interface TrackedUpdateFixture {
  skill_name: string;
  installed_revision_hash: string;
  expected_revision_hash: string;
  expected_source_hash: string;
}

export class FixtureData extends Context.Service<
  FixtureData,
  {
    readonly trackedUpdate: () => Effect.Effect<
      TrackedUpdateFixture,
      CapabilityUnavailable | ScenarioFailure
    >;
  }
>()("@selftune/e2e/FixtureData") {}

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly runDirectory: string;
    readonly log: (message: string) => Effect.Effect<void, ScenarioFailure>;
  }
>()("@selftune/e2e/Artifacts") {}

export type ScenarioError = CapabilityUnavailable | ScenarioFailure;
