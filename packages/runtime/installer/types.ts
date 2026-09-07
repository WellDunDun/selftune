import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export const InstallerPlatform = Schema.Union([
  Schema.Literal("darwin"),
  Schema.Literal("linux"),
  Schema.Literal("win32"),
]);
export type InstallerPlatform = typeof InstallerPlatform.Type;
export const InstallerAgent = Schema.Union([
  Schema.Literal("codex"),
  Schema.Literal("claude_code"),
  Schema.Literal("opencode"),
  Schema.Literal("openclaw"),
  Schema.Literal("pi"),
]);
export type InstallerAgent = typeof InstallerAgent.Type;
export const InstallerScope = Schema.Union([Schema.Literal("project"), Schema.Literal("global")]);
export type InstallerScope = typeof InstallerScope.Type;
export const InstallStrategy = Schema.Union([Schema.Literal("copy"), Schema.Literal("symlink")]);
export type InstallStrategy = typeof InstallStrategy.Type;
export const UnmanagedConflictPolicy = Schema.Union([
  Schema.Literal("cancel"),
  Schema.Literal("side_by_side"),
  Schema.Literal("replace_with_backup"),
]);
export type UnmanagedConflictPolicy = typeof UnmanagedConflictPolicy.Type;

export const PackageFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  byteLength: Schema.Number,
  kind: Schema.Union([
    Schema.Literal("file"),
    Schema.Literal("directory"),
    Schema.Literal("symlink"),
    Schema.Literal("special"),
  ]),
});
export type PackageFile = typeof PackageFile.Type;

export const LicenseEvidence = Schema.Struct({
  spdxExpression: Schema.String,
  licenseFile: Schema.Union([
    Schema.Null,
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
    }),
  ]),
  notices: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
    }),
  ),
});
export type LicenseEvidence = typeof LicenseEvidence.Type;

export const ActionConsent = Schema.Struct({
  consentId: Schema.String,
  recipientPrincipalId: Schema.String,
  recordedAt: Schema.String,
  action: Schema.Union([
    Schema.Literal("install_with_selftune"),
    Schema.Literal("local_authoring"),
  ]),
  disclosureSha256: Schema.String,
  termsAccepted: Schema.Literal(true),
  contributorSignals: Schema.Union([Schema.Literal("granted"), Schema.Literal("not_granted")]),
  contributorSignalRecipientOwnerId: Schema.Union([Schema.String, Schema.Null]),
  contributorSignalAllowedFields: Schema.Array(Schema.String),
  lifecycleReporting: Schema.Union([Schema.Literal("granted"), Schema.Literal("not_granted")]),
  lifecycleAllowedFields: Schema.Array(Schema.String),
});
export type ActionConsent = typeof ActionConsent.Type;

export const InstallableSkill = Schema.Struct({
  name: Schema.String,
  logicalSkillId: Schema.String,
  logicalVersion: Schema.String,
  distributionId: Schema.String,
  shareId: Schema.String,
  handoffId: Schema.String,
  sealedPackageSha256: Schema.String,
  signature: Schema.Struct({
    algorithm: Schema.String,
    keyId: Schema.String,
    value: Schema.String,
  }),
  license: LicenseEvidence,
  consent: ActionConsent,
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("remote_sealed"),
      objectId: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("local_authoring_immutable"),
      absolutePath: Schema.String,
      sourceSha256: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("temporary"),
      absolutePath: Schema.String,
    }),
  ]),
  files: Schema.Array(PackageFile),
});
export type InstallableSkill = typeof InstallableSkill.Type;

export const InstallSubject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("standalone"),
    skill: InstallableSkill,
  }),
  Schema.Struct({
    kind: Schema.Literal("skill_set"),
    skillSetId: Schema.String,
    logicalVersion: Schema.String,
    sealedPackageSha256: Schema.String,
    skills: Schema.Array(InstallableSkill),
  }),
]);
export type InstallSubject = typeof InstallSubject.Type;

export interface LocalInstallRequest {
  readonly installBootstrapToken: string;
  readonly scope: InstallerScope;
  readonly projectRoot?: string;
  readonly targetAgents: ReadonlyArray<InstallerAgent>;
  readonly strategy?: InstallStrategy;
  readonly unmanagedPolicy: UnmanagedConflictPolicy;
}

export interface RootObservation {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly writable: boolean;
  readonly kind: "directory" | "file" | "symlink" | "reparse" | "special";
  readonly ancestors: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "symlink" | "reparse";
    readonly resolvedPath?: string;
  }>;
}

export const ObservedFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  kind: Schema.Union([
    Schema.Literal("file"),
    Schema.Literal("directory"),
    Schema.Literal("symlink"),
    Schema.Literal("special"),
  ]),
});
export type ObservedFile = typeof ObservedFile.Type;

export interface DestinationObservation {
  readonly targetPath: string;
  readonly kind: "missing" | "directory" | "symlink" | "reparse" | "file" | "special";
  readonly writable: boolean;
  readonly files: ReadonlyArray<ObservedFile>;
  readonly ancestors: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "symlink" | "reparse";
    readonly resolvedPath?: string;
  }>;
  readonly nearestExistingParent: RootObservation;
}

export interface InstallerEnvironmentObservation {
  readonly platform: InstallerPlatform;
  readonly homeDirectory: string;
  readonly configDirectory: string | null;
  readonly selectedRoot: RootObservation;
  readonly authorizedGlobalRoots: ReadonlyArray<{
    readonly canonicalPath: string;
    readonly source: "home" | "config" | "agent";
    readonly agents: "all" | ReadonlyArray<InstallerAgent>;
  }>;
}

export interface InstallerPathObservations {
  readonly destinations: ReadonlyArray<DestinationObservation>;
  readonly localSources: ReadonlyArray<{
    readonly requestedPath: string;
    readonly canonicalPath: string;
    readonly exists: boolean;
    readonly kind: "directory" | "file" | "symlink" | "reparse" | "special";
    readonly temporary: boolean;
    readonly immutableSnapshot: boolean;
    readonly contentSha256: string;
    readonly ancestors: RootObservation["ancestors"];
  }>;
}

export interface InstallAuthorizationClaims {
  readonly subject: InstallSubject;
}

declare const VerifiedInstallAuthorizationBrand: unique symbol;
export interface VerifiedInstallAuthorization {
  readonly [VerifiedInstallAuthorizationBrand]: true;
  readonly subject: InstallSubject;
}

export interface InstallAuthorizationAuthority {
  readonly verify: (
    installBootstrapToken: string,
  ) => Effect.Effect<VerifiedInstallAuthorization, InstallerPlanningError>;
}

export interface InstallerOsObservationAuthority {
  readonly observeEnvironment: (input: {
    readonly scope: InstallerScope;
    readonly projectRoot?: string;
  }) => Effect.Effect<InstallerEnvironmentObservation, InstallerPlanningError>;
  readonly observePaths: (input: {
    readonly platform: InstallerPlatform;
    readonly destinationPaths: ReadonlyArray<string>;
    readonly localSourcePaths: ReadonlyArray<string>;
  }) => Effect.Effect<InstallerPathObservations, InstallerPlanningError>;
}

export const StoredInstallReceipt = Schema.Struct({
  receiptId: Schema.String,
  state: Schema.Union([
    Schema.Literal("active"),
    Schema.Literal("superseded"),
    Schema.Literal("removed"),
  ]),
  agent: InstallerAgent,
  scope: InstallerScope,
  projectRoot: Schema.Union([Schema.String, Schema.Null]),
  registryRoot: Schema.String,
  targetPath: Schema.String,
  skillName: Schema.String,
  logicalSkillId: Schema.String,
  sealedPackageSha256: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      durableSnapshotRef: Schema.String,
    }),
  ),
});
export type StoredInstallReceipt = typeof StoredInstallReceipt.Type;

/** Read-only projection of the local SQLite receipt authority. */
export interface SqliteInstallReceiptAuthority {
  readonly readReceipts: (
    targetPaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<StoredInstallReceipt>, InstallerPlanningError>;
}

export interface InstallerCommitFence {
  readonly fenceId: string;
  readonly generation?: number;
  readonly assertValid: Effect.Effect<void, InstallerPlanningError>;
  readonly checkpoint?: Effect.Effect<void, InstallerPlanningError>;
}

export interface InstallerExclusiveCommitLock {
  readonly withExclusiveCommit: <A, E, R>(
    commit: (fence: InstallerCommitFence) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InstallerPlanningError, R>;
}

export interface InstallerPlanningAuthorities {
  readonly authorization: InstallAuthorizationAuthority;
  readonly os: InstallerOsObservationAuthority;
  readonly receipts: SqliteInstallReceiptAuthority;
  readonly commitLock: InstallerExclusiveCommitLock;
}

export interface AgentDetectionObservation {
  readonly agent: InstallerAgent;
  readonly evidence: ReadonlyArray<string>;
}

export interface AgentSuggestion extends AgentDetectionObservation {
  readonly selected: false;
}

export const PlannedFileOperation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("backup_destination"),
    targetPath: Schema.String,
    relativePath: Schema.Literal("."),
    backupPath: Schema.String,
    mode: Schema.Literal("copy"),
    expectedFiles: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        sha256: Schema.String,
        durableSnapshotRef: Schema.String,
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("create_file"),
    targetPath: Schema.String,
    relativePath: Schema.String,
    expectedBeforeSha256: Schema.Null,
    afterSha256: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("replace_file"),
    targetPath: Schema.String,
    relativePath: Schema.String,
    expectedBeforeSha256: Schema.String,
    previousSnapshotRef: Schema.String,
    afterSha256: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("delete_file"),
    targetPath: Schema.String,
    relativePath: Schema.String,
    expectedBeforeSha256: Schema.String,
    previousSnapshotRef: Schema.String,
    afterSha256: Schema.Null,
  }),
  Schema.Struct({
    kind: Schema.Literal("create_symlink"),
    targetPath: Schema.String,
    relativePath: Schema.Literal("."),
    expectedBeforeSha256: Schema.Null,
    afterSha256: Schema.String,
    sourcePath: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("replace_with_symlink"),
    targetPath: Schema.String,
    relativePath: Schema.Literal("."),
    expectedBeforeFiles: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        sha256: Schema.String,
        durableSnapshotRef: Schema.String,
      }),
    ),
    afterSha256: Schema.String,
    sourcePath: Schema.String,
  }),
]);
export type PlannedFileOperation = typeof PlannedFileOperation.Type;

export interface InstallerConflict {
  readonly code: "UNMANAGED_DESTINATION" | "MANAGED_DRIFT";
  readonly agent: InstallerAgent;
  readonly targetPath: string;
  readonly details: string;
}

export const ReceiptIntent = Schema.Struct({
  receiptId: Schema.String,
  subjectKind: Schema.Literals(["standalone", "skill_set"]),
  skillSet: Schema.Union([
    Schema.Null,
    Schema.Struct({
      skillSetId: Schema.String,
      logicalVersion: Schema.String,
      sealedPackageSha256: Schema.String,
    }),
  ]),
  agent: InstallerAgent,
  platform: InstallerPlatform,
  scope: InstallerScope,
  projectRoot: Schema.Union([Schema.String, Schema.Null]),
  registryRoot: Schema.String,
  targetPath: Schema.String,
  strategy: InstallStrategy,
  unmanagedPolicy: UnmanagedConflictPolicy,
  backupPath: Schema.Union([Schema.String, Schema.Null]),
  existingReceiptId: Schema.Union([Schema.String, Schema.Null]),
  noOp: Schema.Boolean,
  expectedBefore: Schema.Struct({
    kind: Schema.Union([Schema.Literal("missing"), Schema.Literal("directory")]),
    files: Schema.Array(ObservedFile),
  }),
  updatePolicy: Schema.Literal("replan_exact_hash"),
  removalPolicy: Schema.Literal("receipt_owned_files_only"),
  skill: InstallableSkill,
  previewFingerprint: Schema.String,
});
export type ReceiptIntent = typeof ReceiptIntent.Type;

export interface JournalStepIntent {
  readonly sequence: number;
  readonly operation: PlannedFileOperation;
  readonly rollback:
    | { readonly kind: "delete_created" }
    | { readonly kind: "retain_backup"; readonly backupPath: string }
    | { readonly kind: "restore_snapshot"; readonly snapshotRef: string }
    | {
        readonly kind: "restore_previous_files";
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly sha256: string;
          readonly durableSnapshotRef: string;
        }>;
      }
    | { readonly kind: "restore_backup"; readonly backupPath: string };
}

export interface OperationJournalIntent {
  readonly journalId: string;
  readonly state: "planned";
  readonly previewFingerprint: string;
  readonly receiptIds: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<JournalStepIntent>;
}

export interface LocalInstallPlan {
  readonly ready: boolean;
  readonly previewFingerprint: string;
  readonly previewToken: string;
  readonly operations: ReadonlyArray<PlannedFileOperation>;
  readonly conflicts: ReadonlyArray<InstallerConflict>;
  readonly receipts: ReadonlyArray<ReceiptIntent>;
  readonly journal: OperationJournalIntent | null;
}

export class InstallerPlanningError extends Schema.TaggedErrorClass<InstallerPlanningError>()(
  "InstallerPlanningError",
  {
    code: Schema.String,
    message: Schema.String,
    path: Schema.NullOr(Schema.String),
  },
) {}
