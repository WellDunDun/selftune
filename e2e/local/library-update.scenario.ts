import * as Effect from "effect/Effect";

import {
  Artifacts,
  Browser,
  FixtureData,
  LocalApi,
  RuntimeRestart,
  ScenarioFailure,
  Target,
} from "../src/services";

function ensure(condition: boolean, step: string, message: string) {
  return condition ? Effect.void : Effect.fail(ScenarioFailure.make({ step, message }));
}

export const libraryUpdateServerJourney = Effect.fn("E2E.libraryUpdateServer")(function* () {
  const target = yield* Target;
  const fixtures = yield* FixtureData;
  const browser = yield* Browser;
  const api = yield* LocalApi;
  const restart = yield* RuntimeRestart;
  const artifacts = yield* Artifacts;

  const fixture = yield* fixtures.trackedUpdate();
  yield* artifacts.log(`Target ${target.id} prepared ${fixture.skill_name}.`);

  const before = yield* api.skillState(fixture.skill_name);
  yield* ensure(
    before.update_status === "available" &&
      before.installed_hash === fixture.installed_revision_hash,
    "inspect tracked update",
    `Expected ${fixture.skill_name} at ${fixture.installed_revision_hash} with an available update.`,
  );

  const applied = yield* browser.reviewAndApplyLibraryUpdate(fixture.skill_name);
  yield* ensure(
    applied.installed_hash === fixture.expected_source_hash &&
      applied.receipt_id.length > 0 &&
      applied.receipt_status === "applied",
    "apply reviewed update",
    "The reviewed update did not return the expected revision and recovery receipt.",
  );

  yield* restart.restart();
  const afterRestart = yield* api.skillState(fixture.skill_name);
  yield* ensure(
    afterRestart.update_status === "current" &&
      afterRestart.installed_hash === fixture.expected_revision_hash,
    "verify update after restart",
    `Expected ${fixture.skill_name} to remain at ${fixture.expected_revision_hash} after restart.`,
  );
  yield* artifacts.log(
    `Verified ${fixture.expected_revision_hash} and receipt ${applied.receipt_id}.`,
  );
  return {
    installed_hash: afterRestart.installed_hash,
    receipt_id: applied.receipt_id,
    receipt_status: applied.receipt_status,
  };
});

export const localLibraryUpdateJourney = libraryUpdateServerJourney;
