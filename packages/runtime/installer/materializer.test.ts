/* oxlint-disable max-lines, no-await-in-loop -- adversarial cases intentionally exercise one isolated database at a time */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { openDb } from "@selftune/local-store";

import {
  installLocalSubject,
  makeInstallAuthorizationAuthority,
  makeNodeInstallerMaterializationFileSystem,
  makeSqliteInstallerReceiptAuthority,
  planLocalInstall,
  recoverLocalInstallOperations,
  removeLocalInstall,
  rollbackLocalInstall,
  type InstallableSkill,
  type DurableInstallOperation,
  type InstallerMaterializationAuthorities,
  type InstallerPlanningAuthorities,
  type LocalInstallRequest,
} from "./index.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function fixture(
  projectRoot = "/work/project",
  version = "1.0.0",
  source = "---\nname: research\n---\n",
) {
  const sealedBytes = new TextEncoder().encode(`sealed-package-${version}`);
  const skillBytes = new TextEncoder().encode(source);
  const skill: InstallableSkill = {
    name: "research",
    logicalSkillId: "skill_01",
    logicalVersion: version,
    distributionId: "dist_01",
    shareId: "share_01",
    handoffId: "handoff_01",
    sealedPackageSha256: sha256(sealedBytes),
    signature: { algorithm: "ed25519", keyId: "owner-key", value: "signature" },
    license: { spdxExpression: "MIT", licenseFile: null, notices: [] },
    consent: {
      consentId: "consent_01",
      recipientPrincipalId: "recipient_01",
      recordedAt: "2026-07-21T00:00:00.000Z",
      action: "install_with_selftune",
      disclosureSha256: "d".repeat(64),
      termsAccepted: true,
      contributorSignals: "not_granted",
      contributorSignalRecipientOwnerId: null,
      contributorSignalAllowedFields: [],
      lifecycleReporting: "not_granted",
      lifecycleAllowedFields: [],
    },
    source: { kind: "remote_sealed", objectId: "object_01" },
    files: [
      {
        path: "SKILL.md",
        sha256: sha256(skillBytes),
        byteLength: skillBytes.byteLength,
        kind: "file",
      },
    ],
  };
  const request: LocalInstallRequest = {
    installBootstrapToken: "bootstrap",
    scope: "project",
    projectRoot,
    targetAgents: ["codex"],
    unmanagedPolicy: "cancel",
  };
  const targetPath = join(projectRoot, ".agents", "skills", "research");
  const planning: InstallerPlanningAuthorities = {
    authorization: makeInstallAuthorizationAuthority(() =>
      Effect.succeed({ subject: { kind: "standalone", skill } }),
    ),
    os: {
      observeEnvironment: () =>
        Effect.succeed({
          platform: "linux" as const,
          homeDirectory: "/home/user",
          configDirectory: null,
          selectedRoot: {
            requestedPath: projectRoot,
            canonicalPath: projectRoot,
            exists: true,
            writable: true,
            kind: "directory" as const,
            ancestors: [{ path: projectRoot, kind: "directory" as const }],
          },
          authorizedGlobalRoots: [],
        }),
      observePaths: () =>
        Effect.succeed({
          destinations: [
            {
              targetPath,
              kind: "missing" as const,
              writable: true,
              files: [],
              ancestors: [],
              nearestExistingParent: {
                requestedPath: join(projectRoot, ".agents", "skills"),
                canonicalPath: join(projectRoot, ".agents", "skills"),
                exists: true,
                writable: true,
                kind: "directory" as const,
                ancestors: [],
              },
            },
          ],
          localSources: [],
        }),
    },
    receipts: { readReceipts: () => Effect.succeed([]) },
    commitLock: {
      withExclusiveCommit: (commit) =>
        commit({ fenceId: "fence_01", assertValid: Effect.succeed(undefined) }),
    },
  };
  return { request, planning, sealedBytes, skillBytes, skill, targetPath };
}

function recoveryOperation(targetPath: string, operationId: string): DurableInstallOperation {
  return {
    operationId,
    kind: "remove",
    state: "planned",
    previewFingerprint: "e".repeat(64),
    fenceId: "fence_recovery",
    fenceGeneration: 7,
    recoveryToken: null,
    recoveryGeneration: 0,
    createdAt: "2026-07-21T06:00:00.000Z",
    updatedAt: "2026-07-21T06:00:00.000Z",
    receiptIntents: [],
    steps: [
      {
        sequence: 0,
        receiptId: `receipt_${operationId}`,
        mutation: "remove",
        state: "planned",
        targetPath,
        stagingPath: `${targetPath}.selftune-remove-stage-${operationId}-g7`,
        rollbackPath: `${targetPath}.selftune-remove-rollback-${operationId}-g7`,
        snapshotPath: `${targetPath}.selftune-remove-snapshot-${operationId}-g7`,
        retainRollbackAfterCommit: false,
        restoreBackupPath: null,
        strategy: "copy",
        sourcePath: null,
        expectedSealedPackageSha256: "f".repeat(64),
        expectedBefore: { kind: "directory", files: [] },
        operations: [],
      },
    ],
  };
}

describe("durable local install materializer", () => {
  test("installs a verified sealed package and commits its SQLite receipt inside the fence", async () => {
    const { request, planning, sealedBytes, skillBytes, targetPath } = fixture();
    const events: string[] = [];
    const materialization: InstallerMaterializationAuthorities = {
      now: () => "2026-07-21T01:00:00.000Z",
      packages: {
        load: () =>
          Effect.succeed({
            sealedBytes,
            files: [{ path: "SKILL.md", bytes: skillBytes }],
          }),
      },
      filesystem: {
        materialize: (input) => {
          events.push(`fs:${input.targetPath}`);
          return Effect.succeed({
            files: input.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              byteLength: file.byteLength,
              durableSnapshotRef: `${input.snapshotPath}/${file.path}`,
            })),
          });
        },
        rollback: () => Effect.succeed(undefined),
        cleanupAfterCommit: () => Effect.succeed(undefined),
        inspectOwned: () => Effect.die("not used"),
        removeOwned: () => Effect.die("not used"),
        restoreOwned: () => Effect.die("not used"),
      },
      receipts: {
        beginInstall: (input) => {
          events.push(`begin:${input.fenceId}`);
          return Effect.succeed(input.operation);
        },
        markStepStarted: (_operationId, sequence) => {
          events.push(`started:${sequence}`);
          return Effect.succeed(undefined);
        },
        markStepCompleted: (_operationId, sequence) => {
          events.push(`completed:${sequence}`);
          return Effect.succeed(undefined);
        },
        commitInstall: (input) => {
          events.push(`commit:${input.receipts[0]?.targetPath}`);
          return Effect.succeed(input.receipts);
        },
        failOperation: () => Effect.succeed(undefined),
        listRecoverableOperations: () => Effect.succeed([]),
        listCleanupOperations: () => Effect.succeed([]),
        renewRecoveryClaim: () => Effect.succeed(undefined),
        withRecoveryClaim: (_operationId, _recoveryToken, _recoveryGeneration, use) =>
          use(Effect.succeed(undefined)),
        markCleanupCompleted: () => Effect.succeed(undefined),
        markRolledBack: () => Effect.succeed(undefined),
        readReceipt: () => Effect.succeed(null),
        commitRemoval: () => Effect.succeed(undefined),
        commitRollback: () => Effect.succeed(undefined),
      },
    };

    const preview = await Effect.runPromise(planLocalInstall(request, planning));
    const receipts = await Effect.runPromise(
      installLocalSubject(request, preview.previewToken, planning, materialization),
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.targetPath).toBe(targetPath);
    expect(events).toEqual([
      "begin:fence_01",
      "started:0",
      `fs:${targetPath}`,
      "completed:0",
      `commit:${targetPath}`,
    ]);
  });

  test("atomically copies bytes and persists the sole authoritative receipt in SQLite", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "selftune-installer-"));
    const projectRoot = join(await realpath(temporaryRoot), "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    const { request, planning, sealedBytes, skillBytes, targetPath } = fixture(projectRoot);
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const planningWithSqlite: InstallerPlanningAuthorities = {
        ...planning,
        receipts: sqlite.planning,
      };
      const materialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T02:00:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes,
              files: [{ path: "SKILL.md", bytes: skillBytes }],
            }),
        },
        filesystem: makeNodeInstallerMaterializationFileSystem(),
        receipts: sqlite.durable,
      };
      const preview = await Effect.runPromise(planLocalInstall(request, planningWithSqlite));
      const receipts = await Effect.runPromise(
        installLocalSubject(request, preview.previewToken, planningWithSqlite, materialization),
      );

      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toBe(
        new TextDecoder().decode(skillBytes),
      );
      const persisted = await Effect.runPromise(sqlite.durable.readReceipt(receipts[0]!.receiptId));
      expect(persisted?.distributionId).toBe("dist_01");
      expect(persisted?.consent.recipientPrincipalId).toBe("recipient_01");
      expect(persisted?.files[0]?.sha256).toBe(sha256(skillBytes));

      const initialRollback = await Effect.runPromise(
        rollbackLocalInstall(receipts[0]!.receiptId, planning.commitLock, materialization),
      );
      expect(initialRollback.status).toBe("rolled_back");
      expect(await Bun.file(join(targetPath, "SKILL.md")).exists()).toBe(false);

      const reinstallPreview = await Effect.runPromise(
        planLocalInstall(request, planningWithSqlite),
      );
      const reinstalled = await Effect.runPromise(
        installLocalSubject(
          request,
          reinstallPreview.previewToken,
          planningWithSqlite,
          materialization,
        ),
      );
      const activeReceiptId = reinstalled[0]!.receiptId;

      await writeFile(join(targetPath, "SKILL.md"), "local drift");
      const drifted = await Effect.runPromise(
        removeLocalInstall(activeReceiptId, planning.commitLock, materialization),
      );
      expect(drifted).toEqual({
        receiptId: activeReceiptId,
        status: "drifted",
        driftedPaths: ["SKILL.md"],
      });
      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toBe("local drift");

      await writeFile(join(targetPath, "SKILL.md"), skillBytes);
      const removed = await Effect.runPromise(
        removeLocalInstall(activeReceiptId, planning.commitLock, materialization),
      );
      expect(removed.status).toBe("removed");
      expect(await Bun.file(join(targetPath, "SKILL.md")).exists()).toBe(false);
      expect(
        db
          .query(
            "SELECT state FROM skill_install_operations WHERE kind = 'remove' ORDER BY created_at DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ state: "committed" });
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("returns the active receipt for exact same-hash retries without filesystem or lineage writes", async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "selftune-installer-noop-")));
    const projectRoot = join(temporaryRoot, "project");
    const registryRoot = join(projectRoot, ".agents", "skills");
    await mkdir(registryRoot, { recursive: true });
    const current = fixture(projectRoot);
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const baseFilesystem = makeNodeInstallerMaterializationFileSystem();
      let materializeCalls = 0;
      const materialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T02:30:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes: current.sealedBytes,
              files: [{ path: "SKILL.md", bytes: current.skillBytes }],
            }),
        },
        filesystem: {
          ...baseFilesystem,
          materialize: (input) => {
            materializeCalls += 1;
            return baseFilesystem.materialize(input);
          },
        },
        receipts: sqlite.durable,
      };
      const initialPlanning = { ...current.planning, receipts: sqlite.planning };
      const initialPreview = await Effect.runPromise(
        planLocalInstall(current.request, initialPlanning),
      );
      const initial = await Effect.runPromise(
        installLocalSubject(
          current.request,
          initialPreview.previewToken,
          initialPlanning,
          materialization,
        ),
      );
      expect(materializeCalls).toBe(1);

      const noOpPlanning: InstallerPlanningAuthorities = {
        ...initialPlanning,
        os: {
          ...initialPlanning.os,
          observePaths: () =>
            Effect.succeed({
              destinations: [
                {
                  targetPath: current.targetPath,
                  kind: "directory" as const,
                  writable: true,
                  files: [
                    {
                      path: "SKILL.md",
                      sha256: sha256(current.skillBytes),
                      kind: "file" as const,
                    },
                  ],
                  ancestors: [],
                  nearestExistingParent: {
                    requestedPath: registryRoot,
                    canonicalPath: registryRoot,
                    exists: true,
                    writable: true,
                    kind: "directory" as const,
                    ancestors: [],
                  },
                },
              ],
              localSources: [],
            }),
        },
      };
      const noOpPreview = await Effect.runPromise(planLocalInstall(current.request, noOpPlanning));
      expect(noOpPreview.receipts[0]?.noOp).toBe(true);
      const firstRetry = await Effect.runPromise(
        installLocalSubject(
          current.request,
          noOpPreview.previewToken,
          noOpPlanning,
          materialization,
        ),
      );
      const secondRetry = await Effect.runPromise(
        installLocalSubject(
          current.request,
          noOpPreview.previewToken,
          noOpPlanning,
          materialization,
        ),
      );

      expect(firstRetry[0]?.receiptId).toBe(initial[0]?.receiptId);
      expect(secondRetry[0]?.receiptId).toBe(initial[0]?.receiptId);
      expect(materializeCalls).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM skill_install_receipts").get()).toEqual({
        count: 1,
      });
      expect(db.query("SELECT COUNT(*) AS count FROM skill_install_operations").get()).toEqual({
        count: 1,
      });
      expect(
        db.query("SELECT previous_receipt_id FROM skill_install_receipts LIMIT 1").get(),
      ).toEqual({ previous_receipt_id: null });
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted removal from the durable SQLite journal", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "selftune-installer-recovery-")),
    );
    const targetPath = join(temporaryRoot, "project", ".agents", "skills", "research");
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(targetPath, "SKILL.md"), "owned");
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const operationId = "remove_v1_interrupted";
      const rollbackPath = `${targetPath}.selftune-remove-rollback-${operationId}-g0`;
      const operation: DurableInstallOperation = {
        operationId,
        kind: "remove",
        state: "planned",
        previewFingerprint: "a".repeat(64),
        fenceId: "fence_recovery",
        fenceGeneration: 0,
        recoveryToken: null,
        recoveryGeneration: 0,
        createdAt: "2026-07-21T03:00:00.000Z",
        updatedAt: "2026-07-21T03:00:00.000Z",
        receiptIntents: [],
        steps: [
          {
            sequence: 0,
            receiptId: "receipt_interrupted",
            mutation: "remove",
            state: "planned",
            targetPath,
            stagingPath: `${targetPath}.selftune-remove-stage-${operationId}-g0`,
            rollbackPath,
            snapshotPath: `${targetPath}.selftune-remove-snapshot-${operationId}-g0`,
            retainRollbackAfterCommit: false,
            restoreBackupPath: null,
            strategy: "copy",
            sourcePath: null,
            expectedSealedPackageSha256: "b".repeat(64),
            expectedBefore: { kind: "directory", files: [] },
            operations: [],
          },
        ],
      };
      await Effect.runPromise(
        sqlite.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      await Effect.runPromise(
        sqlite.durable.markStepStarted(operationId, 0, "2026-07-21T03:00:01.000Z"),
      );
      await rename(targetPath, rollbackPath);

      const recovered = await Effect.runPromise(
        recoverLocalInstallOperations(
          {
            withExclusiveCommit: (commit) =>
              commit({ fenceId: "recovery", assertValid: Effect.succeed(undefined) }),
          },
          {
            now: () => "2026-07-21T03:00:02.000Z",
            filesystem: makeNodeInstallerMaterializationFileSystem(),
            receipts: sqlite.durable,
          },
        ),
      );

      expect(recovered).toEqual([operationId]);
      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toBe("owned");
      expect(
        db
          .query("SELECT state FROM skill_install_operations WHERE operation_id = ?")
          .get(operationId),
      ).toEqual({ state: "rolled_back" });

      const cleanupOperation: DurableInstallOperation = {
        ...operation,
        operationId: "install_v1_cleanup_pending",
        steps: operation.steps.map((step) => ({
          ...step,
          stagingPath: `${targetPath}.selftune-remove-stage-install_v1_cleanup_pending-g0`,
          rollbackPath: `${targetPath}.selftune-remove-rollback-install_v1_cleanup_pending-g0`,
          snapshotPath: `${targetPath}.selftune-remove-snapshot-install_v1_cleanup_pending-g0`,
        })),
      };
      await Effect.runPromise(
        sqlite.durable.beginInstall({
          operation: cleanupOperation,
          fenceId: cleanupOperation.fenceId,
        }),
      );
      await Effect.runPromise(
        sqlite.durable.markStepStarted(cleanupOperation.operationId, 0, cleanupOperation.updatedAt),
      );
      await Effect.runPromise(
        sqlite.durable.markStepCompleted(
          cleanupOperation.operationId,
          0,
          cleanupOperation.updatedAt,
        ),
      );
      db.query(
        "UPDATE skill_install_operations SET state = 'cleanup_pending' WHERE operation_id = ?",
      ).run(cleanupOperation.operationId);
      await mkdir(cleanupOperation.steps[0]!.rollbackPath);
      await writeFile(join(cleanupOperation.steps[0]!.rollbackPath, "old"), "old");

      const cleanupRecovered = await Effect.runPromise(
        recoverLocalInstallOperations(
          {
            withExclusiveCommit: (commit) =>
              commit({ fenceId: "recovery", assertValid: Effect.succeed(undefined) }),
          },
          {
            now: () => "2026-07-21T03:00:03.000Z",
            filesystem: makeNodeInstallerMaterializationFileSystem(),
            receipts: sqlite.durable,
          },
        ),
      );
      expect(cleanupRecovered).toEqual([cleanupOperation.operationId]);
      expect(await Bun.file(join(cleanupOperation.steps[0]!.rollbackPath, "old")).exists()).toBe(
        false,
      );
      expect(
        db
          .query("SELECT state FROM skill_install_operations WHERE operation_id = ?")
          .get(cleanupOperation.operationId),
      ).toEqual({ state: "committed" });
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects mismatched sealed bytes before any destination mutation", async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "selftune-installer-hash-")));
    const projectRoot = join(temporaryRoot, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    const current = fixture(projectRoot);
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const planning = { ...current.planning, receipts: sqlite.planning };
      const materialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T04:30:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes: new TextEncoder().encode("tampered"),
              files: [{ path: "SKILL.md", bytes: current.skillBytes }],
            }),
        },
        filesystem: makeNodeInstallerMaterializationFileSystem(),
        receipts: sqlite.durable,
      };
      const preview = await Effect.runPromise(planLocalInstall(current.request, planning));
      const error = await Effect.runPromise(
        Effect.flip(
          installLocalSubject(current.request, preview.previewToken, planning, materialization),
        ),
      );
      expect(error.code).toBe("SEALED_IDENTITY_MISMATCH");
      expect(await Bun.file(join(current.targetPath, "SKILL.md")).exists()).toBe(false);
      expect(db.query("SELECT state FROM skill_install_operations LIMIT 1").get()).toEqual({
        state: "rolled_back",
      });
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rolls back every prior Skill Set component when a later component fails", async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "selftune-installer-set-")));
    const projectRoot = join(temporaryRoot, "project");
    const registryRoot = join(projectRoot, ".agents", "skills");
    await mkdir(registryRoot, { recursive: true });
    const current = fixture(projectRoot);
    const secondBytes = new TextEncoder().encode("second skill");
    const secondSealed = new TextEncoder().encode("sealed-second");
    const secondSkill: InstallableSkill = {
      ...current.skill,
      name: "summarize",
      logicalSkillId: "skill_02",
      distributionId: "dist_02",
      shareId: "share_02",
      handoffId: "handoff_02",
      sealedPackageSha256: sha256(secondSealed),
      source: { kind: "remote_sealed", objectId: "object_02" },
      files: [
        {
          path: "SKILL.md",
          sha256: sha256(secondBytes),
          byteLength: secondBytes.byteLength,
          kind: "file",
        },
      ],
    };
    const subject = {
      kind: "skill_set" as const,
      skillSetId: "set_01",
      logicalVersion: "1.0.0",
      sealedPackageSha256: "9".repeat(64),
      skills: [current.skill, secondSkill],
    };
    const missingDestination = (targetPath: string) => ({
      targetPath,
      kind: "missing" as const,
      writable: true,
      files: [],
      ancestors: [],
      nearestExistingParent: {
        requestedPath: registryRoot,
        canonicalPath: registryRoot,
        exists: true,
        writable: true,
        kind: "directory" as const,
        ancestors: [],
      },
    });
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const planning: InstallerPlanningAuthorities = {
        ...current.planning,
        authorization: makeInstallAuthorizationAuthority(() => Effect.succeed({ subject })),
        receipts: sqlite.planning,
        os: {
          ...current.planning.os,
          observePaths: () =>
            Effect.succeed({
              destinations: [
                missingDestination(join(registryRoot, "research")),
                missingDestination(join(registryRoot, "summarize")),
              ],
              localSources: [],
            }),
        },
      };
      const materialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T04:45:00.000Z",
        packages: {
          load: (skill) =>
            Effect.succeed(
              skill.name === "research"
                ? {
                    sealedBytes: current.sealedBytes,
                    files: [{ path: "SKILL.md", bytes: current.skillBytes }],
                  }
                : {
                    sealedBytes: new TextEncoder().encode("tampered second envelope"),
                    files: [{ path: "SKILL.md", bytes: secondBytes }],
                  },
            ),
        },
        filesystem: makeNodeInstallerMaterializationFileSystem(),
        receipts: sqlite.durable,
      };
      const preview = await Effect.runPromise(planLocalInstall(current.request, planning));
      const error = await Effect.runPromise(
        Effect.flip(
          installLocalSubject(current.request, preview.previewToken, planning, materialization),
        ),
      );
      expect(error.code).toBe("SEALED_IDENTITY_MISMATCH");
      expect(await Bun.file(join(registryRoot, "research", "SKILL.md")).exists()).toBe(false);
      expect(await Bun.file(join(registryRoot, "summarize", "SKILL.md")).exists()).toBe(false);
      expect(db.query("SELECT COUNT(*) AS count FROM skill_install_receipts").get()).toEqual({
        count: 0,
      });
      expect(db.query("SELECT state FROM skill_install_operations LIMIT 1").get()).toEqual({
        state: "rolled_back",
      });
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("updates by an exact new hash, records lineage, and rolls back from durable snapshots", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "selftune-installer-update-")),
    );
    const projectRoot = join(temporaryRoot, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    const first = fixture(projectRoot, "1.0.0", "first version");
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const fs = makeNodeInstallerMaterializationFileSystem();
      const firstPlanning = { ...first.planning, receipts: sqlite.planning };
      const firstMaterialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T05:00:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes: first.sealedBytes,
              files: [{ path: "SKILL.md", bytes: first.skillBytes }],
            }),
        },
        filesystem: fs,
        receipts: sqlite.durable,
      };
      const firstPreview = await Effect.runPromise(planLocalInstall(first.request, firstPlanning));
      const firstReceipts = await Effect.runPromise(
        installLocalSubject(
          first.request,
          firstPreview.previewToken,
          firstPlanning,
          firstMaterialization,
        ),
      );

      const second = fixture(projectRoot, "2.0.0", "second version");
      const secondPlanning: InstallerPlanningAuthorities = {
        ...second.planning,
        receipts: sqlite.planning,
        os: {
          ...second.planning.os,
          observePaths: () =>
            Effect.succeed({
              destinations: [
                {
                  targetPath: second.targetPath,
                  kind: "directory" as const,
                  writable: true,
                  files: [
                    {
                      path: "SKILL.md",
                      sha256: sha256(first.skillBytes),
                      kind: "file" as const,
                    },
                  ],
                  ancestors: [],
                  nearestExistingParent: {
                    requestedPath: join(projectRoot, ".agents", "skills"),
                    canonicalPath: join(projectRoot, ".agents", "skills"),
                    exists: true,
                    writable: true,
                    kind: "directory" as const,
                    ancestors: [],
                  },
                },
              ],
              localSources: [],
            }),
        },
      };
      const secondMaterialization: InstallerMaterializationAuthorities = {
        ...firstMaterialization,
        now: () => "2026-07-21T05:01:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes: second.sealedBytes,
              files: [{ path: "SKILL.md", bytes: second.skillBytes }],
            }),
        },
      };
      const secondPreview = await Effect.runPromise(
        planLocalInstall(second.request, secondPlanning),
      );
      const secondReceipts = await Effect.runPromise(
        installLocalSubject(
          second.request,
          secondPreview.previewToken,
          secondPlanning,
          secondMaterialization,
        ),
      );

      expect(await readFile(join(second.targetPath, "SKILL.md"), "utf8")).toBe("second version");
      expect(secondReceipts[0]?.previousReceiptId).toBe(firstReceipts[0]?.receiptId);
      expect(
        (await Effect.runPromise(sqlite.durable.readReceipt(firstReceipts[0]!.receiptId)))?.state,
      ).toBe("superseded");

      const rolledBack = await Effect.runPromise(
        rollbackLocalInstall(
          secondReceipts[0]!.receiptId,
          second.planning.commitLock,
          secondMaterialization,
        ),
      );
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readFile(join(second.targetPath, "SKILL.md"), "utf8")).toBe("first version");
      expect(
        (await Effect.runPromise(sqlite.durable.readReceipt(firstReceipts[0]!.receiptId)))?.state,
      ).toBe("active");
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("restores an unmanaged destination from its required backup on rollback", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "selftune-installer-backup-")),
    );
    const projectRoot = join(temporaryRoot, "project");
    const registryRoot = join(projectRoot, ".agents", "skills");
    const current = fixture(projectRoot);
    await mkdir(current.targetPath, { recursive: true });
    const legacyBytes = new TextEncoder().encode("legacy unmanaged content");
    await writeFile(join(current.targetPath, "legacy.txt"), legacyBytes);
    const backupPath = `${current.targetPath}.selftune-backup-${current.skill.sealedPackageSha256.slice(0, 12)}`;
    const db = openDb(join(temporaryRoot, "selftune.db"));
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const request = { ...current.request, unmanagedPolicy: "replace_with_backup" as const };
      const planning: InstallerPlanningAuthorities = {
        ...current.planning,
        receipts: sqlite.planning,
        os: {
          ...current.planning.os,
          observePaths: () =>
            Effect.succeed({
              destinations: [
                {
                  targetPath: current.targetPath,
                  kind: "directory" as const,
                  writable: true,
                  files: [
                    {
                      path: "legacy.txt",
                      sha256: sha256(legacyBytes),
                      kind: "file" as const,
                    },
                  ],
                  ancestors: [],
                  nearestExistingParent: {
                    requestedPath: registryRoot,
                    canonicalPath: registryRoot,
                    exists: true,
                    writable: true,
                    kind: "directory" as const,
                    ancestors: [],
                  },
                },
                {
                  targetPath: backupPath,
                  kind: "missing" as const,
                  writable: true,
                  files: [],
                  ancestors: [],
                  nearestExistingParent: {
                    requestedPath: registryRoot,
                    canonicalPath: registryRoot,
                    exists: true,
                    writable: true,
                    kind: "directory" as const,
                    ancestors: [],
                  },
                },
              ],
              localSources: [],
            }),
        },
      };
      const materialization: InstallerMaterializationAuthorities = {
        now: () => "2026-07-21T05:30:00.000Z",
        packages: {
          load: () =>
            Effect.succeed({
              sealedBytes: current.sealedBytes,
              files: [{ path: "SKILL.md", bytes: current.skillBytes }],
            }),
        },
        filesystem: makeNodeInstallerMaterializationFileSystem(),
        receipts: sqlite.durable,
      };
      const preview = await Effect.runPromise(planLocalInstall(request, planning));
      const receipts = await Effect.runPromise(
        installLocalSubject(request, preview.previewToken, planning, materialization),
      );
      expect(await readFile(join(current.targetPath, "SKILL.md"), "utf8")).toBe(
        new TextDecoder().decode(current.skillBytes),
      );
      expect(await readFile(join(backupPath, "legacy.txt"), "utf8")).toBe(
        "legacy unmanaged content",
      );

      const rolledBack = await Effect.runPromise(
        rollbackLocalInstall(receipts[0]!.receiptId, planning.commitLock, materialization),
      );
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readFile(join(current.targetPath, "legacy.txt"), "utf8")).toBe(
        "legacy unmanaged content",
      );
      expect(await Bun.file(join(current.targetPath, "SKILL.md")).exists()).toBe(false);
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("fails visibly when the SQLite operation journal is corrupt", async () => {
    const db = openDb(":memory:");
    try {
      db.query(
        `INSERT INTO skill_install_operations
          (operation_id, kind, state, preview_fingerprint, fence_id, fence_generation,
           request_json, request_sha256, created_at, updated_at)
         VALUES ('corrupt', 'install', 'planned', ?, 'fence', 0, '{bad json', ?, ?, ?)`,
      ).run(
        "c".repeat(64),
        sha256("{bad json"),
        "2026-07-21T04:00:00.000Z",
        "2026-07-21T04:00:00.000Z",
      );
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const error = await Effect.runPromise(
        Effect.flip(sqlite.durable.listRecoverableOperations()),
      );
      expect(error.code).toBe("INSTALL_JOURNAL_CORRUPT");
    } finally {
      db.close();
    }
  });

  test("accepts reordered JSON keys without rewriting the immutable request", async () => {
    const db = openDb(":memory:");
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const operation = recoveryOperation("/work/project/.agents/skills/research", "key-order");
      await Effect.runPromise(
        sqlite.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      db.query("UPDATE skill_install_operation_steps SET expected_before_json = ?").run(
        '{"files":[],"kind":"directory"}',
      );
      const recovered = await Effect.runPromise(sqlite.durable.listRecoverableOperations());
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.steps[0]?.expectedBefore).toEqual({ kind: "directory", files: [] });
      const stored = db
        .query<{ request_json: string }, []>("SELECT request_json FROM skill_install_operations")
        .get();
      expect(stored?.request_json).toBe(JSON.stringify(operation));
    } finally {
      db.close();
    }
  });

  test("rejects malformed typed journal fields even when their raw digest matches", async () => {
    const db = openDb(":memory:");
    try {
      const sqlite = makeSqliteInstallerReceiptAuthority(db);
      const operation = recoveryOperation(
        "/work/project/.agents/skills/research",
        "invalid-boolean",
      );
      await Effect.runPromise(
        sqlite.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      const encoded = JSON.stringify({
        ...operation,
        steps: operation.steps.map((step) => ({ ...step, retainRollbackAfterCommit: "false" })),
      });
      db.query("UPDATE skill_install_operations SET request_json = ?, request_sha256 = ?").run(
        encoded,
        sha256(encoded),
      );
      const error = await Effect.runPromise(
        Effect.flip(sqlite.durable.listRecoverableOperations()),
      );
      expect(error.code).toBe("INSTALL_JOURNAL_CORRUPT");
      expect(
        db.query<{ state: string }, []>("SELECT state FROM skill_install_operations").get()?.state,
      ).toBe(operation.state);
    } finally {
      db.close();
    }
  });

  test("rejects every mutation-bearing normalized journal mismatch before filesystem recovery", async () => {
    const corruptions: ReadonlyArray<{
      readonly label: string;
      readonly sql: string;
      readonly value: string | number | null;
    }> = [
      {
        label: "operation kind",
        sql: "UPDATE skill_install_operations SET kind = ?",
        value: "install",
      },
      {
        label: "preview fingerprint",
        sql: "UPDATE skill_install_operations SET preview_fingerprint = ?",
        value: "a".repeat(64),
      },
      {
        label: "fence id",
        sql: "UPDATE skill_install_operations SET fence_id = ?",
        value: "other",
      },
      {
        label: "fence generation",
        sql: "UPDATE skill_install_operations SET fence_generation = ?",
        value: 8,
      },
      {
        label: "request digest",
        sql: "UPDATE skill_install_operations SET request_sha256 = ?",
        value: "0".repeat(64),
      },
      {
        label: "request payload",
        sql: "UPDATE skill_install_operations SET request_json = ?",
        value: "{}",
      },
      {
        label: "created at",
        sql: "UPDATE skill_install_operations SET created_at = ?",
        value: "2026-07-21T06:00:01.000Z",
      },
      {
        label: "receipt id",
        sql: "UPDATE skill_install_operation_steps SET receipt_id = ?",
        value: "other",
      },
      {
        label: "mutation kind",
        sql: "UPDATE skill_install_operation_steps SET kind = ?",
        value: "restore",
      },
      {
        label: "target path",
        sql: "UPDATE skill_install_operation_steps SET target_path = ?",
        value: "/other",
      },
      {
        label: "staging path",
        sql: "UPDATE skill_install_operation_steps SET staging_path = ?",
        value: "/other-stage",
      },
      {
        label: "rollback path",
        sql: "UPDATE skill_install_operation_steps SET rollback_path = ?",
        value: "/other-rollback",
      },
      {
        label: "snapshot path",
        sql: "UPDATE skill_install_operation_steps SET snapshot_path = ?",
        value: "/other-snapshot",
      },
      {
        label: "expected hash",
        sql: "UPDATE skill_install_operation_steps SET expected_sha256 = ?",
        value: "a".repeat(64),
      },
      {
        label: "retain rollback",
        sql: "UPDATE skill_install_operation_steps SET retain_rollback_after_commit = ?",
        value: 1,
      },
      {
        label: "restore backup",
        sql: "UPDATE skill_install_operation_steps SET restore_backup_path = ?",
        value: "/other-backup",
      },
      {
        label: "strategy",
        sql: "UPDATE skill_install_operation_steps SET strategy = ?",
        value: "symlink",
      },
      {
        label: "source path",
        sql: "UPDATE skill_install_operation_steps SET source_path = ?",
        value: "/other-source",
      },
      {
        label: "operations",
        sql: "UPDATE skill_install_operation_steps SET operations_json = ?",
        value: "[{}]",
      },
      {
        label: "expected-before tree",
        sql: "UPDATE skill_install_operation_steps SET expected_before_json = ?",
        value: '{"kind":"missing","files":[]}',
      },
    ];
    for (const corruption of corruptions) {
      const db = openDb(":memory:");
      let filesystemCalls = 0;
      try {
        const sqlite = makeSqliteInstallerReceiptAuthority(db);
        const operation = recoveryOperation(
          "/work/project/.agents/skills/research",
          "remove_v1_corrupt",
        );
        await Effect.runPromise(
          sqlite.durable.beginInstall({ operation, fenceId: operation.fenceId }),
        );
        await Effect.runPromise(
          sqlite.durable.markStepStarted(operation.operationId, 0, operation.updatedAt),
        );
        db.query(corruption.sql).run(corruption.value);
        const touched = () => {
          filesystemCalls += 1;
          return Effect.succeed(undefined);
        };
        const error = await Effect.runPromise(
          Effect.flip(
            recoverLocalInstallOperations(
              {
                withExclusiveCommit: (commit) =>
                  commit({ fenceId: "recovery", assertValid: Effect.succeed(undefined) }),
              },
              {
                now: () => "2026-07-21T06:00:01.000Z",
                filesystem: {
                  materialize: () => Effect.die("not used"),
                  rollback: touched,
                  cleanupAfterCommit: touched,
                  inspectOwned: () => Effect.die("not used"),
                  removeOwned: () => Effect.die("not used"),
                  restoreOwned: () => Effect.die("not used"),
                },
                receipts: sqlite.durable,
              },
            ),
          ),
        );
        expect(error.code, corruption.label).toBe("INSTALL_JOURNAL_CORRUPT");
        expect(filesystemCalls, corruption.label).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  test("renews recovery leases and fences an expired claimant before journal mutation", async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "selftune-recovery-lease-")));
    const databasePath = join(temporaryRoot, "selftune.db");
    const firstDb = openDb(databasePath);
    const secondDb = openDb(databasePath);
    let timestamp = 0;
    try {
      const options = { now: () => timestamp, recoveryLeaseMs: 100 };
      const first = makeSqliteInstallerReceiptAuthority(firstDb, options);
      const second = makeSqliteInstallerReceiptAuthority(secondDb, options);
      const operation = recoveryOperation(
        join(temporaryRoot, "project", ".agents", "skills", "research"),
        "remove_v1_lease",
      );
      await Effect.runPromise(
        first.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      await Effect.runPromise(
        first.durable.markStepStarted(operation.operationId, 0, operation.updatedAt),
      );
      const firstClaim = (await Effect.runPromise(first.durable.listRecoverableOperations()))[0]!;
      expect(firstClaim.recoveryToken).not.toBeNull();
      expect(firstClaim.recoveryGeneration).toBe(1);

      timestamp = 50;
      await Effect.runPromise(
        first.durable.renewRecoveryClaim(
          operation.operationId,
          firstClaim.recoveryToken!,
          firstClaim.recoveryGeneration,
          "ignored",
        ),
      );
      timestamp = 120;
      expect(await Effect.runPromise(second.durable.listRecoverableOperations())).toEqual([]);

      timestamp = 151;
      const expiredError = await Effect.runPromise(
        Effect.flip(
          first.durable.renewRecoveryClaim(
            operation.operationId,
            firstClaim.recoveryToken!,
            firstClaim.recoveryGeneration,
            "ignored",
          ),
        ),
      );
      expect(expiredError.code).toBe("INSTALL_RECOVERY_FENCE_LOST");
      const secondClaim = (await Effect.runPromise(second.durable.listRecoverableOperations()))[0]!;
      expect(secondClaim.recoveryToken).not.toBe(firstClaim.recoveryToken);
      expect(secondClaim.recoveryGeneration).toBe(2);
      const oldCompletionError = await Effect.runPromise(
        Effect.flip(
          first.durable.markRolledBack(
            operation.operationId,
            firstClaim.recoveryToken,
            firstClaim.recoveryGeneration,
            "2026-07-21T06:00:02.000Z",
          ),
        ),
      );
      expect(oldCompletionError.code).toBe("INSTALL_RECOVERY_FENCE_LOST");
      expect(
        firstDb
          .query("SELECT state FROM skill_install_operation_steps WHERE operation_id = ?")
          .get(operation.operationId),
      ).toEqual({ state: "started" });
      await Effect.runPromise(
        second.durable.markRolledBack(
          operation.operationId,
          secondClaim.recoveryToken,
          secondClaim.recoveryGeneration,
          "2026-07-21T06:00:03.000Z",
        ),
      );
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps a recovery claim alive independently during a long filesystem await", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "selftune-recovery-heartbeat-")),
    );
    const databasePath = join(temporaryRoot, "selftune.db");
    const firstDb = openDb(databasePath);
    const secondDb = openDb(databasePath);
    try {
      const options = { recoveryLeaseMs: 120, recoveryHeartbeatMs: 25 };
      const first = makeSqliteInstallerReceiptAuthority(firstDb, options);
      const second = makeSqliteInstallerReceiptAuthority(secondDb, options);
      const operation = recoveryOperation(
        join(temporaryRoot, "project", ".agents", "skills", "research"),
        "remove_v1_heartbeat",
      );
      await Effect.runPromise(
        first.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      await Effect.runPromise(
        first.durable.markStepStarted(operation.operationId, 0, operation.updatedAt),
      );
      const claim = (await Effect.runPromise(first.durable.listRecoverableOperations()))[0]!;
      const longRecovery = Effect.runPromise(
        first.durable.withRecoveryClaim(
          operation.operationId,
          claim.recoveryToken!,
          claim.recoveryGeneration,
          () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 275))),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await Effect.runPromise(second.durable.listRecoverableOperations())).toEqual([]);
      await longRecovery;
      await Effect.runPromise(
        first.durable.markRolledBack(
          operation.operationId,
          claim.recoveryToken,
          claim.recoveryGeneration,
          "2026-07-21T06:00:04.000Z",
        ),
      );
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("leases cleanup-pending work to only one SQLite claimant", async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "selftune-cleanup-lease-")));
    const databasePath = join(temporaryRoot, "selftune.db");
    const firstDb = openDb(databasePath);
    const secondDb = openDb(databasePath);
    try {
      const first = makeSqliteInstallerReceiptAuthority(firstDb);
      const second = makeSqliteInstallerReceiptAuthority(secondDb);
      const operation = recoveryOperation(
        join(temporaryRoot, "project", ".agents", "skills", "research"),
        "remove_v1_cleanup_claim",
      );
      await Effect.runPromise(
        first.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      firstDb
        .query(
          "UPDATE skill_install_operations SET state = 'cleanup_pending' WHERE operation_id = ?",
        )
        .run(operation.operationId);
      const claims = await Promise.all([
        Effect.runPromise(first.durable.listCleanupOperations()),
        Effect.runPromise(second.durable.listCleanupOperations()),
      ]);
      expect(claims.map((claim) => claim.length).toSorted()).toEqual([0, 1]);
      expect(claims.flat()[0]?.recoveryToken).not.toBeNull();
      expect(claims.flat()[0]?.recoveryGeneration).toBe(1);
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("allows only one SQLite recovery claimant across independent connections", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "selftune-installer-claim-")),
    );
    const databasePath = join(temporaryRoot, "selftune.db");
    const firstDb = openDb(databasePath);
    const secondDb = openDb(databasePath);
    try {
      const first = makeSqliteInstallerReceiptAuthority(firstDb);
      const second = makeSqliteInstallerReceiptAuthority(secondDb);
      const targetPath = join(temporaryRoot, "project", ".agents", "skills", "claim");
      const operation: DurableInstallOperation = {
        operationId: "remove_v1_claim",
        kind: "remove",
        state: "planned",
        previewFingerprint: "e".repeat(64),
        fenceId: "fence_claim",
        fenceGeneration: 0,
        recoveryToken: null,
        recoveryGeneration: 0,
        createdAt: "2026-07-21T06:00:00.000Z",
        updatedAt: "2026-07-21T06:00:00.000Z",
        receiptIntents: [],
        steps: [
          {
            sequence: 0,
            receiptId: "receipt_claim",
            mutation: "remove",
            state: "planned",
            targetPath,
            stagingPath: `${targetPath}.selftune-remove-stage-remove_v1_claim-g0`,
            rollbackPath: `${targetPath}.selftune-remove-rollback-remove_v1_claim-g0`,
            snapshotPath: `${targetPath}.selftune-remove-snapshot-remove_v1_claim-g0`,
            retainRollbackAfterCommit: false,
            restoreBackupPath: null,
            strategy: "copy",
            sourcePath: null,
            expectedSealedPackageSha256: "f".repeat(64),
            expectedBefore: { kind: "directory", files: [] },
            operations: [],
          },
        ],
      };
      await Effect.runPromise(
        first.durable.beginInstall({ operation, fenceId: operation.fenceId }),
      );
      await Effect.runPromise(
        first.durable.markStepStarted(operation.operationId, 0, operation.updatedAt),
      );
      const secondOperation: DurableInstallOperation = {
        ...operation,
        operationId: "remove_v1_claim_second_component",
        steps: operation.steps.map((step) => ({
          ...step,
          receiptId: "receipt_claim_second_component",
          targetPath: `${targetPath}-second`,
          stagingPath: `${targetPath}-second.selftune-remove-stage-remove_v1_claim_second_component-g0`,
          rollbackPath: `${targetPath}-second.selftune-remove-rollback-remove_v1_claim_second_component-g0`,
          snapshotPath: `${targetPath}-second.selftune-remove-snapshot-remove_v1_claim_second_component-g0`,
        })),
      };
      await Effect.runPromise(
        second.durable.beginInstall({
          operation: secondOperation,
          fenceId: secondOperation.fenceId,
        }),
      );
      await Effect.runPromise(
        second.durable.markStepStarted(secondOperation.operationId, 0, secondOperation.updatedAt),
      );

      const claims = await Promise.all([
        Effect.runPromise(first.durable.listRecoverableOperations()),
        Effect.runPromise(second.durable.listRecoverableOperations()),
      ]);
      expect(claims.map((claim) => claim.length).toSorted()).toEqual([0, 2]);
      const claimedOperations = claims.flat();
      for (const claimed of claimedOperations) {
        expect(claimed.recoveryToken).not.toBeNull();
        expect(claimed.recoveryGeneration).toBe(1);
      }
      await Promise.all(
        claimedOperations.map((claimed) =>
          Effect.runPromise(
            first.durable.markRolledBack(
              claimed.operationId,
              claimed.recoveryToken,
              claimed.recoveryGeneration,
              "2026-07-21T06:00:01.000Z",
            ),
          ),
        ),
      );
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
