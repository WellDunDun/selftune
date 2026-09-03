import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { LibraryError as CLIError } from "./errors.js";
import { computeSkillVersionHash } from "./hash.js";
import { getSkillSet } from "./manifests.js";
import { assertProjectTargetContained, planSkillManifest, resolvesToSource } from "./planning.js";
import { decodeSkillSetReceipt } from "./schemas.js";
import { assertSafeSegment, atomicWriteJson, entryExists, receiptsDir } from "./storage.js";
import type {
  SkillSetPlanOperation,
  SkillSetReceipt,
  SkillSetReceiptOperation,
  SkillSetServiceOptions,
  SkillSetManifest,
} from "./types.js";

function receiptPath(receiptId: string, options: SkillSetServiceOptions): string {
  return join(receiptsDir(options), `${assertSafeSegment(receiptId, "Skill Set receipt ID")}.json`);
}

function readReceipt(receiptId: string, options: SkillSetServiceOptions): SkillSetReceipt {
  const path = receiptPath(receiptId, options);
  if (!existsSync(path)) {
    throw new CLIError(`Skill Set receipt "${receiptId}" was not found.`, "FILE_NOT_FOUND");
  }
  try {
    const receipt = decodeSkillSetReceipt(JSON.parse(readFileSync(path, "utf8")));
    if (receipt.receipt_id !== receiptId) {
      throw new Error("invalid receipt");
    }
    return receipt;
  } catch {
    throw new CLIError(`Skill Set receipt "${receiptId}" is invalid.`, "OPERATION_FAILED");
  }
}

function pendingReceiptOperation(operation: SkillSetPlanOperation): SkillSetReceiptOperation {
  return {
    harness: operation.harness,
    skill_name: operation.skill_name,
    content_hash: operation.content_hash,
    source_path: operation.source_path,
    target_path: operation.target_path,
    strategy: null,
    state: "pending",
  };
}

function materializeOperation(
  operation: SkillSetPlanOperation,
  projectRoot: string,
): SkillSetReceiptOperation {
  const receiptOperation = {
    harness: operation.harness,
    skill_name: operation.skill_name,
    content_hash: operation.content_hash,
    source_path: operation.source_path,
    target_path: operation.target_path,
  };
  assertProjectTargetContained(projectRoot, operation.target_path);
  mkdirSync(dirname(operation.target_path), { recursive: true });
  assertProjectTargetContained(projectRoot, operation.target_path);
  if (entryExists(operation.target_path)) {
    throw new Error(`Materialization target appeared after preview: ${operation.target_path}`);
  }
  try {
    symlinkSync(operation.source_path, operation.target_path, "dir");
    return {
      ...receiptOperation,
      strategy: "symlink",
      state: "materialized",
      ...materializationIdentity(operation.target_path),
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (!new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL"]).has(String(code))) {
      throw error;
    }
  }

  cpSync(operation.source_path, operation.target_path, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  const copiedHash = computeSkillVersionHash(join(operation.target_path, "SKILL.md"));
  if (copiedHash !== operation.content_hash) {
    rmSync(operation.target_path, { recursive: true, force: true });
    throw new Error(`Materialized copy hash mismatch for "${operation.skill_name}".`);
  }
  return {
    ...receiptOperation,
    strategy: "copy",
    state: "materialized",
    ...materializationIdentity(operation.target_path),
  };
}

function materializationIdentity(targetPath: string): {
  target_device: string;
  target_inode: string;
  target_ctime_ns: string;
} {
  const stats = lstatSync(targetPath, { bigint: true });
  return {
    target_device: stats.dev.toString(),
    target_inode: stats.ino.toString(),
    target_ctime_ns: stats.ctimeNs.toString(),
  };
}

export function applySkillSet(
  input: { set_id: string; project_root: string; harnesses?: ReadonlyArray<string> },
  options: SkillSetServiceOptions = {},
): SkillSetReceipt {
  return applySkillManifest(input, getSkillSet(input.set_id, options), options);
}

export function applySkillManifest(
  input: { project_root: string; harnesses?: ReadonlyArray<string>; temporary_task?: string },
  manifest: SkillSetManifest,
  options: SkillSetServiceOptions = {},
): SkillSetReceipt {
  const plan = planSkillManifest(input, manifest);
  if (plan.conflicts > 0) {
    const firstConflict = plan.operations.find((operation) => operation.action === "conflict")!;
    throw new CLIError(
      `Skill Set apply is blocked by ${plan.conflicts} destination conflict${plan.conflicts === 1 ? "" : "s"}.`,
      "GUARD_BLOCKED",
      `Resolve or archive the package at ${firstConflict.target_path}, then preview again.`,
      2,
    );
  }

  const createOperations = plan.operations.filter((operation) => operation.action === "create");
  for (const operation of createOperations) {
    const currentHash = computeSkillVersionHash(join(operation.source_path, "SKILL.md"));
    if (currentHash !== operation.content_hash) {
      throw new CLIError(
        `The cached Library revision for "${operation.skill_name}" failed verification.`,
        "GUARD_BLOCKED",
        "Re-import the skill package before applying this Skill Set.",
        2,
      );
    }
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const receipt: SkillSetReceipt = {
    schema_version: 1,
    receipt_id: randomUUID(),
    set_id: plan.set_id,
    set_name: plan.set_name,
    set_revision_hash: manifest.revision_hash,
    project_root: plan.project_root,
    status: createOperations.length > 0 ? "applying" : "unchanged",
    operations: [],
    applied_at: timestamp,
    rolled_back_at: null,
    ...(input.temporary_task
      ? {
          temporary_task: input.temporary_task,
          temporary_targets: plan.operations.map((operation) => operation.target_path),
        }
      : {}),
  };
  atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);

  try {
    // Publish the reservation before checking peers. Concurrent overlapping
    // activations may both back off, but cannot borrow each other's links.
    const peer = listSkillSetReceipts(options).find(
      (other) =>
        other.receipt_id !== receipt.receipt_id &&
        other.status !== "rolled_back" &&
        other.temporary_targets?.some((path) =>
          plan.operations.some((op) => op.target_path === path),
        ),
    );
    if (peer)
      throw new Error(
        `Target is reserved by task "${peer.temporary_task}" (receipt ${peer.receipt_id}).`,
      );
    for (const operation of createOperations) {
      const operationIndex = receipt.operations.push(pendingReceiptOperation(operation)) - 1;
      atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
      receipt.operations[operationIndex] = materializeOperation(operation, plan.project_root);
      atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
    }
  } catch (error) {
    let cleanupComplete = true;
    for (const operation of receipt.operations.toReversed()) {
      try {
        if (
          receipt.temporary_task &&
          operation.state === "pending" &&
          entryExists(operation.target_path)
        ) {
          cleanupComplete = false;
          continue;
        }
        const ownedPath = receiptOwnedPath(operation);
        if (ownedPath) rmSync(ownedPath, { recursive: true, force: true });
      } catch {
        cleanupComplete = false;
      }
    }
    if (cleanupComplete) {
      receipt.status = "rolled_back";
      receipt.rolled_back_at = (options.now ?? new Date()).toISOString();
    }
    atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
    throw new CLIError(
      `Skill Set apply failed: ${error instanceof Error ? error.message : String(error)}`,
      "OPERATION_FAILED",
      `Run selftune sets plan --set ${plan.set_id} --project ${plan.project_root} before retrying.`,
    );
  }

  receipt.status = createOperations.length > 0 ? "applied" : "unchanged";
  atomicWriteJson(receiptPath(receipt.receipt_id, options), receipt);
  return receipt;
}

function receiptOwnedPath(operation: SkillSetReceiptOperation): string | null {
  if (!entryExists(operation.target_path)) {
    if (operation.state === "pending") return null;
    throw new CLIError(
      `Rollback target is already missing: ${operation.target_path}`,
      "GUARD_BLOCKED",
      "Inspect the project before changing this receipt.",
      2,
    );
  }
  if (operation.target_device && operation.target_inode) {
    const identity = materializationIdentity(operation.target_path);
    if (
      identity.target_device !== operation.target_device ||
      identity.target_inode !== operation.target_inode ||
      (operation.target_ctime_ns !== undefined &&
        identity.target_ctime_ns !== operation.target_ctime_ns)
    ) {
      throw new CLIError(
        `Rollback target was replaced after SelfTune created it: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement package and resolve the receipt manually.",
        2,
      );
    }
  }
  if (operation.strategy === "symlink") {
    if (!lstatSync(operation.target_path).isSymbolicLink()) {
      throw new CLIError(
        `Rollback target is no longer the link created by SelfTune: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement package and resolve the receipt manually.",
        2,
      );
    }
    if (!resolvesToSource(operation.target_path, operation.source_path)) {
      throw new CLIError(
        `Rollback target now points to a different package: ${operation.target_path}`,
        "GUARD_BLOCKED",
        "Keep the replacement link and resolve the receipt manually.",
        2,
      );
    }
    return operation.target_path;
  }

  const currentHash = computeSkillVersionHash(join(operation.target_path, "SKILL.md"));
  if (currentHash !== operation.content_hash) {
    throw new CLIError(
      `Rollback target has changed since SelfTune copied it: ${operation.target_path}`,
      "GUARD_BLOCKED",
      "Keep the edited package and resolve the receipt manually.",
      2,
    );
  }
  return operation.target_path;
}

export function rollbackSkillSet(
  receiptId: string,
  options: SkillSetServiceOptions = {},
): SkillSetReceipt {
  const receipt = readReceipt(receiptId, options);
  if (receipt.status === "rolled_back") return receipt;

  const ownedPaths = planSkillSetRollback(receiptId, options).paths;
  for (const ownedPath of ownedPaths.toReversed()) {
    if (ownedPath) rmSync(ownedPath, { recursive: true, force: false });
  }

  const rolledBack: SkillSetReceipt = {
    ...receipt,
    status: "rolled_back",
    rolled_back_at: (options.now ?? new Date()).toISOString(),
  };
  atomicWriteJson(receiptPath(receiptId, options), rolledBack);
  return rolledBack;
}

export function planSkillSetRollback(receiptId: string, options: SkillSetServiceOptions = {}) {
  const receipt = readReceipt(receiptId, options);
  if (receipt.status === "rolled_back") return { receipt, paths: [] };
  const paths = receipt.operations.flatMap((operation) => {
    assertProjectTargetContained(receipt.project_root, operation.target_path);
    if (receipt.temporary_task && !entryExists(operation.target_path)) return [];
    if (receipt.temporary_task && operation.state === "pending") {
      throw new CLIError(
        "Interrupted activation has an unverified target; preserve it for manual review.",
        "GUARD_BLOCKED",
      );
    }
    const owned = receiptOwnedPath(operation);
    return owned ? [owned] : [];
  });
  return { receipt, paths };
}

export function listSkillSetReceipts(options: SkillSetServiceOptions = {}): SkillSetReceipt[] {
  const directory = receiptsDir(options);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readReceipt(basename(entry, ".json"), options))
    .toSorted((left, right) => right.applied_at.localeCompare(left.applied_at));
}
