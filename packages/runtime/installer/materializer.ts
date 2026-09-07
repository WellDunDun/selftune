import {
  InstallableSkill,
  PlannedFileOperation,
  ReceiptIntent,
  StoredInstallReceipt,
} from "./types.js";
/* oxlint-disable max-lines */
import { createHash, randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { confirmAndCommitLocalInstall } from "./plan.js";
import type {
  InstallerCommitFence,
  InstallerPlanningError,
  InstallerPlanningAuthorities,
  LocalInstallPlan,
  LocalInstallRequest,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;

export class InstallerMaterializationError extends Schema.TaggedErrorClass<InstallerMaterializationError>()(
  "InstallerMaterializationError",
  {
    code: Schema.String,
    message: Schema.String,
    path: Schema.NullOr(Schema.String),
  },
) {}

function materializationError(
  code: string,
  message: string,
  path: string | null = null,
): InstallerMaterializationError {
  return InstallerMaterializationError.make({ code, message, path });
}

function fenceCheckpoint(fence: InstallerCommitFence) {
  return fence.checkpoint ?? fence.assertValid;
}

export interface LoadedInstallerPackage {
  readonly sealedBytes: Uint8Array;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
  }>;
}

export interface VerifiedInstallerFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface InstallerPackageSource {
  readonly load: (
    skill: InstallableSkill,
  ) => Effect.Effect<LoadedInstallerPackage, InstallerMaterializationError>;
}

export const DurableInstallReceipt = Schema.Struct({
  ...StoredInstallReceipt.fields,
  subjectKind: ReceiptIntent.fields.subjectKind,
  skillSet: ReceiptIntent.fields.skillSet,
  logicalVersion: Schema.String,
  distributionId: Schema.String,
  shareId: Schema.String,
  handoffId: Schema.String,
  sealedObjectId: Schema.Union([Schema.String, Schema.Null]),
  signature: InstallableSkill.fields.signature,
  license: InstallableSkill.fields.license,
  platform: ReceiptIntent.fields.platform,
  strategy: ReceiptIntent.fields.strategy,
  conflictDecision: ReceiptIntent.fields.unmanagedPolicy,
  backupPath: Schema.Union([Schema.String, Schema.Null]),
  consent: InstallableSkill.fields.consent,
  source: InstallableSkill.fields.source,
  previewFingerprint: Schema.String,
  operationId: Schema.String,
  previousReceiptId: Schema.Union([Schema.String, Schema.Null]),
  supersededByReceiptId: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  removedAt: Schema.Union([Schema.String, Schema.Null]),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      byteLength: Schema.Number,
      durableSnapshotRef: Schema.String,
    }),
  ),
});
export type DurableInstallReceipt = typeof DurableInstallReceipt.Type;

export const DurableInstallStep = Schema.Struct({
  sequence: Schema.Number,
  receiptId: Schema.String,
  mutation: Schema.Union([
    Schema.Literal("install"),
    Schema.Literal("remove"),
    Schema.Literal("restore"),
  ]),
  state: Schema.Union([
    Schema.Literal("planned"),
    Schema.Literal("started"),
    Schema.Literal("completed"),
    Schema.Literal("rolled_back"),
  ]),
  targetPath: Schema.String,
  stagingPath: Schema.String,
  rollbackPath: Schema.String,
  retainRollbackAfterCommit: Schema.Boolean,
  restoreBackupPath: Schema.Union([Schema.String, Schema.Null]),
  snapshotPath: Schema.String,
  strategy: ReceiptIntent.fields.strategy,
  sourcePath: Schema.Union([Schema.String, Schema.Null]),
  expectedSealedPackageSha256: Schema.String,
  expectedBefore: ReceiptIntent.fields.expectedBefore,
  operations: Schema.Array(PlannedFileOperation),
});
export type DurableInstallStep = typeof DurableInstallStep.Type;

export const DurableInstallOperation = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Union([
    Schema.Literal("install"),
    Schema.Literal("remove"),
    Schema.Literal("rollback"),
  ]),
  state: Schema.Union([
    Schema.Literal("planned"),
    Schema.Literal("applying"),
    Schema.Literal("cleanup_pending"),
    Schema.Literal("committed"),
    Schema.Literal("rolling_back"),
    Schema.Literal("rolled_back"),
    Schema.Literal("failed"),
  ]),
  previewFingerprint: Schema.String,
  fenceId: Schema.String,
  fenceGeneration: Schema.Number,
  recoveryToken: Schema.Union([Schema.String, Schema.Null]),
  recoveryGeneration: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  receiptIntents: Schema.Array(ReceiptIntent),
  steps: Schema.Array(DurableInstallStep),
});
export type DurableInstallOperation = typeof DurableInstallOperation.Type;

export interface InstallerMaterializationResult {
  readonly files: DurableInstallReceipt["files"];
}

export interface OwnedInstallInspection {
  readonly matches: boolean;
  readonly driftedPaths: ReadonlyArray<string>;
}

export type InstallerMutationFence = Effect.Effect<
  void,
  InstallerPlanningError | InstallerMaterializationError
>;

/**
 * Deep filesystem seam. Implementations own safe path revalidation,
 * same-filesystem staging, atomic rename, snapshots, and recovery semantics.
 */
export interface InstallerMaterializationFileSystem {
  readonly materialize: (input: {
    readonly operationId: string;
    readonly receiptId: string;
    readonly targetPath: string;
    readonly stagingPath: string;
    readonly rollbackPath: string;
    readonly snapshotPath: string;
    readonly backupPath: string | null;
    readonly strategy: ReceiptIntent["strategy"];
    readonly sourcePath: string | null;
    readonly files: ReadonlyArray<VerifiedInstallerFile>;
    readonly operations: ReadonlyArray<PlannedFileOperation>;
    readonly expectedBefore: ReceiptIntent["expectedBefore"];
    readonly assertFence: InstallerMutationFence;
  }) => Effect.Effect<InstallerMaterializationResult, InstallerMaterializationError>;
  readonly rollback: (
    step: DurableInstallStep,
    assertFence?: InstallerMutationFence,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly cleanupAfterCommit: (
    step: DurableInstallStep,
    assertFence?: InstallerMutationFence,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly inspectOwned: (
    receipt: DurableInstallReceipt,
  ) => Effect.Effect<OwnedInstallInspection, InstallerMaterializationError>;
  readonly removeOwned: (input: {
    readonly receipt: DurableInstallReceipt;
    readonly step: DurableInstallStep;
    readonly assertFence: InstallerMutationFence;
  }) => Effect.Effect<void, InstallerMaterializationError>;
  readonly restoreOwned: (input: {
    readonly receipt: DurableInstallReceipt;
    readonly previous: DurableInstallReceipt | null;
    readonly step: DurableInstallStep;
    readonly assertFence: InstallerMutationFence;
  }) => Effect.Effect<void, InstallerMaterializationError>;
}

/** SQLite is the only authority behind this interface; JSON receipt adapters are forbidden. */
export interface DurableInstallReceiptAuthority {
  readonly beginInstall: (input: {
    readonly operation: DurableInstallOperation;
    readonly fenceId: string;
  }) => Effect.Effect<DurableInstallOperation, InstallerMaterializationError>;
  readonly markStepStarted: (
    operationId: string,
    sequence: number,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly markStepCompleted: (
    operationId: string,
    sequence: number,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly commitInstall: (input: {
    readonly operationId: string;
    readonly receipts: ReadonlyArray<DurableInstallReceipt>;
    readonly at: string;
  }) => Effect.Effect<ReadonlyArray<DurableInstallReceipt>, InstallerMaterializationError>;
  readonly failOperation: (
    operationId: string,
    code: string,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly listRecoverableOperations: () => Effect.Effect<
    ReadonlyArray<DurableInstallOperation>,
    InstallerMaterializationError
  >;
  readonly listCleanupOperations: () => Effect.Effect<
    ReadonlyArray<DurableInstallOperation>,
    InstallerMaterializationError
  >;
  readonly markCleanupCompleted: (
    operationId: string,
    recoveryToken: string | null,
    recoveryGeneration: number | null,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly renewRecoveryClaim: (
    operationId: string,
    recoveryToken: string,
    recoveryGeneration: number,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly withRecoveryClaim: <A, E, R>(
    operationId: string,
    recoveryToken: string,
    recoveryGeneration: number,
    use: (checkpoint: Effect.Effect<void, InstallerMaterializationError>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InstallerMaterializationError, R>;
  readonly markRolledBack: (
    operationId: string,
    recoveryToken: string | null,
    recoveryGeneration: number | null,
    at: string,
  ) => Effect.Effect<void, InstallerMaterializationError>;
  readonly readReceipt: (
    receiptId: string,
  ) => Effect.Effect<DurableInstallReceipt | null, InstallerMaterializationError>;
  readonly commitRemoval: (input: {
    readonly operationId: string;
    readonly receiptId: string;
    readonly at: string;
  }) => Effect.Effect<void, InstallerMaterializationError>;
  readonly commitRollback: (input: {
    readonly operationId: string;
    readonly receiptId: string;
    readonly at: string;
  }) => Effect.Effect<void, InstallerMaterializationError>;
  readonly commitRollbackBatch?: (input: {
    readonly changes: ReadonlyArray<{
      readonly operationId: string;
      readonly receiptId: string;
    }>;
    readonly at: string;
  }) => Effect.Effect<void, InstallerMaterializationError>;
}

export interface InstallerMaterializationAuthorities {
  readonly packages: InstallerPackageSource;
  readonly filesystem: InstallerMaterializationFileSystem;
  readonly receipts: DurableInstallReceiptAuthority;
  readonly now: () => string;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyLoadedPackage(
  skill: InstallableSkill,
  loaded: LoadedInstallerPackage,
): Effect.Effect<ReadonlyArray<VerifiedInstallerFile>, InstallerMaterializationError> {
  if (hash(loaded.sealedBytes) !== skill.sealedPackageSha256) {
    return Effect.fail(
      materializationError(
        "SEALED_IDENTITY_MISMATCH",
        "The loaded sealed package does not match its authorized SHA-256 identity.",
      ),
    );
  }
  if (loaded.files.length !== skill.files.length) {
    return Effect.fail(
      materializationError(
        "PACKAGE_FILE_SET_MISMATCH",
        "The loaded package file set differs from the authorized manifest.",
      ),
    );
  }
  const loadedByPath = new Map<string, Uint8Array>();
  for (const file of loaded.files) {
    if (loadedByPath.has(file.path)) {
      return Effect.fail(
        materializationError(
          "PACKAGE_FILE_SET_MISMATCH",
          "The loaded package contains duplicate paths.",
          file.path,
        ),
      );
    }
    loadedByPath.set(file.path, file.bytes);
  }
  const verified: VerifiedInstallerFile[] = [];
  for (const expected of skill.files) {
    const bytes = loadedByPath.get(expected.path);
    if (
      !bytes ||
      bytes.byteLength !== expected.byteLength ||
      hash(bytes) !== expected.sha256 ||
      !SHA256.test(expected.sha256)
    ) {
      return Effect.fail(
        materializationError(
          "PACKAGE_FILE_HASH_MISMATCH",
          "A package file does not match its authorized length and SHA-256 digest.",
          expected.path,
        ),
      );
    }
    verified.push({
      path: expected.path,
      bytes,
      sha256: expected.sha256,
      byteLength: expected.byteLength,
    });
  }
  return Effect.succeed(verified);
}

function operationsForTarget(
  plan: LocalInstallPlan,
  targetPath: string,
): ReadonlyArray<PlannedFileOperation> {
  return plan.operations.filter((operation) => operation.targetPath === targetPath);
}

function makeOperation(
  plan: LocalInstallPlan,
  fence: InstallerCommitFence,
  now: string,
): DurableInstallOperation {
  if (!plan.journal) {
    throw materializationError(
      "INSTALL_JOURNAL_MISSING",
      "A ready install plan must carry a durable journal intent.",
    );
  }
  const mutatingReceipts = plan.receipts.filter((receipt) => !receipt.noOp);
  const fenceGeneration = fence.generation ?? 0;
  const steps = mutatingReceipts.map(
    (receipt, sequence): DurableInstallStep => ({
      sequence,
      receiptId: receipt.receiptId,
      mutation: "install",
      state: "planned",
      targetPath: receipt.targetPath,
      stagingPath: `${receipt.targetPath}.selftune-stage-${plan.journal!.journalId}-g${fenceGeneration}-${sequence}`,
      rollbackPath:
        receipt.backupPath ??
        `${receipt.targetPath}.selftune-rollback-${plan.journal!.journalId}-g${fenceGeneration}-${sequence}`,
      retainRollbackAfterCommit: receipt.backupPath !== null,
      restoreBackupPath: null,
      snapshotPath: `${receipt.targetPath}.selftune-owned-${receipt.receiptId}-g${fenceGeneration}`,
      strategy: receipt.strategy,
      sourcePath:
        receipt.skill.source.kind === "local_authoring_immutable"
          ? receipt.skill.source.absolutePath
          : null,
      expectedSealedPackageSha256: receipt.skill.sealedPackageSha256,
      expectedBefore: receipt.expectedBefore,
      operations: operationsForTarget(plan, receipt.targetPath),
    }),
  );
  return {
    operationId: plan.journal.journalId,
    kind: "install",
    state: "planned",
    previewFingerprint: plan.previewFingerprint,
    fenceId: fence.fenceId,
    fenceGeneration,
    recoveryToken: null,
    recoveryGeneration: 0,
    createdAt: now,
    updatedAt: now,
    receiptIntents: mutatingReceipts,
    steps,
  };
}

function makeReceipt(
  intent: ReceiptIntent,
  operationId: string,
  files: DurableInstallReceipt["files"],
  now: string,
): DurableInstallReceipt {
  return {
    receiptId: intent.receiptId,
    state: "active",
    subjectKind: intent.subjectKind,
    skillSet: intent.skillSet,
    agent: intent.agent,
    platform: intent.platform,
    scope: intent.scope,
    projectRoot: intent.projectRoot,
    registryRoot: intent.registryRoot,
    targetPath: intent.targetPath,
    skillName: intent.skill.name,
    logicalSkillId: intent.skill.logicalSkillId,
    logicalVersion: intent.skill.logicalVersion,
    distributionId: intent.skill.distributionId,
    shareId: intent.skill.shareId,
    handoffId: intent.skill.handoffId,
    sealedPackageSha256: intent.skill.sealedPackageSha256,
    sealedObjectId:
      intent.skill.source.kind === "remote_sealed" ? intent.skill.source.objectId : null,
    signature: intent.skill.signature,
    license: intent.skill.license,
    strategy: intent.strategy,
    conflictDecision: intent.unmanagedPolicy,
    backupPath: intent.backupPath,
    consent: intent.skill.consent,
    source: intent.skill.source,
    previewFingerprint: intent.previewFingerprint,
    operationId,
    previousReceiptId: null,
    supersededByReceiptId: null,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
    files,
  };
}

const rollbackOperation = Effect.fn("selftune.runtime.installer.rollbackOperation")(function* (
  operation: DurableInstallOperation,
  authorities: Omit<InstallerMaterializationAuthorities, "packages">,
  fence?: InstallerCommitFence,
  recoveryCheckpoint?: Effect.Effect<void, InstallerMaterializationError>,
) {
  const assertMutationAllowed = fence
    ? recoveryCheckpoint
      ? fenceCheckpoint(fence).pipe(Effect.andThen(recoveryCheckpoint))
      : fenceCheckpoint(fence)
    : recoveryCheckpoint;
  for (const step of [...operation.steps].toReversed()) {
    if (step.state === "planned" || step.state === "rolled_back") continue;
    if (assertMutationAllowed) yield* assertMutationAllowed;
    if (operation.recoveryToken) {
      yield* authorities.receipts.renewRecoveryClaim(
        operation.operationId,
        operation.recoveryToken,
        operation.recoveryGeneration,
        authorities.now(),
      );
    }
    yield* authorities.filesystem.rollback(step, assertMutationAllowed);
  }
  if (assertMutationAllowed) yield* assertMutationAllowed;
  if (operation.recoveryToken) {
    yield* authorities.receipts.renewRecoveryClaim(
      operation.operationId,
      operation.recoveryToken,
      operation.recoveryGeneration,
      authorities.now(),
    );
  }
  yield* authorities.receipts.markRolledBack(
    operation.operationId,
    operation.recoveryToken,
    operation.recoveryToken ? operation.recoveryGeneration : null,
    authorities.now(),
  );
});

const materializeReadyPlan = Effect.fn("selftune.runtime.installer.materializeReadyPlan")(
  function* (
    plan: LocalInstallPlan,
    fence: InstallerCommitFence,
    authorities: InstallerMaterializationAuthorities,
  ) {
    if (!plan.ready || plan.journal === null || plan.conflicts.length > 0) {
      return yield* Effect.fail(
        materializationError(
          "INSTALL_PLAN_NOT_READY",
          "Only a fresh, conflict-free ready plan can enter the materializer.",
        ),
      );
    }
    const unchanged = new Map<string, DurableInstallReceipt>();
    for (const intent of plan.receipts) {
      if (!intent.noOp || !intent.existingReceiptId) continue;
      const receipt = yield* authorities.receipts.readReceipt(intent.existingReceiptId);
      if (
        !receipt ||
        receipt.state !== "active" ||
        receipt.targetPath !== intent.targetPath ||
        receipt.sealedPackageSha256 !== intent.skill.sealedPackageSha256
      ) {
        return yield* Effect.fail(
          materializationError(
            "INSTALL_NOOP_RECEIPT_CHANGED",
            "The current receipt changed before no-op confirmation.",
            intent.targetPath,
          ),
        );
      }
      const inspection = yield* authorities.filesystem.inspectOwned(receipt);
      if (!inspection.matches) {
        return yield* Effect.fail(
          materializationError(
            "INSTALL_TARGET_CHANGED",
            "The current install changed before no-op confirmation.",
            intent.targetPath,
          ),
        );
      }
      unchanged.set(intent.receiptId, receipt);
    }
    if (unchanged.size === plan.receipts.length) {
      return plan.receipts.map((intent) => unchanged.get(intent.receiptId)!);
    }
    const now = authorities.now();
    const operation = makeOperation(plan, fence, now);
    yield* fenceCheckpoint(fence);
    const persisted = yield* authorities.receipts.beginInstall({
      operation,
      fenceId: fence.fenceId,
    });
    if (
      persisted.operationId !== operation.operationId ||
      persisted.previewFingerprint !== operation.previewFingerprint ||
      persisted.fenceId !== operation.fenceId
    ) {
      return yield* Effect.fail(
        materializationError(
          "INSTALL_JOURNAL_CONFLICT",
          "SQLite returned a journal that does not match the fresh fenced plan.",
        ),
      );
    }
    if (persisted.state === "committed") {
      return yield* authorities.receipts.commitInstall({
        operationId: operation.operationId,
        receipts: [],
        at: authorities.now(),
      });
    }
    if (persisted.state !== "planned") {
      return yield* Effect.fail(
        materializationError(
          "INSTALL_RECOVERY_REQUIRED",
          "An unfinished or rolled-back operation must be recovered before it can be retried.",
        ),
      );
    }

    const touchedSteps = new Set<number>();
    const run = Effect.gen(function* () {
      const receipts: DurableInstallReceipt[] = [];
      for (const step of operation.steps) {
        const intent = operation.receiptIntents.find(
          (candidate) => candidate.receiptId === step.receiptId,
        );
        if (!intent) {
          return yield* Effect.fail(
            materializationError(
              "INSTALL_JOURNAL_CORRUPT",
              "A journal step has no matching receipt intent.",
              step.targetPath,
            ),
          );
        }
        const loaded = yield* authorities.packages.load(intent.skill);
        const files = yield* verifyLoadedPackage(intent.skill, loaded);
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.markStepStarted(
          operation.operationId,
          step.sequence,
          authorities.now(),
        );
        touchedSteps.add(step.sequence);
        yield* fenceCheckpoint(fence);
        const materialized = yield* authorities.filesystem.materialize({
          operationId: operation.operationId,
          receiptId: intent.receiptId,
          targetPath: step.targetPath,
          stagingPath: step.stagingPath,
          rollbackPath: step.rollbackPath,
          snapshotPath: step.snapshotPath,
          backupPath: intent.backupPath,
          strategy: step.strategy,
          sourcePath: step.sourcePath,
          files,
          operations: step.operations,
          expectedBefore: step.expectedBefore,
          assertFence: fenceCheckpoint(fence),
        });
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.markStepCompleted(
          operation.operationId,
          step.sequence,
          authorities.now(),
        );
        receipts.push(
          makeReceipt(intent, operation.operationId, materialized.files, authorities.now()),
        );
      }
      yield* fenceCheckpoint(fence);
      return yield* authorities.receipts.commitInstall({
        operationId: operation.operationId,
        receipts,
        at: authorities.now(),
      });
    });

    const exit = yield* Effect.exit(run);
    if (Exit.isSuccess(exit)) {
      const cleanupExit = yield* Effect.exit(
        Effect.gen(function* () {
          for (const step of operation.steps) {
            yield* fenceCheckpoint(fence);
            yield* authorities.filesystem.cleanupAfterCommit(step, fenceCheckpoint(fence));
          }
        }),
      );
      if (Exit.isSuccess(cleanupExit)) {
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.markCleanupCompleted(
          operation.operationId,
          null,
          null,
          authorities.now(),
        );
      }
      const committed = new Map(exit.value.map((receipt) => [receipt.receiptId, receipt]));
      return plan.receipts.map(
        (intent) => unchanged.get(intent.receiptId) ?? committed.get(intent.receiptId)!,
      );
    }

    const fenceExit = yield* Effect.exit(fenceCheckpoint(fence));
    if (Exit.isFailure(fenceExit)) return yield* Effect.failCause(exit.cause);
    yield* authorities.receipts.failOperation(
      operation.operationId,
      "INSTALL_FAILED",
      authorities.now(),
    );
    const recoverable: DurableInstallOperation = {
      ...operation,
      state: "rolling_back",
      steps: operation.steps.map((step) => ({
        ...step,
        state: touchedSteps.has(step.sequence) ? "started" : "planned",
      })),
    };
    const rollbackExit = yield* Effect.exit(rollbackOperation(recoverable, authorities, fence));
    const failure = exit.cause;
    if (Exit.isFailure(rollbackExit)) {
      return yield* Effect.fail(
        materializationError(
          "INSTALL_ROLLBACK_FAILED",
          `Install failed and automatic rollback also failed: ${String(rollbackExit.cause)}`,
        ),
      );
    }
    return yield* Effect.failCause(failure);
  },
);

/**
 * The only install entry point: reauthorization, observation, re-planning and
 * materialization all occur while the exclusive commit fence remains held.
 */
export function installLocalSubject(
  request: LocalInstallRequest,
  previewToken: string,
  planning: InstallerPlanningAuthorities,
  materialization: InstallerMaterializationAuthorities,
): Effect.Effect<
  ReadonlyArray<DurableInstallReceipt>,
  InstallerMaterializationError | import("./types.js").InstallerPlanningError
> {
  return confirmAndCommitLocalInstall(request, previewToken, planning, ({ plan, fence }) =>
    materializeReadyPlan(plan, fence, materialization),
  );
}

/** Any unfinished mutation is deterministically rolled back before new work starts. */
export const recoverLocalInstallOperations = Effect.fn(
  "selftune.runtime.installer.recoverLocalInstallOperations",
)(function (
  lock: InstallerPlanningAuthorities["commitLock"],
  authorities: Omit<InstallerMaterializationAuthorities, "packages">,
) {
  return lock.withExclusiveCommit((fence) =>
    Effect.gen(function* () {
      yield* fenceCheckpoint(fence);
      const cleanupOperations = yield* authorities.receipts.listCleanupOperations();
      for (const operation of cleanupOperations) {
        if (!operation.recoveryToken || operation.recoveryGeneration <= 0) {
          return yield* Effect.fail(
            materializationError(
              "INSTALL_RECOVERY_FENCE_LOST",
              "Cleanup operation has no durable recovery claim.",
            ),
          );
        }
        yield* authorities.receipts.withRecoveryClaim(
          operation.operationId,
          operation.recoveryToken,
          operation.recoveryGeneration,
          (recoveryCheckpoint) =>
            Effect.gen(function* () {
              const assertMutationAllowed = fenceCheckpoint(fence).pipe(
                Effect.andThen(recoveryCheckpoint),
              );
              for (const step of operation.steps) {
                yield* assertMutationAllowed;
                yield* authorities.filesystem.cleanupAfterCommit(step, assertMutationAllowed);
              }
              yield* assertMutationAllowed;
              yield* authorities.receipts.markCleanupCompleted(
                operation.operationId,
                operation.recoveryToken,
                operation.recoveryGeneration,
                authorities.now(),
              );
            }),
        );
      }
      yield* fenceCheckpoint(fence);
      const operations = yield* authorities.receipts.listRecoverableOperations();
      for (const operation of operations) {
        if (!operation.recoveryToken || operation.recoveryGeneration <= 0) {
          return yield* Effect.fail(
            materializationError(
              "INSTALL_RECOVERY_FENCE_LOST",
              "Rollback operation has no durable recovery claim.",
            ),
          );
        }
        yield* authorities.receipts.withRecoveryClaim(
          operation.operationId,
          operation.recoveryToken,
          operation.recoveryGeneration,
          (recoveryCheckpoint) =>
            rollbackOperation(operation, authorities, fence, recoveryCheckpoint),
        );
      }
      return [...cleanupOperations, ...operations].map((operation) => operation.operationId);
    }),
  );
});

export interface LocalInstallChangeResult {
  readonly receiptId: string;
  readonly status: "removed" | "rolled_back" | "drifted";
  readonly driftedPaths: ReadonlyArray<string>;
}

function makeChangeOperation(
  kind: "remove" | "rollback",
  receipt: DurableInstallReceipt,
  fence: InstallerCommitFence,
  now: string,
): DurableInstallOperation {
  const operationId = `${kind}_v1_${randomUUID()}`;
  const sequence = 0;
  const fenceGeneration = fence.generation ?? 0;
  return {
    operationId,
    kind,
    state: "planned",
    previewFingerprint: receipt.previewFingerprint,
    fenceId: fence.fenceId,
    fenceGeneration,
    recoveryToken: null,
    recoveryGeneration: 0,
    createdAt: now,
    updatedAt: now,
    receiptIntents: [],
    steps: [
      {
        sequence,
        receiptId: receipt.receiptId,
        mutation: kind === "remove" ? "remove" : "restore",
        state: "planned",
        targetPath: receipt.targetPath,
        stagingPath: `${receipt.targetPath}.selftune-${kind}-stage-${operationId}-g${fenceGeneration}`,
        rollbackPath: `${receipt.targetPath}.selftune-${kind}-rollback-${operationId}-g${fenceGeneration}`,
        snapshotPath: `${receipt.targetPath}.selftune-${kind}-snapshot-${operationId}-g${fenceGeneration}`,
        retainRollbackAfterCommit: false,
        restoreBackupPath: kind === "rollback" ? receipt.backupPath : null,
        strategy: receipt.strategy,
        sourcePath:
          receipt.source.kind === "local_authoring_immutable" ? receipt.source.absolutePath : null,
        expectedSealedPackageSha256: receipt.sealedPackageSha256,
        expectedBefore: {
          kind: "directory",
          files: receipt.files.map((file) => ({ ...file, kind: "file" as const })),
        },
        operations: [],
      },
    ],
  };
}

const failAndRecoverChange = Effect.fn("selftune.runtime.installer.failAndRecoverChange")(
  function* (
    operation: DurableInstallOperation,
    authorities: InstallerMaterializationAuthorities,
    fence: InstallerCommitFence,
  ) {
    yield* fenceCheckpoint(fence);
    yield* authorities.receipts.failOperation(
      operation.operationId,
      "INSTALL_CHANGE_FAILED",
      authorities.now(),
    );
    yield* rollbackOperation(operation, authorities, fence);
  },
);

export function removeLocalInstall(
  receiptId: string,
  lock: InstallerPlanningAuthorities["commitLock"],
  authorities: InstallerMaterializationAuthorities,
): Effect.Effect<
  LocalInstallChangeResult,
  InstallerMaterializationError | import("./types.js").InstallerPlanningError
> {
  return lock.withExclusiveCommit((fence) =>
    Effect.gen(function* () {
      const receipt = yield* authorities.receipts.readReceipt(receiptId);
      if (!receipt || receipt.state !== "active") {
        return yield* Effect.fail(
          materializationError("INSTALL_RECEIPT_NOT_ACTIVE", "The install receipt is not active."),
        );
      }
      const inspection = yield* authorities.filesystem.inspectOwned(receipt);
      if (!inspection.matches) {
        return {
          receiptId,
          status: "drifted" as const,
          driftedPaths: inspection.driftedPaths,
        };
      }
      const operation = makeChangeOperation("remove", receipt, fence, authorities.now());
      yield* fenceCheckpoint(fence);
      yield* authorities.receipts.beginInstall({ operation, fenceId: fence.fenceId });
      const step = operation.steps[0]!;
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.markStepStarted(
            operation.operationId,
            step.sequence,
            authorities.now(),
          );
          yield* fenceCheckpoint(fence);
          yield* authorities.filesystem.removeOwned({
            receipt,
            step,
            assertFence: fenceCheckpoint(fence),
          });
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.markStepCompleted(
            operation.operationId,
            step.sequence,
            authorities.now(),
          );
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.commitRemoval({
            operationId: operation.operationId,
            receiptId,
            at: authorities.now(),
          });
        }),
      );
      if (Exit.isFailure(exit)) {
        yield* failAndRecoverChange(
          { ...operation, steps: [{ ...step, state: "started" }] },
          authorities,
          fence,
        );
        return yield* Effect.failCause(exit.cause);
      }
      const cleanupExit = yield* Effect.exit(
        authorities.filesystem.cleanupAfterCommit(step, fenceCheckpoint(fence)),
      );
      if (Exit.isSuccess(cleanupExit)) {
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.markCleanupCompleted(
          operation.operationId,
          null,
          null,
          authorities.now(),
        );
      }
      return { receiptId, status: "removed" as const, driftedPaths: [] };
    }),
  );
}

export function rollbackLocalInstall(
  receiptId: string,
  lock: InstallerPlanningAuthorities["commitLock"],
  authorities: InstallerMaterializationAuthorities,
): Effect.Effect<
  LocalInstallChangeResult,
  InstallerMaterializationError | import("./types.js").InstallerPlanningError
> {
  return lock.withExclusiveCommit((fence) =>
    Effect.gen(function* () {
      const receipt = yield* authorities.receipts.readReceipt(receiptId);
      if (!receipt || receipt.state !== "active") {
        return yield* Effect.fail(
          materializationError("INSTALL_RECEIPT_NOT_ACTIVE", "The install receipt is not active."),
        );
      }
      const inspection = yield* authorities.filesystem.inspectOwned(receipt);
      if (!inspection.matches) {
        return {
          receiptId,
          status: "drifted" as const,
          driftedPaths: inspection.driftedPaths,
        };
      }
      yield* fence.assertValid;
      const previous = receipt.previousReceiptId
        ? yield* authorities.receipts.readReceipt(receipt.previousReceiptId)
        : null;
      if (receipt.previousReceiptId && !previous) {
        return yield* Effect.fail(
          materializationError(
            "INSTALL_RECEIPT_CORRUPT",
            "The previous receipt required for rollback is missing.",
          ),
        );
      }
      const operation = makeChangeOperation("rollback", receipt, fence, authorities.now());
      yield* fenceCheckpoint(fence);
      yield* authorities.receipts.beginInstall({ operation, fenceId: fence.fenceId });
      const step = operation.steps[0]!;
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.markStepStarted(
            operation.operationId,
            step.sequence,
            authorities.now(),
          );
          yield* authorities.filesystem.restoreOwned({
            receipt,
            previous,
            step,
            assertFence: fenceCheckpoint(fence),
          });
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.markStepCompleted(
            operation.operationId,
            step.sequence,
            authorities.now(),
          );
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.commitRollback({
            operationId: operation.operationId,
            receiptId,
            at: authorities.now(),
          });
        }),
      );
      if (Exit.isFailure(exit)) {
        yield* failAndRecoverChange(
          { ...operation, steps: [{ ...step, state: "started" }] },
          authorities,
          fence,
        );
        return yield* Effect.failCause(exit.cause);
      }
      const cleanupExit = yield* Effect.exit(
        authorities.filesystem.cleanupAfterCommit(step, fenceCheckpoint(fence)),
      );
      if (Exit.isSuccess(cleanupExit)) {
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.markCleanupCompleted(
          operation.operationId,
          null,
          null,
          authorities.now(),
        );
      }
      return { receiptId, status: "rolled_back" as const, driftedPaths: [] };
    }),
  );
}

/**
 * Restores every receipt in one fenced filesystem transaction. Each restored
 * target retains its pre-rollback tree until all targets succeed, and the
 * SQLite authority commits every receipt transition in one transaction.
 */
export function rollbackLocalInstalls(
  receiptIds: ReadonlyArray<string>,
  lock: InstallerPlanningAuthorities["commitLock"],
  authorities: Omit<InstallerMaterializationAuthorities, "packages">,
): Effect.Effect<
  ReadonlyArray<LocalInstallChangeResult>,
  InstallerMaterializationError | import("./types.js").InstallerPlanningError
> {
  return lock.withExclusiveCommit((fence) =>
    Effect.gen(function* () {
      if (receiptIds.length === 0 || new Set(receiptIds).size !== receiptIds.length) {
        return yield* Effect.fail(
          materializationError(
            "INSTALL_ROLLBACK_BATCH_INVALID",
            "Aggregate rollback requires unique active receipt identifiers.",
          ),
        );
      }
      if (!authorities.receipts.commitRollbackBatch) {
        return yield* Effect.fail(
          materializationError(
            "INSTALL_ROLLBACK_BATCH_UNSUPPORTED",
            "The durable receipt authority cannot commit aggregate rollback.",
          ),
        );
      }
      const entries: Array<{
        readonly receipt: DurableInstallReceipt;
        readonly previous: DurableInstallReceipt | null;
        readonly operation: DurableInstallOperation;
        readonly step: DurableInstallStep;
      }> = [];
      for (const receiptId of receiptIds) {
        const receipt = yield* authorities.receipts.readReceipt(receiptId);
        if (!receipt || receipt.state !== "active") {
          return yield* Effect.fail(
            materializationError(
              "INSTALL_RECEIPT_NOT_ACTIVE",
              "Every aggregate rollback receipt must still be active.",
            ),
          );
        }
        const inspection = yield* authorities.filesystem.inspectOwned(receipt);
        if (!inspection.matches) {
          return receiptIds.map((current) => ({
            receiptId: current,
            status: "drifted" as const,
            driftedPaths: current === receiptId ? inspection.driftedPaths : [],
          }));
        }
        const previous = receipt.previousReceiptId
          ? yield* authorities.receipts.readReceipt(receipt.previousReceiptId)
          : null;
        if (receipt.previousReceiptId && !previous) {
          return yield* Effect.fail(
            materializationError(
              "INSTALL_RECEIPT_CORRUPT",
              "A previous receipt required for aggregate rollback is missing.",
            ),
          );
        }
        const operation = makeChangeOperation("rollback", receipt, fence, authorities.now());
        entries.push({
          receipt,
          previous,
          operation,
          step: operation.steps[0]!,
        });
      }

      for (const entry of entries) {
        yield* fenceCheckpoint(fence);
        yield* authorities.receipts.beginInstall({
          operation: entry.operation,
          fenceId: fence.fenceId,
        });
      }
      const touched: (typeof entries)[number][] = [];
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          for (const entry of entries) {
            yield* fenceCheckpoint(fence);
            yield* authorities.receipts.markStepStarted(
              entry.operation.operationId,
              entry.step.sequence,
              authorities.now(),
            );
            touched.push(entry);
            yield* authorities.filesystem.restoreOwned({
              receipt: entry.receipt,
              previous: entry.previous,
              step: entry.step,
              assertFence: fenceCheckpoint(fence),
            });
            yield* fenceCheckpoint(fence);
            yield* authorities.receipts.markStepCompleted(
              entry.operation.operationId,
              entry.step.sequence,
              authorities.now(),
            );
          }
          yield* fenceCheckpoint(fence);
          yield* authorities.receipts.commitRollbackBatch!({
            changes: entries.map((entry) => ({
              operationId: entry.operation.operationId,
              receiptId: entry.receipt.receiptId,
            })),
            at: authorities.now(),
          });
        }),
      );
      if (Exit.isFailure(exit)) {
        for (const entry of touched.toReversed()) {
          yield* authorities.filesystem.rollback(entry.step, fenceCheckpoint(fence));
          yield* authorities.receipts.failOperation(
            entry.operation.operationId,
            "INSTALL_ROLLBACK_BATCH_FAILED",
            authorities.now(),
          );
          yield* authorities.receipts.markRolledBack(
            entry.operation.operationId,
            null,
            null,
            authorities.now(),
          );
        }
        return yield* Effect.failCause(exit.cause);
      }
      for (const entry of entries) {
        const cleanup = yield* Effect.exit(
          authorities.filesystem.cleanupAfterCommit(entry.step, fenceCheckpoint(fence)),
        );
        if (Exit.isSuccess(cleanup)) {
          yield* authorities.receipts.markCleanupCompleted(
            entry.operation.operationId,
            null,
            null,
            authorities.now(),
          );
        }
      }
      return entries.map((entry) => ({
        receiptId: entry.receipt.receiptId,
        status: "rolled_back" as const,
        driftedPaths: [],
      }));
    }),
  );
}
