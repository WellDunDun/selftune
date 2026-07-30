import * as Effect from "effect/Effect";

import {
  Artifacts,
  DesktopApplication,
  FixtureData,
  ScenarioFailure,
  Target,
} from "../src/services";

export const desktopLibraryUpdateJourney = Effect.fn("E2E.desktopLibraryUpdate")(function* () {
  const target = yield* Target;
  const fixtures = yield* FixtureData;
  const desktop = yield* DesktopApplication;
  const artifacts = yield* Artifacts;
  const fixture = yield* fixtures.trackedUpdate();

  yield* artifacts.log(`Launching packaged ${target.id} for ${fixture.skill_name}.`);
  const result = yield* desktop.applyLibraryUpdate(fixture);
  if (
    result.installed_hash !== fixture.expected_revision_hash ||
    result.receipt_id.length === 0 ||
    result.receipt_status !== "applied"
  ) {
    return yield* ScenarioFailure.make({
      step: "verify packaged Desktop update",
      message: "Desktop did not preserve the expected revision and recovery receipt.",
    });
  }
  yield* artifacts.log(
    `Verified ${fixture.expected_revision_hash} and receipt ${result.receipt_id}.`,
  );
  return result;
});
