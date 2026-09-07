/* oxlint-disable max-lines */
import { isDeepStrictEqual } from "node:util";
import { Option, Schema } from "effect";
import type {
  skill_install_operations,
  skill_install_receipts,
  skill_install_receipt_files,
} from "@selftune/local-store/schema";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

import type {
  DurableInstallReceiptAuthority,
  InstallerMaterializationError,
} from "./materializer.js";
import {
  DurableInstallOperation,
  DurableInstallReceipt,
  DurableInstallStep,
  InstallerMaterializationError as MaterializationError,
} from "./materializer.js";
import { installerPathKey } from "./paths.js";
import {
  InstallableSkill,
  InstallerPlatform,
  LicenseEvidence,
  type ReceiptIntent,
  PlannedFileOperation,
  type ObservedFile,
  InstallerPlanningError,
  type SqliteInstallReceiptAuthority,
  type StoredInstallReceipt,
} from "./types.js";

export interface SqliteInstallerReceiptAuthorities {
  readonly planning: SqliteInstallReceiptAuthority;
  readonly durable: DurableInstallReceiptAuthority;
}

export interface SqliteInstallerReceiptAuthorityOptions {
  readonly now?: () => number;
  readonly recoveryLeaseMs?: number;
  readonly recoveryHeartbeatMs?: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_STATES = new Set([
  "planned",
  "applying",
  "cleanup_pending",
  "committed",
  "rolling_back",
  "rolled_back",
  "failed",
]);
const STEP_STATES = new Set(["planned", "started", "completed", "rolled_back"]);

function failure(code: string, message: string, path: string | null = null) {
  return MaterializationError.make({ code, message, path });
}

function attempt<A>(
  code: string,
  message: string,
  run: () => A,
): Effect.Effect<A, InstallerMaterializationError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof MaterializationError
        ? cause
        : failure(code, `${message} ${cause instanceof Error ? cause.message : String(cause)}`),
  });
}

function decodeReceiptJson<A>(
  schema: Schema.Codec<A>,
  value: string,
  field: string,
  code: "INSTALL_RECEIPT_CORRUPT" | "INSTALL_JOURNAL_CORRUPT" = "INSTALL_RECEIPT_CORRUPT",
): A {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(value);
  if (Option.isNone(result))
    throw failure(code, `${field} contains malformed or incompatible JSON.`);
  return result.value;
}

function parseStringArray(value: string, field: string): ReadonlyArray<string> {
  return decodeReceiptJson(Schema.Array(Schema.String), value, field);
}

function journalDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const isNonEmptyString = Schema.is(Schema.String.check(Schema.isPattern(/\S/)));
const isNullableString = Schema.is(Schema.NullOr(Schema.String));
const isHash = Schema.is(Schema.String.check(Schema.isPattern(SHA256)));

function isObservedFile(value: ObservedFile): boolean {
  return (
    isNonEmptyString(value.path) &&
    isHash(value.sha256) &&
    ["file", "directory", "symlink", "special"].includes(String(value.kind))
  );
}

function isExpectedBefore(value: ReceiptIntent["expectedBefore"]): boolean {
  return (
    ["missing", "directory"].includes(String(value.kind)) &&
    value.files.every(isObservedFile) &&
    (value.kind === "directory" || value.files.length === 0)
  );
}

function isEvidence(value: NonNullable<LicenseEvidence["licenseFile"]>): boolean {
  return isNonEmptyString(value.path) && isHash(value.sha256);
}

function isPlannedOperation(value: PlannedFileOperation, targetPath: string): boolean {
  if (value.targetPath !== targetPath || !isNonEmptyString(value.kind)) {
    return false;
  }
  if (value.kind === "backup_destination") {
    return (
      value.relativePath === "." &&
      value.mode === "copy" &&
      isNonEmptyString(value.backupPath) &&
      value.expectedFiles.every(
        (file) =>
          isNonEmptyString(file.path) &&
          isHash(file.sha256) &&
          isNonEmptyString(file.durableSnapshotRef),
      )
    );
  }
  if (value.kind === "create_file") {
    return (
      isNonEmptyString(value.relativePath) &&
      value.expectedBeforeSha256 === null &&
      isHash(value.afterSha256)
    );
  }
  if (value.kind === "replace_file") {
    return (
      isNonEmptyString(value.relativePath) &&
      isHash(value.expectedBeforeSha256) &&
      isNonEmptyString(value.previousSnapshotRef) &&
      isHash(value.afterSha256)
    );
  }
  if (value.kind === "delete_file") {
    return (
      isNonEmptyString(value.relativePath) &&
      isHash(value.expectedBeforeSha256) &&
      isNonEmptyString(value.previousSnapshotRef) &&
      value.afterSha256 === null
    );
  }
  if (value.kind === "create_symlink") {
    return (
      value.relativePath === "." &&
      value.expectedBeforeSha256 === null &&
      isHash(value.afterSha256) &&
      isNonEmptyString(value.sourcePath)
    );
  }
  if (value.kind === "replace_with_symlink") {
    return (
      value.relativePath === "." &&
      value.expectedBeforeFiles.every(
        (file) =>
          isNonEmptyString(file.path) &&
          isHash(file.sha256) &&
          isNonEmptyString(file.durableSnapshotRef),
      ) &&
      isHash(value.afterSha256) &&
      isNonEmptyString(value.sourcePath)
    );
  }
  return false;
}

function isReceiptIntent(value: ReceiptIntent, previewFingerprint: string): boolean {
  const skill = value.skill;
  const source = skill.source;
  const signature = skill.signature;
  const license = skill.license;
  const consent = skill.consent;
  const skillSet = value.skillSet;
  return (
    isNonEmptyString(value.receiptId) &&
    ["standalone", "skill_set"].includes(String(value.subjectKind)) &&
    ((value.subjectKind === "standalone" && skillSet === null) ||
      (value.subjectKind === "skill_set" &&
        skillSet !== null &&
        isNonEmptyString(skillSet.skillSetId) &&
        isNonEmptyString(skillSet.logicalVersion) &&
        isHash(skillSet.sealedPackageSha256))) &&
    ["codex", "claude_code", "opencode", "openclaw", "pi"].includes(String(value.agent)) &&
    ["darwin", "linux", "win32"].includes(String(value.platform)) &&
    ["project", "global"].includes(String(value.scope)) &&
    isNullableString(value.projectRoot) &&
    isNonEmptyString(value.registryRoot) &&
    isNonEmptyString(value.targetPath) &&
    ["copy", "symlink"].includes(String(value.strategy)) &&
    ["cancel", "side_by_side", "replace_with_backup"].includes(String(value.unmanagedPolicy)) &&
    isNullableString(value.backupPath) &&
    value.existingReceiptId === null &&
    value.noOp === false &&
    isExpectedBefore(value.expectedBefore) &&
    value.updatePolicy === "replan_exact_hash" &&
    value.removalPolicy === "receipt_owned_files_only" &&
    value.previewFingerprint === previewFingerprint &&
    isNonEmptyString(skill.name) &&
    isNonEmptyString(skill.logicalSkillId) &&
    isNonEmptyString(skill.logicalVersion) &&
    isNonEmptyString(skill.distributionId) &&
    isNonEmptyString(skill.shareId) &&
    isNonEmptyString(skill.handoffId) &&
    isHash(skill.sealedPackageSha256) &&
    isNonEmptyString(signature.algorithm) &&
    isNonEmptyString(signature.keyId) &&
    isNonEmptyString(signature.value) &&
    isNonEmptyString(license.spdxExpression) &&
    (license.licenseFile === null || isEvidence(license.licenseFile)) &&
    license.notices.every(isEvidence) &&
    isNonEmptyString(consent.consentId) &&
    isNonEmptyString(consent.recipientPrincipalId) &&
    isNonEmptyString(consent.recordedAt) &&
    ["install_with_selftune", "local_authoring"].includes(String(consent.action)) &&
    isHash(consent.disclosureSha256) &&
    consent.termsAccepted === true &&
    ["granted", "not_granted"].includes(String(consent.contributorSignals)) &&
    isNullableString(consent.contributorSignalRecipientOwnerId) &&
    consent.contributorSignalAllowedFields.every(Schema.is(Schema.String)) &&
    ["granted", "not_granted"].includes(String(consent.lifecycleReporting)) &&
    consent.lifecycleAllowedFields.every(Schema.is(Schema.String)) &&
    ((source.kind === "remote_sealed" && isNonEmptyString(source.objectId)) ||
      (source.kind === "local_authoring_immutable" &&
        isNonEmptyString(source.absolutePath) &&
        isHash(source.sourceSha256))) &&
    skill.files.every(
      (file) =>
        isNonEmptyString(file.path) &&
        isHash(file.sha256) &&
        Number.isSafeInteger(file.byteLength) &&
        Number(file.byteLength) >= 0 &&
        ["file", "directory", "symlink", "special"].includes(String(file.kind)),
    )
  );
}

type ReceiptRow = typeof skill_install_receipts.$inferSelect;
type ReceiptFileRow = Pick<
  typeof skill_install_receipt_files.$inferSelect,
  "relative_path" | "sha256" | "byte_length" | "durable_snapshot_ref"
>;
type OperationRow = typeof skill_install_operations.$inferSelect;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw failure("INSTALL_RECEIPT_CORRUPT", `${field} must be non-empty.`);
  }
}

function decodeLicense(row: ReceiptRow): LicenseEvidence {
  assertNonEmpty(row.license_spdx_expression, "license_spdx_expression");
  const licenseFile = decodeReceiptJson(
    LicenseEvidence.fields.licenseFile,
    row.license_file_json,
    "license_file_json",
  );
  const notices = decodeReceiptJson(
    LicenseEvidence.fields.notices,
    row.license_notices_json,
    "license_notices_json",
  );
  if ([licenseFile, ...notices].some((evidence) => evidence !== null && !isHash(evidence.sha256))) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Receipt license evidence is incompatible.");
  }
  return { spdxExpression: row.license_spdx_expression, licenseFile, notices };
}

function decodeReceipt(db: Database, row: ReceiptRow): DurableInstallReceipt {
  for (const [field, value] of Object.entries({
    receipt_id: row.receipt_id,
    skill_name: row.skill_name,
    logical_skill_id: row.logical_skill_id,
    logical_version: row.logical_version,
    distribution_id: row.distribution_id,
    share_id: row.share_id,
    handoff_id: row.handoff_id,
    target_path: row.target_path,
    registry_root: row.registry_root,
    operation_id: row.operation_id,
  })) {
    assertNonEmpty(value, field);
  }
  if (
    !["active", "superseded", "removed"].includes(row.state) ||
    !["standalone", "skill_set"].includes(row.subject_kind) ||
    !["codex", "claude_code", "opencode", "openclaw", "pi"].includes(row.agent) ||
    !["darwin", "linux", "win32"].includes(row.platform) ||
    !["project", "global"].includes(row.scope) ||
    !["copy", "symlink"].includes(row.strategy) ||
    !["cancel", "side_by_side", "replace_with_backup"].includes(row.conflict_decision) ||
    !SHA256.test(row.sealed_package_sha256) ||
    !SHA256.test(row.disclosure_sha256)
  ) {
    throw failure(
      "INSTALL_RECEIPT_CORRUPT",
      "Receipt state, bindings, strategy, or hashes are incompatible.",
      row.target_path,
    );
  }
  if (
    row.backup_path !== null &&
    row.backup_path !==
      `${row.target_path}.selftune-backup-${row.sealed_package_sha256.slice(0, 12)}`
  ) {
    throw failure(
      "INSTALL_RECEIPT_CORRUPT",
      "Receipt backup path is not derived from its target and sealed identity.",
      row.backup_path,
    );
  }
  const platform = Schema.decodeUnknownSync(InstallerPlatform)(row.platform);
  if (installerPathKey(platform, row.target_path) !== row.target_path_key) {
    throw failure(
      "INSTALL_RECEIPT_CORRUPT",
      "Receipt target identity is not canonical for its platform.",
      row.target_path,
    );
  }
  const source = decodeReceiptJson(
    InstallableSkill.fields.source,
    row.source_identity,
    "source_identity",
  );
  if (source.kind === "temporary") {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Receipt source identity is incompatible.");
  }
  if (source.kind !== row.source_kind) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Receipt source columns disagree.");
  }
  const files = db
    .query<ReceiptFileRow, string[]>(
      `SELECT relative_path, sha256, byte_length, durable_snapshot_ref
       FROM skill_install_receipt_files WHERE receipt_id = ? ORDER BY relative_path`,
    )
    .all(row.receipt_id);
  if (files.length === 0) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "An install receipt must own at least one file.");
  }
  for (const file of files) {
    if (
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.byte_length) ||
      file.byte_length < 0 ||
      file.relative_path.trim().length === 0 ||
      file.durable_snapshot_ref.trim().length === 0
    ) {
      throw failure(
        "INSTALL_RECEIPT_CORRUPT",
        "Receipt file evidence is invalid.",
        file.relative_path,
      );
    }
  }
  const license = decodeLicense(row);
  for (const evidence of [license.licenseFile, ...license.notices]) {
    if (evidence === null) continue;
    const file = files.find((candidate) => candidate.relative_path === evidence.path);
    if (!file || file.sha256 !== evidence.sha256) {
      throw failure(
        "INSTALL_RECEIPT_CORRUPT",
        "Receipt license evidence does not match its owned file evidence.",
        evidence.path,
      );
    }
  }
  const contributorFields = parseStringArray(
    row.contributor_signal_fields_json,
    "contributor_signal_fields_json",
  );
  const lifecycleFields = parseStringArray(row.lifecycle_fields_json, "lifecycle_fields_json");
  if (
    !["install_with_selftune", "local_authoring"].includes(row.consent_action) ||
    !["granted", "not_granted"].includes(row.contributor_signals) ||
    !["granted", "not_granted"].includes(row.lifecycle_reporting) ||
    row.recipient_principal_id.trim().length === 0 ||
    (row.contributor_signals === "not_granted" &&
      (row.contributor_signal_owner_id !== null || contributorFields.length !== 0)) ||
    (row.contributor_signals === "granted" &&
      (!row.contributor_signal_owner_id || contributorFields.length === 0)) ||
    (row.lifecycle_reporting === "not_granted" && lifecycleFields.length !== 0) ||
    (row.lifecycle_reporting === "granted" && lifecycleFields.length === 0)
  ) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Receipt consent evidence is incompatible.");
  }
  const skillSet =
    row.subject_kind === "skill_set"
      ? {
          skillSetId: row.skill_set_id ?? "",
          logicalVersion: row.skill_set_version ?? "",
          sealedPackageSha256: row.skill_set_package_sha256 ?? "",
        }
      : null;
  if (
    (row.subject_kind === "skill_set" &&
      (!skillSet?.skillSetId ||
        !skillSet.logicalVersion ||
        !SHA256.test(skillSet.sealedPackageSha256))) ||
    (row.subject_kind === "standalone" &&
      (row.skill_set_id !== null ||
        row.skill_set_version !== null ||
        row.skill_set_package_sha256 !== null))
  ) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Skill Set receipt identity is inconsistent.");
  }
  const decoded = Schema.decodeUnknownOption(DurableInstallReceipt)({
    receiptId: row.receipt_id,
    state: row.state,
    subjectKind: row.subject_kind,
    skillSet,
    agent: row.agent,
    platform,
    scope: row.scope,
    projectRoot: row.project_root,
    registryRoot: row.registry_root,
    targetPath: row.target_path,
    skillName: row.skill_name,
    logicalSkillId: row.logical_skill_id,
    logicalVersion: row.logical_version,
    distributionId: row.distribution_id,
    shareId: row.share_id,
    handoffId: row.handoff_id,
    sealedPackageSha256: row.sealed_package_sha256,
    sealedObjectId: row.sealed_object_id,
    signature: {
      algorithm: row.signature_algorithm,
      keyId: row.signature_key_id,
      value: row.signature_value,
    },
    license,
    strategy: row.strategy,
    conflictDecision: row.conflict_decision,
    backupPath: row.backup_path,
    consent: {
      consentId: row.consent_id,
      recipientPrincipalId: row.recipient_principal_id,
      recordedAt: row.consent_recorded_at,
      action: row.consent_action,
      disclosureSha256: row.disclosure_sha256,
      termsAccepted: true,
      contributorSignals: row.contributor_signals,
      contributorSignalRecipientOwnerId: row.contributor_signal_owner_id,
      contributorSignalAllowedFields: contributorFields,
      lifecycleReporting: row.lifecycle_reporting,
      lifecycleAllowedFields: lifecycleFields,
    },
    source,
    previewFingerprint: row.preview_fingerprint,
    operationId: row.operation_id,
    previousReceiptId: row.previous_receipt_id,
    supersededByReceiptId: row.superseded_by_receipt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    files: files.map((file) => ({
      path: file.relative_path,
      sha256: file.sha256,
      byteLength: file.byte_length,
      durableSnapshotRef: file.durable_snapshot_ref,
    })),
  });
  if (Option.isNone(decoded)) {
    throw failure("INSTALL_RECEIPT_CORRUPT", "Receipt fields are incompatible.", row.target_path);
  }
  return decoded.value;
}

function insertReceipt(db: Database, receipt: DurableInstallReceipt): void {
  const targetKey = installerPathKey(receipt.platform, receipt.targetPath);
  const previous = db
    .query<{ receipt_id: string }, string[]>(
      `SELECT receipt_id FROM skill_install_receipts
       WHERE target_path_key = ? AND state = 'active' LIMIT 1`,
    )
    .get(targetKey);
  if (previous && previous.receipt_id !== receipt.receiptId) {
    db.query(
      `UPDATE skill_install_receipts
       SET state = 'superseded', superseded_by_receipt_id = ?, updated_at = ?
       WHERE receipt_id = ? AND state = 'active'`,
    ).run(receipt.receiptId, receipt.updatedAt, previous.receipt_id);
  }
  db.query(
    `INSERT INTO skill_install_receipts (
      receipt_id, state, subject_kind, skill_set_id, skill_set_version,
      skill_set_package_sha256, skill_name, logical_skill_id, logical_version,
      distribution_id, share_id, handoff_id, sealed_package_sha256, sealed_object_id,
      signature_algorithm, signature_key_id, signature_value,
      license_spdx_expression, license_file_json, license_notices_json, agent, platform, scope,
      project_root, registry_root, target_path, target_path_key, strategy, conflict_decision, backup_path,
      consent_id, recipient_principal_id, consent_recorded_at, consent_action, disclosure_sha256,
      contributor_signals, contributor_signal_owner_id, contributor_signal_fields_json,
      lifecycle_reporting, lifecycle_fields_json, source_kind, source_identity,
      preview_fingerprint, operation_id, previous_receipt_id, superseded_by_receipt_id,
      created_at, updated_at, removed_at
    ) VALUES (${Array.from({ length: 49 }, () => "?").join(", ")})`,
  ).run(
    receipt.receiptId,
    receipt.state,
    receipt.subjectKind,
    receipt.skillSet?.skillSetId ?? null,
    receipt.skillSet?.logicalVersion ?? null,
    receipt.skillSet?.sealedPackageSha256 ?? null,
    receipt.skillName,
    receipt.logicalSkillId,
    receipt.logicalVersion,
    receipt.distributionId,
    receipt.shareId,
    receipt.handoffId,
    receipt.sealedPackageSha256,
    receipt.sealedObjectId,
    receipt.signature.algorithm,
    receipt.signature.keyId,
    receipt.signature.value,
    receipt.license.spdxExpression,
    JSON.stringify(receipt.license.licenseFile),
    JSON.stringify(receipt.license.notices),
    receipt.agent,
    receipt.platform,
    receipt.scope,
    receipt.projectRoot,
    receipt.registryRoot,
    receipt.targetPath,
    targetKey,
    receipt.strategy,
    receipt.conflictDecision,
    receipt.backupPath,
    receipt.consent.consentId,
    receipt.consent.recipientPrincipalId,
    receipt.consent.recordedAt,
    receipt.consent.action,
    receipt.consent.disclosureSha256,
    receipt.consent.contributorSignals,
    receipt.consent.contributorSignalRecipientOwnerId,
    JSON.stringify(receipt.consent.contributorSignalAllowedFields),
    receipt.consent.lifecycleReporting,
    JSON.stringify(receipt.consent.lifecycleAllowedFields),
    receipt.source.kind,
    JSON.stringify(receipt.source),
    receipt.previewFingerprint,
    receipt.operationId,
    previous?.receipt_id ?? null,
    null,
    receipt.createdAt,
    receipt.updatedAt,
    receipt.removedAt,
  );
  const insertFile = db.query(
    `INSERT INTO skill_install_receipt_files
      (receipt_id, relative_path, sha256, byte_length, durable_snapshot_ref)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const file of receipt.files) {
    insertFile.run(
      receipt.receiptId,
      file.path,
      file.sha256,
      file.byteLength,
      file.durableSnapshotRef,
    );
  }
}

interface OperationStepRow {
  readonly sequence: number;
  readonly receipt_id: string | null;
  readonly kind: string;
  readonly state: string;
  readonly target_path: string;
  readonly staging_path: string | null;
  readonly rollback_path: string | null;
  readonly snapshot_path: string | null;
  readonly expected_sha256: string | null;
  readonly retain_rollback_after_commit: number;
  readonly restore_backup_path: string | null;
  readonly strategy: string;
  readonly source_path: string | null;
  readonly operations_json: string;
  readonly expected_before_json: string;
}

function validateStepBindings(
  value: DurableInstallStep,
  operationId: string,
  operationKind: DurableInstallOperation["kind"],
  fenceGeneration: number,
  index: number,
): boolean {
  const mutation =
    operationKind === "install" ? "install" : operationKind === "remove" ? "remove" : "restore";
  const expectedStaging =
    operationKind === "install"
      ? `${String(value.targetPath)}.selftune-stage-${operationId}-g${fenceGeneration}-${index}`
      : `${String(value.targetPath)}.selftune-${operationKind}-stage-${operationId}-g${fenceGeneration}`;
  const expectedRollback = `${String(value.targetPath)}.selftune-${operationKind}-rollback-${operationId}-g${fenceGeneration}`;
  const expectedSnapshot =
    operationKind === "install"
      ? `${String(value.targetPath)}.selftune-owned-${String(value.receiptId)}-g${fenceGeneration}`
      : `${String(value.targetPath)}.selftune-${operationKind}-snapshot-${operationId}-g${fenceGeneration}`;
  const targetPath = value.targetPath;
  return (
    value.sequence === index &&
    isNonEmptyString(value.receiptId) &&
    value.mutation === mutation &&
    value.state === "planned" &&
    isNonEmptyString(value.targetPath) &&
    value.stagingPath === expectedStaging &&
    isNonEmptyString(value.rollbackPath) &&
    (operationKind === "install" || value.rollbackPath === expectedRollback) &&
    value.snapshotPath === expectedSnapshot &&
    Schema.is(Schema.Boolean)(value.retainRollbackAfterCommit) &&
    isNullableString(value.restoreBackupPath) &&
    ["copy", "symlink"].includes(String(value.strategy)) &&
    isNullableString(value.sourcePath) &&
    isHash(value.expectedSealedPackageSha256) &&
    isExpectedBefore(value.expectedBefore) &&
    value.operations.every((operation) => isPlannedOperation(operation, targetPath))
  );
}

function assertOperationBindings(operation: DurableInstallOperation): void {
  if (operation.kind === "install") {
    if (
      operation.receiptIntents.length !== operation.steps.length ||
      operation.steps.some((step) => {
        const intent = operation.receiptIntents.find(
          (candidate) => candidate.receiptId === step.receiptId,
        );
        if (!intent) return true;
        const expectedRollback =
          intent.backupPath ??
          `${intent.targetPath}.selftune-rollback-${operation.operationId}-g${operation.fenceGeneration}-${step.sequence}`;
        const sourcePath =
          intent.skill.source.kind === "local_authoring_immutable"
            ? intent.skill.source.absolutePath
            : null;
        return (
          (intent.backupPath !== null &&
            intent.backupPath !==
              `${intent.targetPath}.selftune-backup-${intent.skill.sealedPackageSha256.slice(0, 12)}`) ||
          step.targetPath !== intent.targetPath ||
          step.rollbackPath !== expectedRollback ||
          step.retainRollbackAfterCommit !== (intent.backupPath !== null) ||
          step.restoreBackupPath !== null ||
          step.strategy !== intent.strategy ||
          step.sourcePath !== sourcePath ||
          step.expectedSealedPackageSha256 !== intent.skill.sealedPackageSha256 ||
          JSON.stringify(step.expectedBefore) !== JSON.stringify(intent.expectedBefore)
        );
      }) ||
      new Set(operation.steps.map((step) => step.receiptId)).size !== operation.steps.length ||
      new Set(operation.steps.map((step) => step.targetPath)).size !== operation.steps.length
    ) {
      throw failure("INSTALL_JOURNAL_CORRUPT", "Installer receipt intents and steps disagree.");
    }
    return;
  }
  if (
    operation.receiptIntents.length !== 0 ||
    operation.steps.length !== 1 ||
    operation.steps[0]?.retainRollbackAfterCommit !== false ||
    operation.steps[0]?.operations.length !== 0 ||
    (operation.kind === "remove" && operation.steps[0]?.restoreBackupPath !== null)
  ) {
    throw failure("INSTALL_JOURNAL_CORRUPT", "Installer change operation is inconsistent.");
  }
}

function decodeOperation(db: Database, row: OperationRow | null): DurableInstallOperation {
  if (
    row === null ||
    !isNonEmptyString(row.operation_id) ||
    !isNonEmptyString(row.kind) ||
    !isNonEmptyString(row.state) ||
    !OPERATION_STATES.has(row.state) ||
    !isNonEmptyString(row.preview_fingerprint) ||
    !isNonEmptyString(row.fence_id) ||
    !Number.isSafeInteger(row.fence_generation) ||
    !Number.isSafeInteger(row.recovery_generation) ||
    Number(row.recovery_generation) < 0 ||
    !isNonEmptyString(row.request_json) ||
    !isHash(row.request_sha256) ||
    journalDigest(row.request_json) !== row.request_sha256 ||
    !isNonEmptyString(row.created_at) ||
    !isNonEmptyString(row.updated_at) ||
    !(row.recovery_token === null || isNonEmptyString(row.recovery_token))
  ) {
    throw failure("INSTALL_JOURNAL_CORRUPT", "Installer operation row is incompatible.");
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(DurableInstallOperation))(
    row.request_json,
  );
  if (Option.isNone(decoded)) {
    throw failure(
      "INSTALL_JOURNAL_CORRUPT",
      "Installer operation payload contains malformed or incompatible JSON.",
    );
  }
  const parsed = decoded.value;
  if (
    parsed.operationId !== row.operation_id ||
    parsed.kind !== row.kind ||
    !["install", "remove", "rollback"].includes(String(parsed.kind)) ||
    parsed.state !== "planned" ||
    parsed.previewFingerprint !== row.preview_fingerprint ||
    !isHash(parsed.previewFingerprint) ||
    parsed.fenceId !== row.fence_id ||
    !isNonEmptyString(parsed.fenceId) ||
    parsed.fenceGeneration !== row.fence_generation ||
    !Number.isSafeInteger(parsed.fenceGeneration) ||
    parsed.recoveryToken !== null ||
    parsed.recoveryGeneration !== 0 ||
    parsed.createdAt !== row.created_at ||
    !isNonEmptyString(parsed.updatedAt) ||
    !parsed.receiptIntents.every((intent) =>
      isReceiptIntent(intent, String(parsed.previewFingerprint)),
    )
  ) {
    throw failure("INSTALL_JOURNAL_CORRUPT", "Installer operation identity is inconsistent.");
  }
  const kind = parsed.kind;
  if (
    !parsed.steps.every((step, index) =>
      validateStepBindings(step, parsed.operationId, kind, parsed.fenceGeneration, index),
    )
  ) {
    throw failure("INSTALL_JOURNAL_CORRUPT", "Installer operation steps are incompatible.");
  }
  const operation = parsed;
  assertOperationBindings(operation);
  const stepRows = db
    .query<OperationStepRow, string[]>(
      `SELECT sequence, receipt_id, kind, state, target_path, staging_path, rollback_path,
              snapshot_path, expected_sha256, retain_rollback_after_commit,
              restore_backup_path, strategy, source_path, operations_json, expected_before_json
       FROM skill_install_operation_steps
       WHERE operation_id = ? ORDER BY sequence`,
    )
    .all(operation.operationId);
  if (
    stepRows.length !== operation.steps.length ||
    stepRows.some((stored, index) => {
      const step = operation.steps[index];
      return (
        !step ||
        stored.sequence !== index ||
        !STEP_STATES.has(stored.state) ||
        stored.receipt_id !== step.receiptId ||
        stored.kind !== step.mutation ||
        stored.target_path !== step.targetPath ||
        stored.staging_path !== step.stagingPath ||
        stored.rollback_path !== step.rollbackPath ||
        stored.snapshot_path !== step.snapshotPath ||
        stored.expected_sha256 !== step.expectedSealedPackageSha256 ||
        stored.retain_rollback_after_commit !== (step.retainRollbackAfterCommit ? 1 : 0) ||
        stored.restore_backup_path !== step.restoreBackupPath ||
        stored.strategy !== step.strategy ||
        stored.source_path !== step.sourcePath ||
        !isDeepStrictEqual(
          decodeReceiptJson(
            Schema.Array(PlannedFileOperation),
            stored.operations_json,
            "operations_json",
            "INSTALL_JOURNAL_CORRUPT",
          ),
          step.operations,
        ) ||
        !isDeepStrictEqual(
          decodeReceiptJson(
            DurableInstallStep.fields.expectedBefore,
            stored.expected_before_json,
            "expected_before_json",
            "INSTALL_JOURNAL_CORRUPT",
          ),
          step.expectedBefore,
        )
      );
    })
  ) {
    throw failure(
      "INSTALL_JOURNAL_CORRUPT",
      "Installer operation payload and normalized step columns disagree.",
    );
  }
  return {
    ...operation,
    state: Schema.decodeUnknownSync(DurableInstallOperation.fields.state)(row.state),
    updatedAt: row.updated_at,
    recoveryToken: row.recovery_token,
    recoveryGeneration: row.recovery_generation,
    steps: operation.steps.map((step, index) => ({
      ...step,
      state: Schema.decodeUnknownSync(DurableInstallStep.fields.state)(stepRows[index]!.state),
    })),
  };
}

export function makeSqliteInstallerReceiptAuthority(
  db: Database,
  options: SqliteInstallerReceiptAuthorityOptions = {},
): SqliteInstallerReceiptAuthorities {
  const clock = options.now ?? Date.now;
  const recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
  const recoveryHeartbeatMs =
    options.recoveryHeartbeatMs ?? Math.max(10, Math.floor(recoveryLeaseMs / 3));
  if (recoveryLeaseMs < 100 || recoveryHeartbeatMs <= 0 || recoveryHeartbeatMs >= recoveryLeaseMs) {
    throw new Error("Invalid SQLite installer recovery-lease timing configuration.");
  }
  const transaction = <A>(run: () => A): A => db.transaction(run).immediate();
  const readReceiptSync = (receiptId: string): DurableInstallReceipt | null => {
    const row = db
      .query<ReceiptRow, string[]>(
        "SELECT * FROM skill_install_receipts WHERE receipt_id = ? LIMIT 1",
      )
      .get(receiptId);
    return row ? decodeReceipt(db, row) : null;
  };
  const readReceipts = (targetPaths: ReadonlyArray<string>) =>
    attempt("INSTALL_RECEIPT_READ_FAILED", "Unable to read install receipts.", () => {
      if (targetPaths.length === 0) return [];
      const placeholders = targetPaths.map(() => "?").join(", ");
      const rows = db
        .query<ReceiptRow, string[]>(
          `SELECT * FROM skill_install_receipts
             WHERE target_path IN (${placeholders}) ORDER BY created_at, receipt_id`,
        )
        .all(...targetPaths);
      return rows.map((row): StoredInstallReceipt => decodeReceipt(db, row));
    });
  const renewRecoveryClaimSync = (
    operationId: string,
    recoveryToken: string,
    recoveryGeneration: number,
  ): void => {
    const timestamp = clock();
    const renewedAt = new Date(timestamp).toISOString();
    const staleBefore = new Date(timestamp - recoveryLeaseMs).toISOString();
    const result = db
      .query(
        `UPDATE skill_install_operations
         SET recovery_started_at = ?, updated_at = ?
         WHERE operation_id = ? AND recovery_token = ? AND recovery_generation = ?
           AND state IN ('rolling_back', 'cleanup_pending')
           AND recovery_started_at >= ?`,
      )
      .run(renewedAt, renewedAt, operationId, recoveryToken, recoveryGeneration, staleBefore);
    if (result.changes !== 1) {
      throw failure(
        "INSTALL_RECOVERY_FENCE_LOST",
        "The SQLite recovery claim expired or changed before the next mutation.",
      );
    }
  };
  const durable: DurableInstallReceiptAuthority = {
    beginInstall: ({ operation, fenceId }) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to begin the install journal.", () =>
        transaction(() => {
          const existing = db
            .query<OperationRow, string[]>(
              "SELECT * FROM skill_install_operations WHERE operation_id = ? LIMIT 1",
            )
            .get(operation.operationId);
          if (existing) {
            const decoded = decodeOperation(db, existing);
            if (
              decoded.previewFingerprint !== operation.previewFingerprint ||
              decoded.fenceId !== fenceId ||
              existing.request_json !== JSON.stringify(operation)
            ) {
              throw failure(
                "INSTALL_JOURNAL_CONFLICT",
                "An existing operation does not match this fenced plan.",
              );
            }
            return decoded;
          }
          const requestJson = JSON.stringify(operation);
          db.query(
            `INSERT INTO skill_install_operations
              (operation_id, kind, state, preview_fingerprint, fence_id, fence_generation,
               request_json, request_sha256, created_at, updated_at)
             VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            operation.operationId,
            operation.kind,
            operation.previewFingerprint,
            fenceId,
            operation.fenceGeneration,
            requestJson,
            journalDigest(requestJson),
            operation.createdAt,
            operation.updatedAt,
          );
          const insertStep = db.query(
            `INSERT INTO skill_install_operation_steps
              (operation_id, sequence, receipt_id, kind, state, target_path, staging_path,
               rollback_path, snapshot_path, expected_sha256, retain_rollback_after_commit,
               restore_backup_path, strategy, source_path, operations_json, expected_before_json)
             VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const step of operation.steps) {
            insertStep.run(
              operation.operationId,
              step.sequence,
              step.receiptId,
              step.mutation,
              step.targetPath,
              step.stagingPath,
              step.rollbackPath,
              step.snapshotPath,
              step.expectedSealedPackageSha256,
              step.retainRollbackAfterCommit ? 1 : 0,
              step.restoreBackupPath,
              step.strategy,
              step.sourcePath,
              JSON.stringify(step.operations),
              JSON.stringify(step.expectedBefore),
            );
          }
          return operation;
        }),
      ),
    markStepStarted: (operationId, sequence, at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to start an install step.", () =>
        transaction(() => {
          const result = db
            .query(
              `UPDATE skill_install_operation_steps
               SET state = 'started', started_at = COALESCE(started_at, ?)
               WHERE operation_id = ? AND sequence = ? AND state IN ('planned', 'started')`,
            )
            .run(at, operationId, sequence);
          if (result.changes !== 1) {
            throw failure("INSTALL_JOURNAL_CONFLICT", "Install step cannot be started.");
          }
          db.query(
            `UPDATE skill_install_operations SET state = 'applying', updated_at = ?
             WHERE operation_id = ? AND state IN ('planned', 'applying')`,
          ).run(at, operationId);
        }),
      ),
    markStepCompleted: (operationId, sequence, at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to complete an install step.", () => {
        const result = db
          .query(
            `UPDATE skill_install_operation_steps
             SET state = 'completed', completed_at = ?
             WHERE operation_id = ? AND sequence = ? AND state IN ('started', 'completed')`,
          )
          .run(at, operationId, sequence);
        if (result.changes !== 1) {
          throw failure("INSTALL_JOURNAL_CONFLICT", "Install step cannot be completed.");
        }
      }),
    commitInstall: ({ operationId, receipts, at }) =>
      attempt("INSTALL_RECEIPT_WRITE_FAILED", "Unable to commit install receipts.", () =>
        transaction(() => {
          const operation = db
            .query<{ state: string }, string[]>(
              "SELECT state FROM skill_install_operations WHERE operation_id = ? LIMIT 1",
            )
            .get(operationId);
          if (!operation) {
            throw failure("INSTALL_JOURNAL_CORRUPT", "Install operation is missing.");
          }
          if (operation.state === "committed" || operation.state === "cleanup_pending") {
            const rows = db
              .query<ReceiptRow, string[]>(
                "SELECT * FROM skill_install_receipts WHERE operation_id = ? ORDER BY receipt_id",
              )
              .all(operationId);
            return rows.map((row) => decodeReceipt(db, row));
          }
          const pending = db
            .query<{ count: number }, string[]>(
              `SELECT COUNT(*) AS count FROM skill_install_operation_steps
               WHERE operation_id = ? AND state != 'completed'`,
            )
            .get(operationId);
          if (!pending || pending.count !== 0) {
            throw failure(
              "INSTALL_JOURNAL_CONFLICT",
              "All filesystem steps must complete before receipts commit.",
            );
          }
          for (const receipt of receipts) insertReceipt(db, receipt);
          const committed = db
            .query(
              `UPDATE skill_install_operations
               SET state = 'cleanup_pending', updated_at = ?, completed_at = ?
               WHERE operation_id = ? AND state = 'applying'`,
            )
            .run(at, at, operationId);
          if (committed.changes !== 1) {
            throw failure(
              "INSTALL_JOURNAL_CONFLICT",
              "Install journal state changed before receipt commit.",
            );
          }
          return receipts.map((receipt) => readReceiptSync(receipt.receiptId)!);
        }),
      ),
    failOperation: (operationId, code, at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to mark an install operation failed.", () => {
        db.query(
          `UPDATE skill_install_operations
           SET state = 'failed', error_code = ?, updated_at = ?
           WHERE operation_id = ? AND state != 'committed'`,
        ).run(code, at, operationId);
      }),
    listRecoverableOperations: () =>
      attempt("INSTALL_JOURNAL_READ_FAILED", "Unable to read recoverable operations.", () =>
        transaction(() => {
          const token = randomUUID();
          const timestamp = clock();
          const now = new Date(timestamp).toISOString();
          const staleBefore = new Date(timestamp - recoveryLeaseMs).toISOString();
          const candidates = db
            .query<{ operation_id: string }, string[]>(
              `SELECT operation_id FROM skill_install_operations
               WHERE state IN ('planned', 'applying', 'failed')
                  OR (state = 'rolling_back' AND recovery_started_at < ?)
               ORDER BY created_at, operation_id`,
            )
            .all(staleBefore);
          const claimed: Array<OperationRow | null> = [];
          for (const candidate of candidates) {
            const result = db
              .query(
                `UPDATE skill_install_operations
                 SET state = 'rolling_back', recovery_token = ?,
                     recovery_generation = recovery_generation + 1,
                     recovery_started_at = ?, updated_at = ?
                 WHERE operation_id = ?
                   AND (state IN ('planned', 'applying', 'failed')
                     OR (state = 'rolling_back' AND recovery_started_at < ?))`,
              )
              .run(token, now, now, candidate.operation_id, staleBefore);
            if (result.changes !== 1) continue;
            claimed.push(
              db
                .query<OperationRow, string[]>(
                  "SELECT * FROM skill_install_operations WHERE operation_id = ?",
                )
                .get(candidate.operation_id),
            );
          }
          return claimed.map((row) => decodeOperation(db, row));
        }),
      ),
    listCleanupOperations: () =>
      attempt("INSTALL_JOURNAL_READ_FAILED", "Unable to read cleanup-pending operations.", () =>
        transaction(() => {
          const token = randomUUID();
          const timestamp = clock();
          const now = new Date(timestamp).toISOString();
          const staleBefore = new Date(timestamp - recoveryLeaseMs).toISOString();
          const candidates = db
            .query<{ operation_id: string }, string[]>(
              `SELECT operation_id FROM skill_install_operations
               WHERE state = 'cleanup_pending'
                 AND (recovery_token IS NULL OR recovery_started_at < ?)
               ORDER BY created_at, operation_id`,
            )
            .all(staleBefore);
          const claimed: Array<OperationRow | null> = [];
          for (const candidate of candidates) {
            const result = db
              .query(
                `UPDATE skill_install_operations
                 SET recovery_token = ?, recovery_generation = recovery_generation + 1,
                     recovery_started_at = ?, updated_at = ?
                 WHERE operation_id = ? AND state = 'cleanup_pending'
                   AND (recovery_token IS NULL OR recovery_started_at < ?)`,
              )
              .run(token, now, now, candidate.operation_id, staleBefore);
            if (result.changes !== 1) continue;
            claimed.push(
              db
                .query<OperationRow, string[]>(
                  "SELECT * FROM skill_install_operations WHERE operation_id = ?",
                )
                .get(candidate.operation_id),
            );
          }
          return claimed.map((row) => decodeOperation(db, row));
        }),
      ),
    markCleanupCompleted: (operationId, recoveryToken, recoveryGeneration, at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to complete operation cleanup.", () => {
        const result = db
          .query(
            `UPDATE skill_install_operations
             SET state = 'committed', recovery_token = NULL, recovery_started_at = NULL,
                 updated_at = ?
             WHERE operation_id = ? AND state = 'cleanup_pending'
               AND ((? IS NULL AND ? IS NULL AND recovery_token IS NULL)
                 OR (recovery_token = ? AND recovery_generation = ?))`,
          )
          .run(
            at,
            operationId,
            recoveryToken,
            recoveryGeneration,
            recoveryToken,
            recoveryGeneration,
          );
        if (result.changes !== 1) {
          throw failure(
            "INSTALL_RECOVERY_FENCE_LOST",
            "The SQLite cleanup claim changed before completion.",
          );
        }
      }),
    renewRecoveryClaim: (operationId, recoveryToken, recoveryGeneration, _at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to renew operation recovery claim.", () =>
        renewRecoveryClaimSync(operationId, recoveryToken, recoveryGeneration),
      ),
    withRecoveryClaim: (operationId, recoveryToken, recoveryGeneration, use) =>
      attempt(
        "INSTALL_JOURNAL_WRITE_FAILED",
        "Unable to start operation recovery heartbeat.",
        () => {
          let lost: InstallerMaterializationError | null = null;
          renewRecoveryClaimSync(operationId, recoveryToken, recoveryGeneration);
          const heartbeat = setInterval(() => {
            try {
              renewRecoveryClaimSync(operationId, recoveryToken, recoveryGeneration);
            } catch (cause) {
              lost =
                cause instanceof MaterializationError
                  ? cause
                  : failure("INSTALL_RECOVERY_FENCE_LOST", String(cause));
            }
          }, recoveryHeartbeatMs);
          const checkpoint = attempt(
            "INSTALL_RECOVERY_FENCE_LOST",
            "Unable to validate operation recovery heartbeat.",
            () => {
              if (lost) throw lost;
              renewRecoveryClaimSync(operationId, recoveryToken, recoveryGeneration);
            },
          );
          return { checkpoint, close: () => clearInterval(heartbeat) };
        },
      ).pipe(
        Effect.flatMap(({ checkpoint, close }) =>
          use(checkpoint).pipe(Effect.ensuring(Effect.sync(close))),
        ),
      ),
    markRolledBack: (operationId, recoveryToken, recoveryGeneration, at) =>
      attempt("INSTALL_JOURNAL_WRITE_FAILED", "Unable to finish journal rollback.", () =>
        transaction(() => {
          const result = db
            .query(
              `UPDATE skill_install_operations
               SET state = 'rolled_back', recovery_token = NULL, recovery_started_at = NULL,
                   updated_at = ?, completed_at = ?
               WHERE operation_id = ? AND state != 'committed'
                 AND ((? IS NULL AND ? IS NULL AND recovery_token IS NULL)
                   OR (recovery_token = ? AND recovery_generation = ?))`,
            )
            .run(
              at,
              at,
              operationId,
              recoveryToken,
              recoveryGeneration,
              recoveryToken,
              recoveryGeneration,
            );
          if (result.changes !== 1) {
            throw failure(
              "INSTALL_RECOVERY_FENCE_LOST",
              "The SQLite recovery claim changed before rollback completed.",
            );
          }
          db.query(
            `UPDATE skill_install_operation_steps
             SET state = 'rolled_back', completed_at = COALESCE(completed_at, ?)
             WHERE operation_id = ? AND state != 'planned'`,
          ).run(at, operationId);
        }),
      ),
    readReceipt: (receiptId) =>
      attempt("INSTALL_RECEIPT_READ_FAILED", "Unable to read the install receipt.", () =>
        readReceiptSync(receiptId),
      ),
    commitRemoval: ({ operationId, receiptId, at }) =>
      attempt("INSTALL_RECEIPT_WRITE_FAILED", "Unable to record install removal.", () =>
        transaction(() => {
          const result = db
            .query(
              `UPDATE skill_install_receipts
               SET state = 'removed', updated_at = ?, removed_at = ?
               WHERE receipt_id = ? AND state = 'active'`,
            )
            .run(at, at, receiptId);
          if (result.changes !== 1) {
            throw failure("INSTALL_RECEIPT_CONFLICT", "The active receipt changed during removal.");
          }
          const operation = db
            .query(
              `UPDATE skill_install_operations SET state = 'cleanup_pending', updated_at = ?, completed_at = ?
               WHERE operation_id = ? AND kind = 'remove' AND state = 'applying'
                 AND NOT EXISTS (
                   SELECT 1 FROM skill_install_operation_steps
                   WHERE operation_id = ? AND state != 'completed'
                 )`,
            )
            .run(at, at, operationId, operationId);
          if (operation.changes !== 1) {
            throw failure("INSTALL_JOURNAL_CONFLICT", "Removal journal is not complete.");
          }
        }),
      ),
    commitRollback: ({ operationId, receiptId, at }) =>
      attempt("INSTALL_RECEIPT_WRITE_FAILED", "Unable to record install rollback.", () =>
        transaction(() => {
          const current = db
            .query<{ previous_receipt_id: string | null }, string[]>(
              `SELECT previous_receipt_id FROM skill_install_receipts
               WHERE receipt_id = ? AND state = 'active' LIMIT 1`,
            )
            .get(receiptId);
          if (!current) {
            throw failure(
              "INSTALL_RECEIPT_CONFLICT",
              "The active receipt changed during rollback.",
            );
          }
          db.query(
            `UPDATE skill_install_receipts
             SET state = 'removed', updated_at = ?, removed_at = ?
             WHERE receipt_id = ?`,
          ).run(at, at, receiptId);
          if (current.previous_receipt_id) {
            db.query(
              `UPDATE skill_install_receipts
               SET state = 'active', superseded_by_receipt_id = NULL, updated_at = ?, removed_at = NULL
               WHERE receipt_id = ? AND state = 'superseded'`,
            ).run(at, current.previous_receipt_id);
          }
          const operation = db
            .query(
              `UPDATE skill_install_operations SET state = 'cleanup_pending', updated_at = ?, completed_at = ?
               WHERE operation_id = ? AND kind = 'rollback' AND state = 'applying'
                 AND NOT EXISTS (
                   SELECT 1 FROM skill_install_operation_steps
                   WHERE operation_id = ? AND state != 'completed'
                 )`,
            )
            .run(at, at, operationId, operationId);
          if (operation.changes !== 1) {
            throw failure("INSTALL_JOURNAL_CONFLICT", "Rollback journal is not complete.");
          }
        }),
      ),
    commitRollbackBatch: ({ changes, at }) =>
      attempt("INSTALL_RECEIPT_WRITE_FAILED", "Unable to record aggregate install rollback.", () =>
        transaction(() => {
          if (
            changes.length === 0 ||
            new Set(changes.map(({ receiptId }) => receiptId)).size !== changes.length
          ) {
            throw failure(
              "INSTALL_ROLLBACK_BATCH_INVALID",
              "Aggregate rollback requires unique receipt transitions.",
            );
          }
          const previousByReceipt = new Map<string, string | null>();
          for (const change of changes) {
            const current = db
              .query<
                {
                  previous_receipt_id: string | null;
                },
                string[]
              >(
                `SELECT previous_receipt_id FROM skill_install_receipts
                 WHERE receipt_id = ? AND state = 'active' LIMIT 1`,
              )
              .get(change.receiptId);
            const operation = db
              .query<{ state: string }, string[]>(
                `SELECT state FROM skill_install_operations
                 WHERE operation_id = ? AND kind = 'rollback' LIMIT 1`,
              )
              .get(change.operationId);
            const pending = db
              .query<{ count: number }, string[]>(
                `SELECT COUNT(*) AS count FROM skill_install_operation_steps
                 WHERE operation_id = ? AND state != 'completed'`,
              )
              .get(change.operationId);
            if (!current || operation?.state !== "applying" || !pending || pending.count !== 0) {
              throw failure(
                "INSTALL_RECEIPT_CONFLICT",
                "An aggregate rollback receipt or journal changed before commit.",
              );
            }
            previousByReceipt.set(change.receiptId, current.previous_receipt_id);
          }
          for (const change of changes) {
            db.query(
              `UPDATE skill_install_receipts
               SET state = 'removed', updated_at = ?, removed_at = ?
               WHERE receipt_id = ? AND state = 'active'`,
            ).run(at, at, change.receiptId);
            const previousReceiptId = previousByReceipt.get(change.receiptId);
            if (previousReceiptId) {
              db.query(
                `UPDATE skill_install_receipts
                 SET state = 'active', superseded_by_receipt_id = NULL, updated_at = ?, removed_at = NULL
                 WHERE receipt_id = ? AND state = 'superseded'`,
              ).run(at, previousReceiptId);
            }
            const committed = db
              .query(
                `UPDATE skill_install_operations
                 SET state = 'cleanup_pending', updated_at = ?, completed_at = ?
                 WHERE operation_id = ? AND kind = 'rollback' AND state = 'applying'`,
              )
              .run(at, at, change.operationId);
            if (committed.changes !== 1) {
              throw failure(
                "INSTALL_JOURNAL_CONFLICT",
                "An aggregate rollback journal changed before commit.",
              );
            }
          }
        }),
      ),
  };
  return {
    durable,
    planning: {
      readReceipts: (targetPaths) =>
        readReceipts(targetPaths).pipe(
          Effect.mapError((cause) =>
            InstallerPlanningError.make({
              code: cause.code,
              message: cause.message,
              path: cause.path,
            }),
          ),
        ),
    },
  };
}
