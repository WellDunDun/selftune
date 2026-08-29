import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { inspectDurableArtifactSet } from "../../authority/durable-artifact.js";
import { reproveAuthority } from "../../authority/reproof.js";
import {
  acceptsWindowsInstallationControl,
  acceptsWindowsInstallationInstall,
  sameWindowsInstallationAuthority,
} from "./authority.js";
import {
  createWindowsServiceInstallationReceipt,
  matchWindowsServiceInstallation,
  sameWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationArtifacts,
  type WindowsServiceInstallationReceipt,
} from "./model.js";
import type {
  WindowsServiceInstallationEvidence,
  WindowsServiceLegacyRuntimeIdentity,
} from "./contract.js";
import type { WindowsServiceInstallationArtifactStore } from "../artifact-store.js";
import {
  inspectWindowsServiceTaskPrincipalScope,
  matchLegacyWindowsServiceTaskDefinition,
  matchWindowsServiceTaskDefinition,
  type WindowsServiceTaskDefinitionExpectation,
} from "./evidence.js";
import {
  expectAbsentWindowsServiceInstallationReceipt,
  expectWindowsServiceInstallationReceipt,
  type WindowsServiceInstallationReceiptExpectation,
  type WindowsServiceInstallationReceiptInput,
  type WindowsServiceInstallationStoreWithLegacyCleanup,
} from "./store.js";
import { makeWindowsServiceLegacyCleanupController } from "./legacy-cleanup-controller.js";
import type { WindowsServiceLegacyCleanupJournal } from "./legacy-cleanup.js";
import type { WindowsScheduledTaskState, WindowsTaskScheduler } from "../scheduler.js";

const PLACEHOLDER_SHA256 = "0".repeat(64);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WindowsServiceInstallationArtifactPaths {
  readonly launcher: string;
  readonly taskDefinition: string;
  readonly wrapper: string;
}

export interface WindowsServiceInstallationRenderedArtifacts {
  readonly launcher: Uint8Array;
  readonly taskDefinitionXml: string;
  readonly wrapper: Uint8Array;
}

export interface WindowsServiceLegacyArtifactContents {
  readonly launcher: Uint8Array;
  readonly taskDefinition: Uint8Array;
  readonly wrapper: Uint8Array;
}

export interface WindowsServiceLegacyInstallation {
  readonly artifacts: WindowsServiceInstallationArtifacts;
  readonly boot: boolean;
  readonly matchArtifacts?: (contents: WindowsServiceLegacyArtifactContents) => boolean;
  readonly runtimeIdentity?: WindowsServiceLegacyRuntimeIdentity;
  readonly taskName: string;
  readonly wscriptPath: string;
}

export interface WindowsServiceInstallationPlan {
  readonly artifactPaths: (installId: string) => WindowsServiceInstallationArtifactPaths;
  readonly encodeTaskDefinition: (xml: string) => Uint8Array;
  readonly legacy?: WindowsServiceLegacyInstallation;
  readonly legacyTaskName?: string;
  readonly receipt: Omit<WindowsServiceInstallationReceiptInput, "artifacts" | "taskName">;
  readonly renderArtifacts: (
    receipt: WindowsServiceInstallationReceipt,
  ) => WindowsServiceInstallationRenderedArtifacts;
  readonly taskNamePrefix: string;
  readonly triggerUserAliases?: ReadonlyArray<string>;
  readonly wscriptPath: string;
}

export type { WindowsServiceInstallationArtifactStore } from "../artifact-store.js";

export class WindowsServiceInstallationControllerError extends Schema.TaggedErrorClass<WindowsServiceInstallationControllerError>()(
  "WindowsServiceInstallationControllerError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export interface WindowsServiceInstallationController {
  readonly install: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<WindowsServiceInstallationReceipt, WindowsServiceInstallationControllerError>;
  readonly inspect: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<WindowsServiceInstallationEvidence, WindowsServiceInstallationControllerError>;
  readonly restart: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<void, WindowsServiceInstallationControllerError>;
  readonly start: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<void, WindowsServiceInstallationControllerError>;
  readonly status: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<WindowsServiceInstallationEvidence, WindowsServiceInstallationControllerError>;
  readonly stop: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<void, WindowsServiceInstallationControllerError>;
  readonly uninstall: (
    plan: WindowsServiceInstallationPlan,
  ) => Effect.Effect<void, WindowsServiceInstallationControllerError>;
}

export interface WindowsServiceInstallationControllerDependencies {
  readonly artifacts: WindowsServiceInstallationArtifactStore;
  readonly schedulerFor: (taskName: string) => WindowsTaskScheduler<unknown>;
  readonly store: WindowsServiceInstallationStoreWithLegacyCleanup;
}

function controllerFailure(
  operation: string,
  cause: unknown,
): WindowsServiceInstallationControllerError {
  return WindowsServiceInstallationControllerError.make({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

function mapFailure<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WindowsServiceInstallationControllerError, R> {
  return effect.pipe(Effect.mapError((cause) => controllerFailure(operation, cause)));
}

function refused(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
  reason: string,
): WindowsServiceInstallationEvidence {
  return { _tag: "Refused", currentUserSid, reason, task };
}

function absent(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
): WindowsServiceInstallationEvidence {
  return { _tag: "Absent", currentUserSid, task };
}

function owned(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
  receipt: WindowsServiceInstallationReceipt,
): WindowsServiceInstallationEvidence {
  return { _tag: "Owned", currentUserSid, receipt, task };
}

function ownedIncomplete(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
  receipt: WindowsServiceInstallationReceipt,
): WindowsServiceInstallationEvidence {
  return { _tag: "OwnedIncomplete", currentUserSid, receipt, task };
}

function legacyCompatible(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
  artifacts: WindowsServiceInstallationArtifacts,
  runtimeIdentity?: WindowsServiceLegacyRuntimeIdentity,
): WindowsServiceInstallationEvidence {
  return { _tag: "LegacyCompatible", artifacts, currentUserSid, runtimeIdentity, task };
}

function legacyCleanupPending(
  currentUserSid: string,
  task: WindowsScheduledTaskState,
  journal: WindowsServiceLegacyCleanupJournal,
): WindowsServiceInstallationEvidence {
  return { _tag: "LegacyCleanupPending", currentUserSid, journal, task };
}

function artifactRecords(
  paths: WindowsServiceInstallationArtifactPaths,
  rendered: WindowsServiceInstallationRenderedArtifacts,
  taskDefinition: Uint8Array,
): WindowsServiceInstallationArtifacts {
  return {
    launcher: { path: paths.launcher, sha256: sha256Hex(rendered.launcher) },
    taskDefinition: {
      path: paths.taskDefinition,
      sha256: sha256Hex(taskDefinition),
    },
    wrapper: { path: paths.wrapper, sha256: sha256Hex(rendered.wrapper) },
  };
}

function placeholderArtifactRecords(
  paths: WindowsServiceInstallationArtifactPaths,
): WindowsServiceInstallationArtifacts {
  return {
    launcher: { path: paths.launcher, sha256: PLACEHOLDER_SHA256 },
    taskDefinition: { path: paths.taskDefinition, sha256: PLACEHOLDER_SHA256 },
    wrapper: { path: paths.wrapper, sha256: PLACEHOLDER_SHA256 },
  };
}

function taskExpectation(
  artifacts: WindowsServiceInstallationArtifacts,
  boot: boolean,
  userSid: string,
  wscriptPath: string,
  triggerUserAliases: ReadonlyArray<string> = [],
): WindowsServiceTaskDefinitionExpectation {
  return {
    boot,
    launcherPath: artifacts.launcher.path,
    triggerUserAliases,
    userSid,
    wscriptPath,
  };
}

function receiptIdentity(
  receipt: WindowsServiceInstallationReceipt,
  currentUserSid: string,
  locatorConfigDir: string,
) {
  return {
    argv: receipt.expectedArgv,
    configDir: locatorConfigDir,
    executablePath: receipt.executablePath,
    owner: receipt.owner,
    port: receipt.port,
    taskName: receipt.taskName,
    userSid: currentUserSid,
  };
}

function receiptWithArtifacts(
  draft: WindowsServiceInstallationReceipt,
  artifacts: WindowsServiceInstallationArtifacts,
  taskName: string,
): WindowsServiceInstallationReceipt {
  return createWindowsServiceInstallationReceipt({
    artifacts,
    boot: draft.boot,
    configDir: draft.configDir,
    executableArgsPrefix: draft.executableArgsPrefix,
    executablePath: draft.executablePath,
    expectedArgv: draft.expectedArgv,
    installId: draft.installId,
    installedAt: draft.installedAt,
    nonce: draft.nonce,
    owner: draft.owner,
    port: draft.port,
    taskName,
    userSid: draft.userSid,
  });
}

function sameSid(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function canonicalRootTaskName(taskName: string): string {
  const normalized = taskName.trim().replaceAll("/", "\\").replace(/^\\+/, "");
  return `\\${normalized}`.toLocaleLowerCase("en-US");
}

interface InstallScopedTaskCandidate {
  readonly taskName: string;
}

function installScopedTaskCandidate(
  taskName: string,
  prefix: string,
): InstallScopedTaskCandidate | null {
  const canonical = canonicalRootTaskName(taskName);
  const canonicalPrefix = canonicalRootTaskName(prefix);
  if (!canonical.startsWith(`${canonicalPrefix}-`)) return null;
  const installId = canonical.slice(canonicalPrefix.length + 1);
  return UUID_V4_PATTERN.test(installId) ? { taskName: canonical } : null;
}

function untrackedInstallScopedTaskCandidates(
  taskNames: ReadonlyArray<string>,
  prefix: string,
  trackedTaskName?: string,
): ReadonlyArray<InstallScopedTaskCandidate> {
  const tracked =
    trackedTaskName === undefined ? undefined : canonicalRootTaskName(trackedTaskName);
  return taskNames
    .flatMap((taskName) => {
      const candidate = installScopedTaskCandidate(taskName, prefix);
      return candidate === null || candidate.taskName === tracked ? [] : [candidate];
    })
    .toSorted((left, right) => left.taskName.localeCompare(right.taskName, "en-US"));
}

function untrackedTaskReason(taskNames: ReadonlyArray<string>): string {
  return taskNames.length === 1
    ? `untracked-installation-task-present:${taskNames[0]}`
    : `multiple-untracked-installation-tasks-present:${taskNames.join(",")}`;
}

function acceptedForControl(evidence: WindowsServiceInstallationEvidence): boolean {
  return acceptsWindowsInstallationControl(evidence);
}

function acceptedForInstall(evidence: WindowsServiceInstallationEvidence): boolean {
  return acceptsWindowsInstallationInstall(evidence);
}

function receiptExpectationForEvidence(
  evidence: WindowsServiceInstallationEvidence,
): WindowsServiceInstallationReceiptExpectation | null {
  switch (evidence._tag) {
    case "Owned":
    case "OwnedIncomplete":
      return expectWindowsServiceInstallationReceipt(evidence.receipt);
    case "Absent":
    case "LegacyCompatible":
      return expectAbsentWindowsServiceInstallationReceipt();
    case "LegacyCleanupPending":
    case "Refused":
      return null;
  }
}

function taskNameForEvidence(
  evidence: WindowsServiceInstallationEvidence,
  plan: WindowsServiceInstallationPlan,
): string | null {
  switch (evidence._tag) {
    case "Owned":
    case "OwnedIncomplete":
      return evidence.receipt.taskName;
    case "LegacyCompatible":
      return plan.legacy?.taskName ?? null;
    case "LegacyCleanupPending":
    case "Absent":
    case "Refused":
      return null;
  }
}

function predecessorArtifactRemoval(
  evidence: WindowsServiceInstallationEvidence,
): { readonly artifacts: WindowsServiceInstallationArtifacts; readonly generation: string } | null {
  switch (evidence._tag) {
    case "Owned":
    case "OwnedIncomplete":
      return { artifacts: evidence.receipt.artifacts, generation: evidence.receipt.installId };
    case "LegacyCompatible":
    case "LegacyCleanupPending":
    case "Absent":
      return null;
    case "Refused":
      return null;
  }
}

function refuseMutation(
  operation: string,
  evidence: WindowsServiceInstallationEvidence,
): Effect.Effect<never, WindowsServiceInstallationControllerError> {
  const reason = evidence._tag === "Refused" ? evidence.reason : evidence._tag;
  return Effect.fail(
    controllerFailure(operation, `Windows service installation ownership refused: ${reason}.`),
  );
}

export function makeWindowsServiceInstallationController(
  dependencies: WindowsServiceInstallationControllerDependencies,
): WindowsServiceInstallationController {
  const readArtifact = (path: string) =>
    mapFailure("read-installation-artifact", dependencies.artifacts.read(path));

  const artifactsMatch = Effect.fn("SelfTuneService.windowsInstallation.artifactsMatch")(function* (
    artifacts: WindowsServiceInstallationArtifacts,
  ) {
    return (yield* artifactSetState(artifacts)) === "matching";
  });

  const matchingLegacyArtifacts = Effect.fn(
    "SelfTuneService.windowsInstallation.matchingLegacyArtifacts",
  )(function* (legacy: WindowsServiceLegacyInstallation) {
    if (legacy.matchArtifacts === undefined) {
      return (yield* artifactsMatch(legacy.artifacts)) ? legacy.artifacts : null;
    }
    const wrapper = yield* readArtifact(legacy.artifacts.wrapper.path);
    const launcher = yield* readArtifact(legacy.artifacts.launcher.path);
    const taskDefinition = yield* readArtifact(legacy.artifacts.taskDefinition.path);
    if (wrapper === null || launcher === null || taskDefinition === null) return null;
    const matches = yield* Effect.try({
      try: () => legacy.matchArtifacts?.({ launcher, taskDefinition, wrapper }) === true,
      catch: (cause) => controllerFailure("match-legacy-artifacts", cause),
    });
    if (!matches) return null;
    return {
      launcher: { path: legacy.artifacts.launcher.path, sha256: sha256Hex(launcher) },
      taskDefinition: {
        path: legacy.artifacts.taskDefinition.path,
        sha256: sha256Hex(taskDefinition),
      },
      wrapper: { path: legacy.artifacts.wrapper.path, sha256: sha256Hex(wrapper) },
    };
  });

  const artifactSetState = Effect.fn("SelfTuneService.windowsInstallation.artifactSetState")(
    function* (artifacts: WindowsServiceInstallationArtifacts) {
      return yield* inspectDurableArtifactSet(readArtifact, [
        artifacts.wrapper,
        artifacts.launcher,
        artifacts.taskDefinition,
      ]);
    },
  );

  const registeredDefinitionMatches = Effect.fn(
    "SelfTuneService.windowsInstallation.taskDefinitionMatches",
  )(function* (
    scheduler: WindowsTaskScheduler<unknown>,
    expectation: WindowsServiceTaskDefinitionExpectation,
    task: WindowsScheduledTaskState,
    matchDefinition: (
      xml: string,
      expectation: WindowsServiceTaskDefinitionExpectation,
    ) => {
      readonly matches: boolean;
      readonly reason?: string;
    } = matchWindowsServiceTaskDefinition,
  ) {
    if (!task.registered) return { matches: false, reason: "task-not-registered" };
    const definition = yield* mapFailure("read-task-definition", scheduler.readDefinition());
    return definition === null
      ? { matches: false as const, reason: "definition-missing" }
      : matchDefinition(definition, expectation);
  });

  const inspect = Effect.fn("SelfTuneService.windowsInstallation.inspect")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    const currentUserSid = yield* mapFailure(
      "resolve-current-user-sid",
      dependencies.store.resolveCurrentUserSid(),
    );
    const cleanupInspection = yield* legacyCleanup
      .inspect(plan.receipt.configDir, currentUserSid)
      .pipe(Effect.mapError((cause) => controllerFailure(cause.operation, cause.message)));
    if (cleanupInspection?._tag === "Refused") {
      return refused(currentUserSid, cleanupInspection.task, cleanupInspection.reason);
    }
    if (cleanupInspection?._tag === "Pending") {
      return legacyCleanupPending(
        currentUserSid,
        cleanupInspection.task,
        cleanupInspection.journal,
      );
    }
    const receipt = yield* mapFailure(
      "read-installation-receipt",
      dependencies.store.readReceipt(plan.receipt.configDir),
    );
    const taskNames = yield* mapFailure(
      "inventory-service-tasks",
      dependencies.schedulerFor(plan.taskNamePrefix).listTaskNames(),
    );
    const candidates = untrackedInstallScopedTaskCandidates(
      taskNames,
      plan.taskNamePrefix,
      receipt?.taskName,
    );
    const untrackedTasks: string[] = [];
    // Task names are machine-global, while the supervised service is one singleton per Windows user.
    for (const candidate of candidates) {
      const definition = yield* mapFailure(
        "read-untracked-task-definition",
        dependencies.schedulerFor(candidate.taskName).readDefinition(),
      );
      if (definition === null) continue;
      const scope = inspectWindowsServiceTaskPrincipalScope(definition, currentUserSid);
      if (scope._tag === "Invalid") {
        return yield* Effect.fail(
          controllerFailure(
            "inspect-untracked-task-principal",
            `Install-scoped task has invalid principal evidence: ${candidate.taskName}.`,
          ),
        );
      }
      if (scope._tag === "CurrentUser") untrackedTasks.push(candidate.taskName);
    }
    if (untrackedTasks.length > 0) {
      return refused(
        currentUserSid,
        { registered: true, running: false },
        untrackedTaskReason(untrackedTasks),
      );
    }

    if (receipt !== null) {
      const scheduler = dependencies.schedulerFor(receipt.taskName);
      const task = yield* mapFailure("query-task", scheduler.query());
      const identity = matchWindowsServiceInstallation(
        receipt,
        receiptIdentity(receipt, currentUserSid, plan.receipt.configDir),
      );
      if (!identity.matches) {
        return refused(currentUserSid, task, `receipt-${identity.reason}`);
      }
      const receiptArtifactState = yield* artifactSetState(receipt.artifacts);
      if (receiptArtifactState === "mismatch") {
        return refused(currentUserSid, task, "receipt-artifact-digest-mismatch");
      }
      if (!task.registered) {
        return ownedIncomplete(currentUserSid, task, receipt);
      }
      if (receiptArtifactState !== "matching") {
        return refused(currentUserSid, task, "registered-task-artifact-missing");
      }
      const definitionMatch = yield* registeredDefinitionMatches(
        scheduler,
        taskExpectation(
          receipt.artifacts,
          receipt.boot,
          currentUserSid,
          plan.wscriptPath,
          plan.triggerUserAliases,
        ),
        task,
      );
      return definitionMatch.matches
        ? owned(currentUserSid, task, receipt)
        : refused(
            currentUserSid,
            task,
            `registered-task-definition-mismatch:${definitionMatch.reason ?? "unknown"}`,
          );
    }

    const legacyTaskName = plan.legacy?.taskName ?? plan.legacyTaskName;
    if (legacyTaskName === undefined) {
      return absent(currentUserSid, { registered: false, running: false });
    }
    const scheduler = dependencies.schedulerFor(legacyTaskName);
    const task = yield* mapFailure("query-legacy-task", scheduler.query());
    if (!task.registered) {
      return absent(currentUserSid, task);
    }
    if (plan.legacy === undefined) {
      return refused(currentUserSid, task, "unrecognized-legacy-task-present");
    }
    const matchingArtifacts = yield* matchingLegacyArtifacts(plan.legacy);
    if (matchingArtifacts === null) {
      return refused(currentUserSid, task, "legacy-artifact-digest-mismatch");
    }
    const definitionMatch = yield* registeredDefinitionMatches(
      scheduler,
      taskExpectation(
        plan.legacy.artifacts,
        plan.legacy.boot,
        currentUserSid,
        plan.legacy.wscriptPath,
        plan.triggerUserAliases,
      ),
      task,
      matchLegacyWindowsServiceTaskDefinition,
    );
    return definitionMatch.matches
      ? legacyCompatible(currentUserSid, task, matchingArtifacts, plan.legacy.runtimeIdentity)
      : refused(currentUserSid, task, "legacy-task-definition-mismatch");
  });

  const writeArtifact = (path: string, contents: Uint8Array) =>
    mapFailure("write-installation-artifact", dependencies.artifacts.write(path, contents));

  const removeMatchingArtifacts = Effect.fn(
    "SelfTuneService.windowsInstallation.removeMatchingArtifacts",
  )(function* (artifacts: WindowsServiceInstallationArtifacts, generation: string) {
    const removeIfMatching = (artifact: WindowsServiceInstallationArtifacts["wrapper"]) =>
      mapFailure(
        "remove-installation-artifact",
        dependencies.artifacts.removeMatching({ artifact, generation }),
      );
    yield* removeIfMatching(artifacts.taskDefinition);
    yield* removeIfMatching(artifacts.launcher);
    yield* removeIfMatching(artifacts.wrapper);
  });

  const legacyCleanup = makeWindowsServiceLegacyCleanupController(dependencies);

  const beginLegacyCleanup = Effect.fn("SelfTuneService.windowsInstallation.beginLegacyCleanup")(
    function* (
      evidence: Extract<WindowsServiceInstallationEvidence, { readonly _tag: "LegacyCompatible" }>,
      plan: WindowsServiceInstallationPlan,
      initiatedBy: "install" | "uninstall",
    ) {
      const legacy = plan.legacy;
      if (
        legacy === undefined ||
        legacy.runtimeIdentity === undefined ||
        legacy.taskName !== "SelfTuneDaemon" ||
        legacy.wscriptPath !== "wscript.exe"
      ) {
        return yield* Effect.fail(
          controllerFailure(
            "create-legacy-cleanup-journal",
            "Exact legacy cleanup evidence is unavailable.",
          ),
        );
      }
      yield* legacyCleanup
        .begin({
          artifacts: evidence.artifacts,
          boot: legacy.boot,
          configDir: plan.receipt.configDir,
          initiatedBy,
          runtimeIdentity: legacy.runtimeIdentity,
          taskName: legacy.taskName,
          userSid: evidence.currentUserSid,
          wscriptPath: legacy.wscriptPath,
        })
        .pipe(Effect.mapError((cause) => controllerFailure(cause.operation, cause.message)));
    },
  );

  const reprove = Effect.fn("SelfTuneService.windowsInstallation.reprove")(function* (
    operation: string,
    expected: WindowsServiceInstallationEvidence,
    plan: WindowsServiceInstallationPlan,
  ) {
    return yield* reproveAuthority(
      inspect(plan),
      expected,
      { acceptsControl: acceptedForControl, sameAuthority: sameWindowsInstallationAuthority },
      () => controllerFailure(operation, "Installation ownership changed before task mutation."),
    );
  });

  const install = Effect.fn("SelfTuneService.windowsInstallation.install")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    yield* legacyCleanup
      .resume(plan.receipt.configDir)
      .pipe(Effect.mapError((cause) => controllerFailure(cause.operation, cause.message)));
    const evidence = yield* inspect(plan);
    if (!acceptedForInstall(evidence)) return yield* refuseMutation("install", evidence);
    const expectedPriorReceipt = receiptExpectationForEvidence(evidence);
    if (expectedPriorReceipt === null) return yield* refuseMutation("install", evidence);

    const draft = yield* mapFailure(
      "create-installation-receipt",
      dependencies.store.createReceipt({
        ...plan.receipt,
        artifacts: placeholderArtifactRecords(
          yield* Effect.try({
            try: () => plan.artifactPaths("00000000-0000-4000-8000-000000000000"),
            catch: (cause) => controllerFailure("resolve-draft-artifact-paths", cause),
          }),
        ),
        taskName: `${plan.taskNamePrefix}-draft`,
      }),
    );
    if (!sameSid(draft.userSid, evidence.currentUserSid)) {
      return yield* Effect.fail(
        controllerFailure("install", "Current Windows user SID changed during installation."),
      );
    }
    const paths = yield* Effect.try({
      try: () => plan.artifactPaths(draft.installId),
      catch: (cause) => controllerFailure("resolve-installation-artifact-paths", cause),
    });
    const taskName = `${plan.taskNamePrefix}-${draft.installId}`;
    const renderReceipt = yield* Effect.try({
      try: () => receiptWithArtifacts(draft, placeholderArtifactRecords(paths), taskName),
      catch: (cause) => controllerFailure("prepare-installation-artifacts", cause),
    });
    const rendered = yield* Effect.try({
      try: () => plan.renderArtifacts(renderReceipt),
      catch: (cause) => controllerFailure("render-installation-artifacts", cause),
    });
    const taskDefinition = yield* Effect.try({
      try: () => plan.encodeTaskDefinition(rendered.taskDefinitionXml),
      catch: (cause) => controllerFailure("encode-task-definition", cause),
    });
    const receipt = yield* Effect.try({
      try: () =>
        receiptWithArtifacts(draft, artifactRecords(paths, rendered, taskDefinition), taskName),
      catch: (cause) => controllerFailure("finalize-installation-receipt", cause),
    });
    const generatedDefinition = matchWindowsServiceTaskDefinition(
      rendered.taskDefinitionXml,
      taskExpectation(
        receipt.artifacts,
        receipt.boot,
        receipt.userSid,
        plan.wscriptPath,
        plan.triggerUserAliases,
      ),
    );
    if (!generatedDefinition.matches) {
      return yield* Effect.fail(
        controllerFailure(
          "validate-generated-task-definition",
          `Generated task definition is invalid: ${generatedDefinition.reason}.`,
        ),
      );
    }

    yield* mapFailure(
      "prepare-server-control",
      dependencies.store.prepareServerControl(plan.receipt.configDir),
    );

    if (evidence._tag === "LegacyCompatible") {
      yield* beginLegacyCleanup(evidence, plan, "install");
    } else if (evidence.task.registered) {
      const beforeEnd = yield* reprove("reprove-predecessor-before-end", evidence, plan);
      const predecessorName = taskNameForEvidence(beforeEnd, plan);
      if (predecessorName === null) {
        return yield* Effect.fail(
          controllerFailure("install", "Proven predecessor has no scheduler identity."),
        );
      }
      const predecessor = dependencies.schedulerFor(predecessorName);
      yield* mapFailure("end-owned-task-for-install", predecessor.end());
      yield* reprove("reprove-predecessor-before-delete", evidence, plan);
      yield* mapFailure("delete-owned-task-for-install", predecessor.delete());
      const afterDelete = yield* mapFailure(
        "confirm-predecessor-task-absence",
        predecessor.query(),
      );
      if (afterDelete.registered) {
        return yield* Effect.fail(
          controllerFailure(
            "confirm-predecessor-task-absence",
            "Proven predecessor task remained registered.",
          ),
        );
      }
    }
    if (evidence._tag !== "LegacyCompatible") {
      const removal = predecessorArtifactRemoval(evidence);
      if (removal !== null) {
        yield* removeMatchingArtifacts(removal.artifacts, removal.generation);
      }
    }
    yield* mapFailure(
      "persist-installation-receipt",
      dependencies.store.writeReceipt(receipt, expectedPriorReceipt),
    );
    yield* writeArtifact(receipt.artifacts.wrapper.path, rendered.wrapper);
    yield* writeArtifact(receipt.artifacts.launcher.path, rendered.launcher);
    yield* writeArtifact(receipt.artifacts.taskDefinition.path, taskDefinition);
    const installedScheduler = dependencies.schedulerFor(receipt.taskName);
    yield* mapFailure(
      "create-owned-task",
      installedScheduler.createExclusive(receipt.artifacts.taskDefinition.path),
    );
    const installed = yield* inspect(plan);
    if (
      installed._tag !== "Owned" ||
      !sameWindowsServiceInstallationReceipt(installed.receipt, receipt)
    ) {
      const detail =
        installed._tag === "Refused" ? ` (${installed.reason})` : ` (${installed._tag})`;
      return yield* Effect.fail(
        controllerFailure(
          "verify-created-task",
          `Created task failed installation ownership proof${detail}.`,
        ),
      );
    }
    yield* mapFailure("start-owned-task", installedScheduler.start());
    return receipt;
  });

  const start = Effect.fn("SelfTuneService.windowsInstallation.start")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    const evidence = yield* inspect(plan);
    if (!acceptedForControl(evidence)) return yield* refuseMutation("start", evidence);
    const taskName = taskNameForEvidence(evidence, plan);
    if (taskName === null) return yield* refuseMutation("start", evidence);
    yield* mapFailure("start-owned-task", dependencies.schedulerFor(taskName).start());
  });

  const stop = Effect.fn("SelfTuneService.windowsInstallation.stop")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    const evidence = yield* inspect(plan);
    if (evidence._tag === "LegacyCleanupPending") {
      if (evidence.task.registered) {
        yield* mapFailure(
          "end-legacy-cleanup-task",
          dependencies.schedulerFor(evidence.journal.taskName).end(),
        );
      }
      return;
    }
    if (!acceptedForControl(evidence)) return yield* refuseMutation("stop", evidence);
    const taskName = taskNameForEvidence(evidence, plan);
    if (taskName === null) return yield* refuseMutation("stop", evidence);
    yield* mapFailure("end-owned-task", dependencies.schedulerFor(taskName).end());
  });

  const restart = Effect.fn("SelfTuneService.windowsInstallation.restart")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    const before = yield* inspect(plan);
    if (!acceptedForControl(before)) return yield* refuseMutation("restart", before);
    const taskName = taskNameForEvidence(before, plan);
    if (taskName === null) return yield* refuseMutation("restart", before);
    const scheduler = dependencies.schedulerFor(taskName);
    yield* mapFailure("end-owned-task", scheduler.end());
    yield* reprove("reprove-before-restart", before, plan);
    yield* mapFailure("start-owned-task", scheduler.start());
  });

  const uninstall = Effect.fn("SelfTuneService.windowsInstallation.uninstall")(function* (
    plan: WindowsServiceInstallationPlan,
  ) {
    yield* legacyCleanup
      .resume(plan.receipt.configDir)
      .pipe(Effect.mapError((cause) => controllerFailure(cause.operation, cause.message)));
    const evidence = yield* inspect(plan);
    if (evidence._tag === "Refused") return yield* refuseMutation("uninstall", evidence);
    if (evidence._tag === "Absent") return;
    if (evidence._tag === "LegacyCleanupPending") {
      return yield* refuseMutation("uninstall", evidence);
    }

    const taskName = taskNameForEvidence(evidence, plan);
    if (taskName === null) return yield* refuseMutation("uninstall", evidence);
    if (evidence._tag === "LegacyCompatible") {
      yield* beginLegacyCleanup(evidence, plan, "uninstall");
      return;
    }
    const scheduler = dependencies.schedulerFor(taskName);
    if (evidence.task.registered) {
      yield* mapFailure("end-owned-task", scheduler.end());
      yield* reprove("reprove-before-delete", evidence, plan);
      yield* mapFailure("delete-owned-task", scheduler.delete());
    }
    const afterDelete = yield* mapFailure("confirm-task-absence", scheduler.query());
    if (afterDelete.registered) {
      return yield* Effect.fail(
        controllerFailure("confirm-task-absence", "Scheduled task remained registered."),
      );
    }

    const expectedReceipt = expectWindowsServiceInstallationReceipt(evidence.receipt);
    yield* mapFailure(
      "remove-receipt-after-cleanup",
      dependencies.store.removeReceiptAfterCleanup(
        plan.receipt.configDir,
        expectedReceipt,
        removeMatchingArtifacts(evidence.receipt.artifacts, evidence.receipt.installId),
      ),
    );
  });

  return { install, inspect, restart, start, status: inspect, stop, uninstall };
}
