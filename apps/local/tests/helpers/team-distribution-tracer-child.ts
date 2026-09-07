import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Schema from "effect/Schema";

import {
  HostedSkillSetAssignment,
  type HostedSkillSetInstallationReceiptRequest,
} from "@selftune/control-plane";
import { openDb } from "@selftune/local-store";
import {
  makeNodeInstallerMaterializationFileSystem,
  makeSqliteInstallerExclusiveCommitLock,
  makeSqliteInstallerReceiptAuthority,
} from "@selftune/runtime/installer";
import {
  makeNodeInstallerOsObservationAuthority,
  makeTeamSkillSetAssignmentRuntime,
} from "@selftune/runtime/team-assignment";

const TracerInput = Schema.Struct({
  mode: Schema.Literals(["install", "rollback"]),
  root: Schema.String,
  assignment: HostedSkillSetAssignment,
  packageBase64: Schema.String,
  receiptId: Schema.optionalKey(Schema.String),
});

const input = Schema.decodeUnknownSync(Schema.fromJsonString(TracerInput))(
  await Bun.file(process.argv[2]!).text(),
);
const projectRoot = join(input.root, "project");
const configRoot = join(input.root, "config");
const homeRoot = join(input.root, "home");
await Promise.all([
  mkdir(join(projectRoot, ".agents", "skills"), { recursive: true }),
  mkdir(configRoot, { recursive: true }),
  mkdir(homeRoot, { recursive: true }),
]);
const bytes = Uint8Array.from(Buffer.from(input.packageBase64, "base64"));
const outbound: HostedSkillSetInstallationReceiptRequest[] = [];
const hosted = {
  listSkillSetAssignments: async () => ({ assignments: [input.assignment] }),
  downloadSkillSetAssignmentPackage: async () => ({
    bytes,
    metadata: {
      assignment_id: input.assignment.assignment_id,
      release_id: input.assignment.release_id,
      envelope_sha256: input.assignment.envelope_sha256,
      byte_length: bytes.byteLength,
    },
  }),
  submitSkillSetInstallationReceipt: async (request: HostedSkillSetInstallationReceiptRequest) => {
    outbound.push(request);
    throw new Error("acceptance tracer offline boundary");
  },
};
const database = openDb(join(input.root, "selftune.db"));
try {
  const receipts = makeSqliteInstallerReceiptAuthority(database);
  const runtime = makeTeamSkillSetAssignmentRuntime({
    configRoot,
    hosted,
    planning: {
      os: makeNodeInstallerOsObservationAuthority({
        homeDirectory: homeRoot,
        configDirectory: configRoot,
      }),
      receipts: receipts.planning,
      commitLock: makeSqliteInstallerExclusiveCommitLock(database),
    },
    materialization: {
      filesystem: makeNodeInstallerMaterializationFileSystem(),
      receipts: receipts.durable,
      now: () => "2026-08-31T10:05:00.000Z",
    },
    now: () => Date.parse("2026-08-31T10:05:00.000Z"),
  });
  if (input.mode === "install") {
    const preview = await runtime.previewInstall({
      assignmentId: input.assignment.assignment_id,
      scope: "project",
      projectRoot,
      targetAgents: ["codex"],
    });
    const installed = await runtime.install({
      assignmentId: input.assignment.assignment_id,
      requestId: preview.requestId,
      expectedReleaseId: input.assignment.release_id,
      expectedSkillSetRevisionSha256: input.assignment.skill_set_revision_sha256,
      expectedEnvelopeSha256: input.assignment.envelope_sha256,
      confirmInstall: true,
    });
    process.stdout.write(
      JSON.stringify({
        receiptId: installed.receiptId,
        request: outbound.at(-1),
        installedBytesBase64: Buffer.from(
          await Bun.file(
            join(projectRoot, ".agents", "skills", "review", "SKILL.md"),
          ).arrayBuffer(),
        ).toString("base64"),
      }),
    );
  } else {
    if (!input.receiptId) throw new Error("rollback requires receiptId");
    await runtime.rollback({
      assignmentId: input.assignment.assignment_id,
      receiptId: input.receiptId,
      confirmRollback: true,
    });
    process.stdout.write(
      JSON.stringify({
        request: outbound.at(-1),
        targetExists: await Bun.file(join(projectRoot, ".agents", "skills", "review")).exists(),
      }),
    );
  }
} finally {
  database.close();
}
