import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WindowsServiceInstallationArtifactStore } from "../artifact-store.js";
import { matchLegacyWindowsServiceTaskDefinition } from "./evidence.js";
import {
  canonicalWindowsPathIdentity,
  sha256Hex,
  type WindowsServiceInstallationArtifactRecord,
  type WindowsServiceInstallationArtifacts,
} from "./model.js";
import type { WindowsServiceInstallationStoreWithLegacyCleanup } from "./store.js";
import {
  expectWindowsServiceLegacyCleanup,
  type WindowsServiceLegacyCleanupJournal,
  type WindowsServiceLegacyCleanupJournalInput,
} from "./legacy-cleanup.js";
import type { WindowsTaskScheduler } from "../scheduler.js";

export interface WindowsServiceLegacyCleanupControllerDependencies {
  readonly artifacts: Pick<WindowsServiceInstallationArtifactStore, "read" | "removeMatching">;
  readonly schedulerFor: (taskName: string) => WindowsTaskScheduler<unknown>;
  readonly store: WindowsServiceInstallationStoreWithLegacyCleanup;
}

export type WindowsServiceLegacyCleanupInspection =
  | {
      readonly _tag: "Pending";
      readonly journal: WindowsServiceLegacyCleanupJournal;
      readonly task: { readonly registered: boolean; readonly running: boolean };
    }
  | {
      readonly _tag: "Refused";
      readonly reason: string;
      readonly task: { readonly registered: boolean; readonly running: boolean };
    };

export class WindowsServiceLegacyCleanupControllerError extends Schema.TaggedErrorClass<WindowsServiceLegacyCleanupControllerError>()(
  "WindowsServiceLegacyCleanupControllerError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}

function failure(operation: string, cause: unknown): WindowsServiceLegacyCleanupControllerError {
  return WindowsServiceLegacyCleanupControllerError.make({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

function mapFailure<A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((cause) => failure(operation, cause)));
}

function sameSid(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

export function makeWindowsServiceLegacyCleanupController(
  dependencies: WindowsServiceLegacyCleanupControllerDependencies,
) {
  const readArtifact = (path: string) =>
    mapFailure("read-legacy-cleanup-artifact", dependencies.artifacts.read(path));
  const requireJournal = (journal: WindowsServiceLegacyCleanupJournal, operation: string) =>
    mapFailure(
      operation,
      dependencies.store.requireLegacyCleanup(
        journal.configDir,
        expectWindowsServiceLegacyCleanup(journal),
        operation,
      ),
    );
  const artifactState = Effect.fn("SelfTuneService.windowsLegacyCleanup.artifactState")(function* (
    artifact: WindowsServiceInstallationArtifactRecord,
  ) {
    const contents = yield* readArtifact(artifact.path);
    if (contents === null) return "missing";
    return sha256Hex(contents) === artifact.sha256 ? "matching" : "mismatch";
  });
  const artifactSetState = Effect.fn("SelfTuneService.windowsLegacyCleanup.artifactSetState")(
    function* (artifacts: WindowsServiceInstallationArtifacts) {
      const states = yield* Effect.all([
        artifactState(artifacts.taskDefinition),
        artifactState(artifacts.launcher),
        artifactState(artifacts.wrapper),
      ]);
      if (states.includes("mismatch")) return "mismatch";
      return states.every((state) => state === "matching") ? "matching" : "partially-missing";
    },
  );
  const taskDefinitionMatches = Effect.fn(
    "SelfTuneService.windowsLegacyCleanup.taskDefinitionMatches",
  )(function* (
    scheduler: WindowsTaskScheduler<unknown>,
    journal: WindowsServiceLegacyCleanupJournal,
  ) {
    const definition = yield* mapFailure(
      "read-legacy-cleanup-task-definition",
      scheduler.readDefinition(),
    );
    return (
      definition !== null &&
      matchLegacyWindowsServiceTaskDefinition(definition, {
        boot: journal.boot,
        launcherPath: journal.artifacts.launcher.path,
        userSid: journal.userSid,
        wscriptPath: journal.wscriptPath,
      }).matches
    );
  });
  const removeArtifact = Effect.fn("SelfTuneService.windowsLegacyCleanup.removeArtifact")(
    function* (
      journal: WindowsServiceLegacyCleanupJournal,
      artifact: WindowsServiceInstallationArtifactRecord,
    ) {
      yield* requireJournal(journal, "verify-legacy-cleanup-before-artifact-remove");
      yield* mapFailure(
        "remove-legacy-cleanup-artifact",
        dependencies.artifacts.removeMatching({ artifact, generation: journal.cleanupId }),
      );
    },
  );

  const complete = Effect.fn("SelfTuneService.windowsLegacyCleanup.complete")(function* (
    journal: WindowsServiceLegacyCleanupJournal,
  ) {
    const currentUserSid = yield* mapFailure(
      "resolve-legacy-cleanup-user-sid",
      dependencies.store.resolveCurrentUserSid(),
    );
    if (!sameSid(currentUserSid, journal.userSid)) {
      return yield* Effect.fail(
        failure(
          "verify-legacy-cleanup-user-sid",
          "The Windows legacy cleanup journal belongs to another user SID.",
        ),
      );
    }
    yield* requireJournal(journal, "verify-legacy-cleanup-before-task-query");
    const scheduler = dependencies.schedulerFor(journal.taskName);
    const task = yield* mapFailure("query-legacy-cleanup-task", scheduler.query());
    const artifacts = yield* artifactSetState(journal.artifacts);
    if (artifacts === "mismatch") {
      return yield* Effect.fail(
        failure(
          "verify-legacy-cleanup-artifacts",
          "A recorded legacy cleanup artifact no longer matches its journal digest.",
        ),
      );
    }
    if (task.registered) {
      if (artifacts !== "matching") {
        return yield* Effect.fail(
          failure(
            "verify-legacy-cleanup-artifacts",
            "A registered legacy task has missing cleanup artifacts.",
          ),
        );
      }
      if (!(yield* taskDefinitionMatches(scheduler, journal))) {
        return yield* Effect.fail(
          failure(
            "verify-legacy-cleanup-task-definition",
            "The registered legacy task no longer matches its cleanup journal.",
          ),
        );
      }
      yield* requireJournal(journal, "verify-legacy-cleanup-before-task-end");
      yield* mapFailure("end-legacy-cleanup-task", scheduler.end());
      yield* requireJournal(journal, "verify-legacy-cleanup-before-task-delete");
      const beforeDelete = yield* mapFailure(
        "query-legacy-cleanup-task-before-delete",
        scheduler.query(),
      );
      if (!beforeDelete.registered || !(yield* taskDefinitionMatches(scheduler, journal))) {
        return yield* Effect.fail(
          failure(
            "verify-legacy-cleanup-task-before-delete",
            "The legacy task changed after it was stopped.",
          ),
        );
      }
      yield* mapFailure("delete-legacy-cleanup-task", scheduler.delete());
    }
    const afterDelete = yield* mapFailure("confirm-legacy-cleanup-task-absence", scheduler.query());
    if (afterDelete.registered) {
      return yield* Effect.fail(
        failure(
          "confirm-legacy-cleanup-task-absence",
          "The recorded legacy task remained registered.",
        ),
      );
    }
    yield* removeArtifact(journal, journal.artifacts.taskDefinition);
    yield* removeArtifact(journal, journal.artifacts.launcher);
    yield* removeArtifact(journal, journal.artifacts.wrapper);
    const finalArtifacts = yield* Effect.all([
      readArtifact(journal.artifacts.taskDefinition.path),
      readArtifact(journal.artifacts.launcher.path),
      readArtifact(journal.artifacts.wrapper.path),
    ]);
    if (finalArtifacts.some((artifact) => artifact !== null)) {
      return yield* Effect.fail(
        failure(
          "confirm-legacy-cleanup-artifact-absence",
          "A recorded legacy cleanup artifact remained on disk.",
        ),
      );
    }
    const finalTask = yield* mapFailure(
      "confirm-final-legacy-cleanup-task-absence",
      scheduler.query(),
    );
    if (finalTask.registered) {
      return yield* Effect.fail(
        failure(
          "confirm-final-legacy-cleanup-task-absence",
          "The recorded legacy task reappeared before journal removal.",
        ),
      );
    }
    yield* requireJournal(journal, "verify-legacy-cleanup-before-journal-remove");
    yield* mapFailure(
      "remove-legacy-cleanup-journal",
      dependencies.store.removeLegacyCleanup(
        journal.configDir,
        expectWindowsServiceLegacyCleanup(journal),
      ),
    );
  });

  const begin = Effect.fn("SelfTuneService.windowsLegacyCleanup.begin")(function* (
    input: WindowsServiceLegacyCleanupJournalInput,
  ) {
    const journal = yield* mapFailure(
      "create-legacy-cleanup-journal",
      dependencies.store.createLegacyCleanup(input),
    );
    yield* complete(journal);
  });

  const inspect = Effect.fn("SelfTuneService.windowsLegacyCleanup.inspect")(function* (
    configDir: string,
    currentUserSid: string,
  ) {
    const journal = yield* mapFailure(
      "read-legacy-cleanup-journal",
      dependencies.store.readLegacyCleanup(configDir),
    );
    if (journal === null) return null;
    const scheduler = dependencies.schedulerFor(journal.taskName);
    const task = yield* mapFailure("query-legacy-cleanup-task", scheduler.query());
    if (
      canonicalWindowsPathIdentity(journal.configDir) !== canonicalWindowsPathIdentity(configDir)
    ) {
      return {
        _tag: "Refused",
        reason: "legacy-cleanup-config-mismatch",
        task,
      } satisfies WindowsServiceLegacyCleanupInspection;
    }
    if (!sameSid(currentUserSid, journal.userSid)) {
      return {
        _tag: "Refused",
        reason: "legacy-cleanup-user-sid-mismatch",
        task,
      } satisfies WindowsServiceLegacyCleanupInspection;
    }
    const artifacts = yield* artifactSetState(journal.artifacts);
    if (artifacts === "mismatch" || (task.registered && artifacts !== "matching")) {
      return {
        _tag: "Refused",
        reason: "legacy-cleanup-artifact-state-mismatch",
        task,
      } satisfies WindowsServiceLegacyCleanupInspection;
    }
    if (task.registered && !(yield* taskDefinitionMatches(scheduler, journal))) {
      return {
        _tag: "Refused",
        reason: "legacy-cleanup-task-definition-mismatch",
        task,
      } satisfies WindowsServiceLegacyCleanupInspection;
    }
    return { _tag: "Pending", journal, task } satisfies WindowsServiceLegacyCleanupInspection;
  });

  const resume = Effect.fn("SelfTuneService.windowsLegacyCleanup.resume")(function* (
    configDir: string,
  ) {
    const journal = yield* mapFailure(
      "read-legacy-cleanup-journal",
      dependencies.store.readLegacyCleanup(configDir),
    );
    if (journal === null) return;
    if (
      canonicalWindowsPathIdentity(journal.configDir) !== canonicalWindowsPathIdentity(configDir)
    ) {
      return yield* Effect.fail(
        failure(
          "verify-legacy-cleanup-config",
          "The Windows legacy cleanup journal has a mismatched config identity.",
        ),
      );
    }
    yield* complete(journal);
  });

  return { begin, complete, inspect, resume };
}
