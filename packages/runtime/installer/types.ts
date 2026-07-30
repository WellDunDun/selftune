import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export type InstallerPlatform = "darwin" | "linux" | "win32";
export type InstallerAgent = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";
export type InstallerScope = "project" | "global";
export type InstallStrategy = "copy" | "symlink";
export type UnmanagedConflictPolicy = "cancel" | "side_by_side" | "replace_with_backup";

export interface PackageFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly kind: "file" | "directory" | "symlink" | "special";
}

export interface LicenseEvidence {
  readonly spdxExpression: string;
  readonly licenseFile: null | { readonly path: string; readonly sha256: string };
  readonly notices: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

export interface ActionConsent {
  readonly consentId: string;
  readonly recipientPrincipalId: string;
  readonly recordedAt: string;
  readonly action: "install_with_selftune" | "local_authoring";
  readonly disclosureSha256: string;
  readonly termsAccepted: true;
  readonly contributorSignals: "granted" | "not_granted";
  readonly contributorSignalRecipientOwnerId: string | null;
  readonly contributorSignalAllowedFields: ReadonlyArray<string>;
  readonly lifecycleReporting: "granted" | "not_granted";
  readonly lifecycleAllowedFields: ReadonlyArray<string>;
}

export interface InstallableSkill {
  readonly name: string;
  readonly logicalSkillId: string;
  readonly logicalVersion: string;
  readonly distributionId: string;
  readonly shareId: string;
  readonly handoffId: string;
  readonly sealedPackageSha256: string;
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
  readonly license: LicenseEvidence;
  readonly consent: ActionConsent;
  readonly source:
    | { readonly kind: "remote_sealed"; readonly objectId: string }
    | {
        readonly kind: "local_authoring_immutable";
        readonly absolutePath: string;
        readonly sourceSha256: string;
      }
    | { readonly kind: "temporary"; readonly absolutePath: string };
  readonly files: ReadonlyArray<PackageFile>;
}

export type InstallSubject =
  | { readonly kind: "standalone"; readonly skill: InstallableSkill }
  | {
      readonly kind: "skill_set";
      readonly skillSetId: string;
      readonly logicalVersion: string;
      readonly sealedPackageSha256: string;
      readonly skills: ReadonlyArray<InstallableSkill>;
    };

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

export interface ObservedFile {
  readonly path: string;
  readonly sha256: string;
  readonly kind: "file" | "directory" | "symlink" | "special";
}

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

export interface StoredInstallReceipt {
  readonly receiptId: string;
  readonly state: "active" | "superseded" | "removed";
  readonly agent: InstallerAgent;
  readonly scope: InstallerScope;
  readonly projectRoot: string | null;
  readonly registryRoot: string;
  readonly targetPath: string;
  readonly skillName: string;
  readonly logicalSkillId: string;
  readonly sealedPackageSha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly durableSnapshotRef: string;
  }>;
}

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

export type PlannedFileOperation =
  | {
      readonly kind: "backup_destination";
      readonly targetPath: string;
      readonly relativePath: ".";
      readonly backupPath: string;
      readonly mode: "copy";
      readonly expectedFiles: ReadonlyArray<{
        readonly path: string;
        readonly sha256: string;
        readonly durableSnapshotRef: string;
      }>;
    }
  | {
      readonly kind: "create_file";
      readonly targetPath: string;
      readonly relativePath: string;
      readonly expectedBeforeSha256: null;
      readonly afterSha256: string;
    }
  | {
      readonly kind: "replace_file";
      readonly targetPath: string;
      readonly relativePath: string;
      readonly expectedBeforeSha256: string;
      readonly previousSnapshotRef: string;
      readonly afterSha256: string;
    }
  | {
      readonly kind: "delete_file";
      readonly targetPath: string;
      readonly relativePath: string;
      readonly expectedBeforeSha256: string;
      readonly previousSnapshotRef: string;
      readonly afterSha256: null;
    }
  | {
      readonly kind: "create_symlink";
      readonly targetPath: string;
      readonly relativePath: ".";
      readonly expectedBeforeSha256: null;
      readonly afterSha256: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "replace_with_symlink";
      readonly targetPath: string;
      readonly relativePath: ".";
      readonly expectedBeforeFiles: ReadonlyArray<{
        readonly path: string;
        readonly sha256: string;
        readonly durableSnapshotRef: string;
      }>;
      readonly afterSha256: string;
      readonly sourcePath: string;
    };

export interface InstallerConflict {
  readonly code: "UNMANAGED_DESTINATION" | "MANAGED_DRIFT";
  readonly agent: InstallerAgent;
  readonly targetPath: string;
  readonly details: string;
}

export interface ReceiptIntent {
  readonly receiptId: string;
  readonly subjectKind: InstallSubject["kind"];
  readonly skillSet: null | {
    readonly skillSetId: string;
    readonly logicalVersion: string;
    readonly sealedPackageSha256: string;
  };
  readonly agent: InstallerAgent;
  readonly platform: InstallerPlatform;
  readonly scope: InstallerScope;
  readonly projectRoot: string | null;
  readonly registryRoot: string;
  readonly targetPath: string;
  readonly strategy: InstallStrategy;
  readonly unmanagedPolicy: UnmanagedConflictPolicy;
  readonly backupPath: string | null;
  readonly existingReceiptId: string | null;
  readonly noOp: boolean;
  readonly expectedBefore: {
    readonly kind: "missing" | "directory";
    readonly files: ReadonlyArray<ObservedFile>;
  };
  readonly updatePolicy: "replan_exact_hash";
  readonly removalPolicy: "receipt_owned_files_only";
  readonly skill: InstallableSkill;
  readonly previewFingerprint: string;
}

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
