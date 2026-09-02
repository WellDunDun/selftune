import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
  type HostedSkillSetAssignment,
  type HostedSkillSetInstallationReceiptRequest,
} from "@selftune/control-plane";
import { openDb } from "@selftune/local-store";

import {
  makeNodeInstallerMaterializationFileSystem,
  makeSqliteInstallerExclusiveCommitLock,
  makeSqliteInstallerReceiptAuthority,
  InstallerMaterializationError,
  type InstallerMaterializationFileSystem,
} from "./installer/index.js";
import {
  makeNodeInstallerOsObservationAuthority,
  makeTeamSkillSetAssignmentRuntime,
} from "./team-assignment.js";

async function fixture(
  options: {
    readonly multi?: boolean;
    readonly filesystem?: InstallerMaterializationFileSystem;
    readonly afterInstallerCommit?: () => Promise<void> | void;
    readonly afterRollbackCommit?: () => Promise<void> | void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "selftune-team-assignment-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const homeRoot = join(root, "home");
  await Promise.all([
    mkdir(join(projectRoot, ".agents", "skills"), { recursive: true }),
    ...(options.multi ? [mkdir(join(projectRoot, ".claude", "skills"), { recursive: true })] : []),
    mkdir(configRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
  ]);
  const componentInputs = [
    {
      ordinal: 0,
      logicalSkillId: "review",
      revision: "1".repeat(64),
      sourceObject: "2".repeat(64),
      bytes: new TextEncoder().encode("---\nname: review\n---\n# Review\n"),
    },
    ...(options.multi
      ? [
          {
            ordinal: 1,
            logicalSkillId: "tdd",
            revision: "3".repeat(64),
            sourceObject: "4".repeat(64),
            bytes: new TextEncoder().encode("---\nname: tdd\n---\n# TDD\n"),
          },
        ]
      : []),
  ];
  const sealedPackages = await Promise.all(
    componentInputs.map((component) =>
      Effect.runPromise(
        encodePortablePackageBundle({
          files: [{ path: "SKILL.md", content: component.bytes }],
        }),
      ),
    ),
  );
  const harnesses = options.multi ? (["claude_code", "codex"] as const) : (["codex"] as const);
  const source = await Effect.runPromise(
    encodeCanonicalSkillSetSourceManifest({
      skillSetId: "engineering",
      name: "Engineering",
      description: "Pinned engineering workflow",
      harnesses,
      components: componentInputs.map((component) => ({
        ordinal: component.ordinal,
        logicalSkillId: component.logicalSkillId,
        sourceRevisionSha256: component.revision,
        sourcePackageObjectSha256: component.sourceObject,
      })),
    }),
  );
  const portable = await Effect.runPromise(
    encodePortableSkillSetEnvelope({
      sourceManifestBytes: source.bytes,
      components: componentInputs.map((component, index) => ({
        ordinal: component.ordinal,
        logicalSkillId: component.logicalSkillId,
        sourceRevisionSha256: component.revision,
        sourcePackageObjectSha256: component.sourceObject,
        sealedPackageBytes: sealedPackages[index]!,
        terms: { licenseExpression: "MIT", noticePaths: [] },
      })),
    }),
  );
  const assignment: HostedSkillSetAssignment = {
    assignment_id: "assignment_01",
    request_id: "assignment_request_01",
    release_id: "release_01",
    skill_set_id: "engineering",
    name: "Engineering",
    description: "Pinned engineering workflow",
    publisher_name: "Platform team",
    sequence: 1,
    skill_set_revision_sha256: source.skillSetRevisionSha256,
    envelope_sha256: portable.portableSkillSetEnvelopeSha256,
    byte_length: portable.bytes.byteLength,
    assigned_at: Date.parse("2026-08-31T10:00:00.000Z"),
    update_policy: "ask_before_updating",
    components: componentInputs.map((component) => ({
      name: component.logicalSkillId,
      license_expression: "MIT",
    })),
    harnesses: [...harnesses],
    readiness: {
      status: "ready",
      checked_components: componentInputs.length,
      blocked_components: 0,
    },
    observed: {
      status: "unknown",
      lifecycle_sequence: null,
      receipt_id: null,
      observed_release_id: null,
      observed_at: null,
      failure_code: null,
    },
  };
  const submitted: HostedSkillSetInstallationReceiptRequest[] = [];
  let packageBytes = portable.bytes;
  let receiptOnline = false;
  let receiptFailureIsTerminal = false;
  const hosted = {
    listSkillSetAssignments: async () => ({ assignments: [assignment] }),
    downloadSkillSetAssignmentPackage: async () => ({
      bytes: packageBytes,
      metadata: {
        assignment_id: assignment.assignment_id,
        release_id: assignment.release_id,
        envelope_sha256: assignment.envelope_sha256,
        byte_length: packageBytes.byteLength,
      },
    }),
    submitSkillSetInstallationReceipt: async (
      receipt: HostedSkillSetInstallationReceiptRequest,
    ) => {
      submitted.push(receipt);
      if (!receiptOnline) {
        throw receiptFailureIsTerminal
          ? Object.assign(new Error("assignment conflict"), {
              retryable: false,
            })
          : new Error("offline");
      }
      return {
        receipt_id: `hosted_${receipt.request_id}`,
        assignment_id: receipt.assignment_id,
        release_id: receipt.release_id,
        lifecycle_sequence: receipt.lifecycle_sequence,
        status: receipt.result,
        recorded_at: receipt.occurred_at,
        idempotent: false,
      } as const;
    },
  };
  const dbPath = join(root, "selftune.db");
  const db = openDb(dbPath);
  const sqlite = makeSqliteInstallerReceiptAuthority(db);
  const commitLock = makeSqliteInstallerExclusiveCommitLock(db);
  const runtime = makeTeamSkillSetAssignmentRuntime({
    configRoot,
    hosted,
    planning: {
      os: makeNodeInstallerOsObservationAuthority({
        homeDirectory: homeRoot,
        configDirectory: configRoot,
      }),
      receipts: sqlite.planning,
      commitLock,
    },
    materialization: {
      filesystem: options.filesystem ?? makeNodeInstallerMaterializationFileSystem(),
      receipts: sqlite.durable,
      now: () => "2026-08-31T10:05:00.000Z",
    },
    now: () => Date.parse("2026-08-31T10:05:00.000Z"),
    afterInstallerCommit: options.afterInstallerCommit,
    afterRollbackCommit: options.afterRollbackCommit,
  });
  return {
    root,
    projectRoot,
    configRoot,
    homeRoot,
    dbPath,
    hosted,
    assignment,
    runtime,
    skillBytes: componentInputs[0]!.bytes,
    componentInputs,
    submitted,
    setPackageBytes: (bytes: Uint8Array) => {
      packageBytes = bytes;
    },
    setReceiptOnline: (online: boolean) => {
      receiptOnline = online;
    },
    setReceiptFailureIsTerminal: (terminal: boolean) => {
      receiptFailureIsTerminal = terminal;
    },
    close: () => db.close(),
  };
}

describe("team Skill Set assignment runtime", () => {
  test("previews, atomically installs, durably retries a privacy-safe receipt, and undoes", async () => {
    const setup = await fixture();
    try {
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      expect(preview.ready).toBe(true);
      expect(preview.scope).toBe("project");
      expect(preview.tools).toEqual(["codex"]);
      expect(preview.skills).toEqual([
        {
          name: "review",
          licenseExpression: "MIT",
          revisionSha256: "1".repeat(64),
          packagePaths: ["SKILL.md"],
        },
      ]);

      const installed = await setup.runtime.install({
        assignmentId: setup.assignment.assignment_id,
        requestId: preview.requestId,
        expectedReleaseId: setup.assignment.release_id,
        expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: setup.assignment.envelope_sha256,
        confirmInstall: true,
      });
      expect(installed.status).toBe("current");
      expect(installed.receiptPending).toBe(true);
      expect(
        await readFile(join(setup.projectRoot, ".agents", "skills", "review", "SKILL.md")),
      ).toEqual(Buffer.from(setup.skillBytes));
      expect(setup.submitted).toHaveLength(1);
      expect(JSON.stringify(setup.submitted[0])).not.toContain(setup.projectRoot);

      setup.setReceiptOnline(true);
      expect(await setup.runtime.flushPendingReceipts()).toEqual({
        sent: 1,
        pending: 0,
      });
      expect(setup.submitted[1]).toMatchObject({
        request_id: setup.submitted[0]?.request_id,
        lifecycle_sequence: 1,
        result: "current",
        rollback_pointer: installed.receiptId,
        failure_code: null,
      });
      const contribution = await setup.runtime.contributionContext(setup.assignment.assignment_id);
      expect(contribution).toMatchObject({
        assignmentId: setup.assignment.assignment_id,
        assignmentRequestId: setup.assignment.request_id,
        releaseId: setup.assignment.release_id,
        installedCopies: [
          {
            agent: "codex",
            skillName: "review",
            targetPath: await realpath(join(setup.projectRoot, ".agents", "skills", "review")),
          },
        ],
      });
      expect(contribution.baseEnvelopeBytes.byteLength).toBe(setup.assignment.byte_length);

      setup.setReceiptOnline(false);
      const rolledBack = await setup.runtime.rollback({
        assignmentId: setup.assignment.assignment_id,
        receiptId: installed.receiptId,
        confirmRollback: true,
      });
      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.receiptPending).toBe(true);
      expect(await Bun.file(join(setup.projectRoot, ".agents", "skills", "review")).exists()).toBe(
        false,
      );
      expect(setup.submitted.at(-1)).toMatchObject({
        lifecycle_sequence: 2,
        result: "rolled_back",
        rollback_pointer: installed.receiptId,
        failure_code: null,
      });
    } finally {
      setup.close();
    }
  });

  test("rejects package drift after preview before any filesystem write", async () => {
    const setup = await fixture();
    try {
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      setup.setPackageBytes(new TextEncoder().encode("changed"));

      await expect(
        setup.runtime.install({
          assignmentId: setup.assignment.assignment_id,
          requestId: preview.requestId,
          expectedReleaseId: setup.assignment.release_id,
          expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
          expectedEnvelopeSha256: setup.assignment.envelope_sha256,
          confirmInstall: true,
        }),
      ).rejects.toMatchObject({
        code: "PACKAGE_BINDING_MISMATCH",
      });
      expect(await Bun.file(join(setup.projectRoot, ".agents", "skills", "review")).exists()).toBe(
        false,
      );
      expect(setup.submitted[0]).toMatchObject({
        lifecycle_sequence: 1,
        result: "failed",
        rollback_pointer: null,
        failure_code: "PACKAGE_INTEGRITY_FAILED",
      });
    } finally {
      setup.close();
    }
  });

  test("surfaces a non-retryable hosted receipt rejection as failed sync", async () => {
    const setup = await fixture();
    try {
      setup.setReceiptFailureIsTerminal(true);
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      const installed = await setup.runtime.install({
        assignmentId: setup.assignment.assignment_id,
        requestId: preview.requestId,
        expectedReleaseId: setup.assignment.release_id,
        expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: setup.assignment.envelope_sha256,
        confirmInstall: true,
      });
      expect(installed).toMatchObject({
        receiptPending: false,
        syncStatus: "failed",
      });
      expect((await setup.runtime.listAssignments())[0]).toMatchObject({
        localStatus: "current",
        syncStatus: "failed",
        receiptPending: false,
      });
    } finally {
      setup.close();
    }
  });

  test("keeps the exact pending receipt durable across a Desktop restart", async () => {
    const setup = await fixture();
    let reopened: ReturnType<typeof openDb> | null = null;
    try {
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      await setup.runtime.install({
        assignmentId: setup.assignment.assignment_id,
        requestId: preview.requestId,
        expectedReleaseId: setup.assignment.release_id,
        expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: setup.assignment.envelope_sha256,
        confirmInstall: true,
      });
      const original = structuredClone(setup.submitted[0]!);
      setup.close();

      reopened = openDb(setup.dbPath);
      const sqlite = makeSqliteInstallerReceiptAuthority(reopened);
      const commitLock = makeSqliteInstallerExclusiveCommitLock(reopened);
      const restarted = makeTeamSkillSetAssignmentRuntime({
        configRoot: setup.configRoot,
        hosted: setup.hosted,
        planning: {
          os: makeNodeInstallerOsObservationAuthority({
            homeDirectory: setup.homeRoot,
            configDirectory: setup.configRoot,
          }),
          receipts: sqlite.planning,
          commitLock,
        },
        materialization: {
          filesystem: makeNodeInstallerMaterializationFileSystem(),
          receipts: sqlite.durable,
          now: () => "2026-08-31T10:05:00.000Z",
        },
        now: () => Date.parse("2026-08-31T10:05:00.000Z"),
      });
      setup.setReceiptOnline(true);

      expect(await restarted.flushPendingReceipts()).toEqual({
        sent: 1,
        pending: 0,
      });
      expect(setup.submitted[1]).toEqual(original);
      expect(setup.submitted[1]?.request_id).toBe(original.request_id);
    } finally {
      reopened?.close();
    }
  });

  test("reconciles a crash after the installer commit before the local binding is finalized", async () => {
    let crashOnce = true;
    const setup = await fixture({
      afterInstallerCommit: () => {
        if (!crashOnce) return;
        crashOnce = false;
        throw new Error("simulated process crash after SQLite commit");
      },
    });
    let reopened: ReturnType<typeof openDb> | null = null;
    try {
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      await expect(
        setup.runtime.install({
          assignmentId: setup.assignment.assignment_id,
          requestId: preview.requestId,
          expectedReleaseId: setup.assignment.release_id,
          expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
          expectedEnvelopeSha256: setup.assignment.envelope_sha256,
          confirmInstall: true,
        }),
      ).rejects.toThrow("simulated process crash");
      expect(setup.submitted).toHaveLength(0);
      setup.close();

      reopened = openDb(setup.dbPath);
      const sqlite = makeSqliteInstallerReceiptAuthority(reopened);
      const commitLock = makeSqliteInstallerExclusiveCommitLock(reopened);
      const restarted = makeTeamSkillSetAssignmentRuntime({
        configRoot: setup.configRoot,
        hosted: setup.hosted,
        planning: {
          os: makeNodeInstallerOsObservationAuthority({
            homeDirectory: setup.homeRoot,
            configDirectory: setup.configRoot,
          }),
          receipts: sqlite.planning,
          commitLock,
        },
        materialization: {
          filesystem: makeNodeInstallerMaterializationFileSystem(),
          receipts: sqlite.durable,
          now: () => "2026-08-31T10:05:00.000Z",
        },
        now: () => Date.parse("2026-08-31T10:05:00.000Z"),
      });
      setup.setReceiptOnline(true);

      expect(await restarted.flushPendingReceipts()).toEqual({
        sent: 1,
        pending: 0,
      });
      expect(setup.submitted[0]).toMatchObject({
        assignment_id: setup.assignment.assignment_id,
        release_id: setup.assignment.release_id,
        lifecycle_sequence: 1,
        result: "current",
        failure_code: null,
      });
      const [listed] = await restarted.listAssignments();
      expect(listed).toMatchObject({
        localStatus: "current",
        syncStatus: "synced",
        receiptPending: false,
        canRollback: true,
      });
    } finally {
      reopened?.close();
    }
  });

  test("reconciles a crash after aggregate Undo commits before its receipt is queued", async () => {
    const setup = await fixture({
      afterRollbackCommit: () => {
        throw new Error("simulated process crash after Undo commit");
      },
    });
    let reopened: ReturnType<typeof openDb> | null = null;
    try {
      setup.setReceiptOnline(true);
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      const installed = await setup.runtime.install({
        assignmentId: setup.assignment.assignment_id,
        requestId: preview.requestId,
        expectedReleaseId: setup.assignment.release_id,
        expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: setup.assignment.envelope_sha256,
        confirmInstall: true,
      });
      await expect(
        setup.runtime.rollback({
          assignmentId: setup.assignment.assignment_id,
          receiptId: installed.receiptId,
          confirmRollback: true,
        }),
      ).rejects.toThrow("simulated process crash after Undo commit");
      expect(setup.submitted).toHaveLength(1);
      setup.close();

      reopened = openDb(setup.dbPath);
      const sqlite = makeSqliteInstallerReceiptAuthority(reopened);
      const commitLock = makeSqliteInstallerExclusiveCommitLock(reopened);
      const restarted = makeTeamSkillSetAssignmentRuntime({
        configRoot: setup.configRoot,
        hosted: setup.hosted,
        planning: {
          os: makeNodeInstallerOsObservationAuthority({
            homeDirectory: setup.homeRoot,
            configDirectory: setup.configRoot,
          }),
          receipts: sqlite.planning,
          commitLock,
        },
        materialization: {
          filesystem: makeNodeInstallerMaterializationFileSystem(),
          receipts: sqlite.durable,
          now: () => "2026-08-31T10:05:00.000Z",
        },
        now: () => Date.parse("2026-08-31T10:05:00.000Z"),
      });

      expect(await restarted.flushPendingReceipts()).toEqual({
        sent: 1,
        pending: 0,
      });
      expect(setup.submitted[1]).toMatchObject({
        lifecycle_sequence: 2,
        result: "rolled_back",
        rollback_pointer: installed.receiptId,
        failure_code: null,
      });
      expect((await restarted.listAssignments())[0]).toMatchObject({
        localStatus: "rolled_back",
        syncStatus: "synced",
        canRollback: false,
      });
    } finally {
      reopened?.close();
    }
  });

  test("persists and submits a bounded failed lifecycle receipt when materialization fails", async () => {
    const base = makeNodeInstallerMaterializationFileSystem();
    const failing: InstallerMaterializationFileSystem = {
      ...base,
      materialize: (input) =>
        Effect.fail(
          InstallerMaterializationError.make({
            code: "INJECTED_UNBOUNDED_INTERNAL_DETAIL",
            message: `sensitive path ${input.targetPath}`,
            path: input.targetPath,
          }),
        ),
    };
    const setup = await fixture({ filesystem: failing });
    try {
      setup.setReceiptOnline(true);
      const preview = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      await expect(
        setup.runtime.install({
          assignmentId: setup.assignment.assignment_id,
          requestId: preview.requestId,
          expectedReleaseId: setup.assignment.release_id,
          expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
          expectedEnvelopeSha256: setup.assignment.envelope_sha256,
          confirmInstall: true,
        }),
      ).rejects.toMatchObject({ code: "INJECTED_UNBOUNDED_INTERNAL_DETAIL" });

      expect(setup.submitted).toHaveLength(1);
      expect(setup.submitted[0]).toMatchObject({
        assignment_id: setup.assignment.assignment_id,
        lifecycle_sequence: 1,
        result: "failed",
        rollback_pointer: null,
        failure_code: "INSTALL_FAILED",
      });
      expect(JSON.stringify(setup.submitted[0])).not.toContain(setup.projectRoot);
      expect((await setup.runtime.listAssignments())[0]).toMatchObject({
        localStatus: "failed",
        syncStatus: "synced",
        receiptPending: false,
        canInstall: true,
        canRollback: false,
      });
    } finally {
      setup.close();
    }
  });

  test("binds each confirmation request to its own preview choices", async () => {
    const setup = await fixture({ multi: true });
    try {
      const codex = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["codex"],
      });
      const claude = await setup.runtime.previewInstall({
        assignmentId: setup.assignment.assignment_id,
        scope: "project",
        projectRoot: setup.projectRoot,
        targetAgents: ["claude_code"],
      });
      expect(codex.requestId).not.toBe(claude.requestId);

      await setup.runtime.install({
        assignmentId: setup.assignment.assignment_id,
        requestId: codex.requestId,
        expectedReleaseId: setup.assignment.release_id,
        expectedSkillSetRevisionSha256: setup.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: setup.assignment.envelope_sha256,
        confirmInstall: true,
      });
      expect(
        await Bun.file(join(setup.projectRoot, ".agents", "skills", "review", "SKILL.md")).exists(),
      ).toBe(true);
      expect(
        await Bun.file(join(setup.projectRoot, ".claude", "skills", "review", "SKILL.md")).exists(),
      ).toBe(false);
    } finally {
      setup.close();
    }
  });

  test("keeps a multi-skill multi-agent install atomic and Undo restores every target", async () => {
    const base = makeNodeInstallerMaterializationFileSystem();
    let materializations = 0;
    const failing: InstallerMaterializationFileSystem = {
      ...base,
      materialize: (input) => {
        materializations += 1;
        return materializations === 2
          ? Effect.fail(
              InstallerMaterializationError.make({
                code: "INJECTED_PARTIAL_FAILURE",
                message: "Injected after the first target was materialized.",
                path: input.targetPath,
              }),
            )
          : base.materialize(input);
      },
    };
    const partial = await fixture({ multi: true, filesystem: failing });
    try {
      const preview = await partial.runtime.previewInstall({
        assignmentId: partial.assignment.assignment_id,
        scope: "project",
        projectRoot: partial.projectRoot,
        targetAgents: ["claude_code", "codex"],
      });
      await expect(
        partial.runtime.install({
          assignmentId: partial.assignment.assignment_id,
          requestId: preview.requestId,
          expectedReleaseId: partial.assignment.release_id,
          expectedSkillSetRevisionSha256: partial.assignment.skill_set_revision_sha256,
          expectedEnvelopeSha256: partial.assignment.envelope_sha256,
          confirmInstall: true,
        }),
      ).rejects.toMatchObject({ code: "INJECTED_PARTIAL_FAILURE" });
      for (const registry of [join(".agents", "skills"), join(".claude", "skills")]) {
        for (const component of partial.componentInputs) {
          expect(
            await Bun.file(join(partial.projectRoot, registry, component.logicalSkillId)).exists(),
          ).toBe(false);
        }
      }
    } finally {
      partial.close();
    }

    const rollbackBase = makeNodeInstallerMaterializationFileSystem();
    let restoreCalls = 0;
    let injectRestoreFailure = false;
    const rollbackFailure: InstallerMaterializationFileSystem = {
      ...rollbackBase,
      restoreOwned: (input) => {
        restoreCalls += 1;
        return injectRestoreFailure && restoreCalls === 2
          ? Effect.fail(
              InstallerMaterializationError.make({
                code: "INJECTED_AGGREGATE_ROLLBACK_FAILURE",
                message: "Injected after the first target was restored.",
                path: input.receipt.targetPath,
              }),
            )
          : rollbackBase.restoreOwned(input);
      },
    };
    const installed = await fixture({
      multi: true,
      filesystem: rollbackFailure,
    });
    try {
      installed.setReceiptOnline(true);
      const preview = await installed.runtime.previewInstall({
        assignmentId: installed.assignment.assignment_id,
        scope: "project",
        projectRoot: installed.projectRoot,
        targetAgents: ["claude_code", "codex"],
      });
      const receipt = await installed.runtime.install({
        assignmentId: installed.assignment.assignment_id,
        requestId: preview.requestId,
        expectedReleaseId: installed.assignment.release_id,
        expectedSkillSetRevisionSha256: installed.assignment.skill_set_revision_sha256,
        expectedEnvelopeSha256: installed.assignment.envelope_sha256,
        confirmInstall: true,
      });
      for (const registry of [join(".agents", "skills"), join(".claude", "skills")]) {
        for (const component of installed.componentInputs) {
          expect(
            await readFile(
              join(installed.projectRoot, registry, component.logicalSkillId, "SKILL.md"),
            ),
          ).toEqual(Buffer.from(component.bytes));
        }
      }

      injectRestoreFailure = true;
      await expect(
        installed.runtime.rollback({
          assignmentId: installed.assignment.assignment_id,
          receiptId: receipt.receiptId,
          confirmRollback: true,
        }),
      ).rejects.toMatchObject({ code: "INJECTED_AGGREGATE_ROLLBACK_FAILURE" });
      for (const registry of [join(".agents", "skills"), join(".claude", "skills")]) {
        for (const component of installed.componentInputs) {
          expect(
            await readFile(
              join(installed.projectRoot, registry, component.logicalSkillId, "SKILL.md"),
            ),
          ).toEqual(Buffer.from(component.bytes));
        }
      }

      injectRestoreFailure = false;
      await installed.runtime.rollback({
        assignmentId: installed.assignment.assignment_id,
        receiptId: receipt.receiptId,
        confirmRollback: true,
      });
      for (const registry of [join(".agents", "skills"), join(".claude", "skills")]) {
        for (const component of installed.componentInputs) {
          expect(
            await Bun.file(
              join(installed.projectRoot, registry, component.logicalSkillId),
            ).exists(),
          ).toBe(false);
        }
      }
    } finally {
      installed.close();
    }
  });
});
