import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  decodePortableSkillSetEnvelope,
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
} from "@selftune/control-plane";

import {
  makeTeamSkillSetContributionRuntime,
  type TeamContributionUploadRequest,
} from "./team-contribution.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(withLicenseFile = false) {
  const root = await mkdtemp(join(tmpdir(), "selftune-team-contribution-"));
  roots.push(root);
  const configRoot = join(root, "config");
  const codex = join(root, "codex", "review");
  const claude = join(root, "claude", "review");
  await Promise.all([
    mkdir(configRoot),
    mkdir(codex, { recursive: true }),
    mkdir(claude, { recursive: true }),
  ]);
  const baseSkill = new TextEncoder().encode("---\nname: review\n---\n# Review\n");
  const files = [{ path: "SKILL.md", content: baseSkill }];
  if (withLicenseFile)
    files.push({ path: "LICENSE", content: new TextEncoder().encode("MIT License") });
  const sealed = await Effect.runPromise(encodePortablePackageBundle({ files }));
  const source = await Effect.runPromise(
    encodeCanonicalSkillSetSourceManifest({
      skillSetId: "engineering",
      name: "Engineering",
      description: "Team workflow",
      harnesses: ["codex", "claude_code"],
      components: [
        {
          ordinal: 0,
          logicalSkillId: "review",
          sourceRevisionSha256: "1".repeat(64),
          sourcePackageObjectSha256: "2".repeat(64),
        },
      ],
    }),
  );
  const base = await Effect.runPromise(
    encodePortableSkillSetEnvelope({
      sourceManifestBytes: source.bytes,
      components: [
        {
          ordinal: 0,
          logicalSkillId: "review",
          sourceRevisionSha256: "1".repeat(64),
          sourcePackageObjectSha256: "2".repeat(64),
          sealedPackageBytes: sealed,
          terms: withLicenseFile
            ? { licenseExpression: "MIT", noticePaths: [], licenseFilePath: "LICENSE" }
            : { licenseExpression: "MIT", noticePaths: [] },
        },
      ],
    }),
  );
  await Promise.all([
    writeFile(join(codex, "SKILL.md"), "---\nname: review\n---\n# Better review\n"),
    writeFile(join(claude, "SKILL.md"), "---\nname: review\n---\n# Different review\n"),
  ]);
  if (withLicenseFile) {
    await Promise.all([
      writeFile(join(codex, "LICENSE"), "MIT License"),
      writeFile(join(claude, "LICENSE"), "MIT License"),
    ]);
  }
  const submitted: Array<{ request: TeamContributionUploadRequest; bytes: number[] }> = [];
  let online = false;
  const runtime = makeTeamSkillSetContributionRuntime({
    configRoot,
    loadCurrentAssignment: async () => ({
      assignmentId: "assignment_01",
      assignmentRequestId: "assignment_request_01",
      skillSetId: "engineering",
      releaseId: "release_01",
      memberDeviceBinding: "member_01:device_01",
      baseEnvelopeBytes: base.bytes,
      installedCopies: [
        {
          receiptId: "receipt_codex",
          agent: "codex",
          skillName: "review",
          targetPath: codex,
        },
        {
          receiptId: "receipt_claude",
          agent: "claude_code",
          skillName: "review",
          targetPath: claude,
        },
      ],
    }),
    hosted: {
      uploadContribution: async (request, bytes) => {
        submitted.push({ request, bytes: [...bytes] });
        if (!online) throw new Error("offline");
        return {
          contribution_id: "contribution_01",
          request_id: request.request_id,
        };
      },
    },
    now: () => Date.parse("2026-08-31T12:00:00.000Z"),
  });
  return {
    root,
    configRoot,
    codex,
    claude,
    runtime,
    submitted,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("team Skill Set contribution runtime", () => {
  test("preserves the base license file when contributing the selected package", async () => {
    const setup = await fixture(true);
    const preview = await setup.runtime.preview({
      assignmentId: "assignment_01",
      title: "Review",
      message: "",
      sourceReceiptIds: ["receipt_codex"],
    });
    setup.setOnline(true);
    expect(
      (await setup.runtime.submit({ previewToken: preview.previewToken, confirmSubmit: true }))
        .syncStatus,
    ).toBe("synced");
    const envelope = await Effect.runPromise(
      decodePortableSkillSetEnvelope(Uint8Array.from(setup.submitted[0].bytes)),
    );
    expect(envelope.envelope.components[0].terms.licenseFile?.path).toBe("LICENSE");
    expect(
      envelope.components[0].package.files.find((file) => file.path === "LICENSE")?.content,
    ).toEqual(new TextEncoder().encode("MIT License"));
  });
  test("requires an exact installed source when copies diverge and preview does not persist candidate bytes", async () => {
    const setup = await fixture();
    await expect(
      setup.runtime.preview({
        assignmentId: "assignment_01",
        title: "Improve review",
        message: "",
      }),
    ).rejects.toMatchObject({ code: "CONTRIBUTION_SOURCE_REQUIRED" });
    const preview = await setup.runtime.preview({
      assignmentId: "assignment_01",
      title: "Improve review",
      message: "",
      sourceReceiptIds: ["receipt_codex"],
    });
    expect(preview.ready).toBe(true);
    expect(preview.sourceChoices).toHaveLength(2);
    expect(preview.changes).toEqual([
      {
        componentName: "review",
        changeType: "modified",
        packagePaths: ["SKILL.md"],
      },
    ]);
    await expect(
      readFile(join(setup.configRoot, "team-contributions", "state-v1.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invalidates confirmation when local bytes change and never packages secrets or paths", async () => {
    const setup = await fixture();
    const preview = await setup.runtime.preview({
      assignmentId: "assignment_01",
      title: "Improve review",
      message: "Ready for review",
      sourceReceiptIds: ["receipt_codex"],
    });
    await writeFile(join(setup.codex, "SKILL.md"), "changed after preview");
    await expect(
      setup.runtime.submit({
        previewToken: preview.previewToken,
        confirmSubmit: true,
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTRIBUTION_PREVIEW" });
    await writeFile(join(setup.codex, ".env"), "TOKEN=secret");
    await expect(
      setup.runtime.preview({
        assignmentId: "assignment_01",
        title: "Improve review",
        message: "",
        sourceReceiptIds: ["receipt_codex"],
      }),
    ).rejects.toMatchObject({ code: "CONTRIBUTION_SECRET_FILE" });
    await unlink(join(setup.codex, ".env"));
    await expect(
      setup.runtime.preview({
        assignmentId: "assignment_01",
        title: "Improve /Users/example/private/review",
        message: "",
        sourceReceiptIds: ["receipt_codex"],
      }),
    ).rejects.toMatchObject({ code: "CONTRIBUTION_LOCAL_PATH" });
    expect(setup.submitted).toHaveLength(0);
  });

  test("only confirmed submit persists private bytes and durably retries the exact package", async () => {
    const setup = await fixture();
    const preview = await setup.runtime.preview({
      assignmentId: "assignment_01",
      title: "Improve review",
      message: "Ready for review",
      sourceReceiptIds: ["receipt_codex"],
    });
    await expect(
      setup.runtime.submit({
        previewToken: preview.previewToken,
        confirmSubmit: false,
      }),
    ).rejects.toMatchObject({ code: "CONTRIBUTION_CONFIRMATION_REQUIRED" });
    const pending = await setup.runtime.submit({
      previewToken: preview.previewToken,
      confirmSubmit: true,
    });
    expect(pending.syncStatus).toBe("pending");
    const state = await readFile(
      join(setup.configRoot, "team-contributions", "state-v1.json"),
      "utf8",
    );
    expect(state).not.toContain(setup.codex);
    expect(state).not.toContain("Better review");
    const firstRequest = setup.submitted[0];
    setup.setOnline(true);
    const restarted = makeTeamSkillSetContributionRuntime({
      configRoot: setup.configRoot,
      loadCurrentAssignment: async () => {
        throw new Error("not needed for retry");
      },
      hosted: {
        uploadContribution: async (request, bytes) => {
          setup.submitted.push({ request, bytes: [...bytes] });
          return {
            contribution_id: "contribution_01",
            request_id: request.request_id,
          };
        },
      },
    });
    expect(await restarted.flush()).toEqual({ sent: 1, pending: 0 });
    expect(setup.submitted[1]).toEqual(firstRequest);
    const envelope = await Effect.runPromise(
      decodePortableSkillSetEnvelope(Uint8Array.from(firstRequest.bytes)),
    );
    expect(envelope.components[0]?.package.files[0]?.content).toEqual(
      new TextEncoder().encode("---\nname: review\n---\n# Better review\n"),
    );
  });
});

const requestId = `contribution_v1_${"a".repeat(40)}`;
const queuedUpload = {
  request: {
    request_id: requestId,
    skill_set_id: "engineering",
    base_release_id: "release_01",
    proposed_skill_set_revision_sha256: "b".repeat(64),
    proposed_envelope_sha256: "c".repeat(64),
    proposed_byte_length: 100,
    title: "Improve review",
    message: "",
  } satisfies TeamContributionUploadRequest,
  packageFile: `${requestId}.json`,
  attempts: 0,
  lastAttemptAt: null,
  deliveredAt: null,
  contributionId: null,
};

test.each([
  { name: "missing request", upload: { ...queuedUpload, request: {} } },
  { name: "negative attempts", upload: { ...queuedUpload, attempts: -1 } },
  { name: "fractional attempts", upload: { ...queuedUpload, attempts: 0.5 } },
  { name: "string timestamp", upload: { ...queuedUpload, lastAttemptAt: "yesterday" } },
  { name: "boolean delivery", upload: { ...queuedUpload, deliveredAt: false } },
  { name: "delivery without receipt", upload: { ...queuedUpload, deliveredAt: 1 } },
  { name: "receipt without delivery", upload: { ...queuedUpload, contributionId: "receipt" } },
  { name: "package escape", upload: { ...queuedUpload, packageFile: "../outside.json" } },
  {
    name: "another package",
    upload: { ...queuedUpload, packageFile: `contribution_v1_${"d".repeat(40)}.json` },
  },
  {
    name: "request-key mismatch",
    upload: {
      ...queuedUpload,
      request: { ...queuedUpload.request, request_id: `contribution_v1_${"d".repeat(40)}` },
    },
  },
  {
    name: "invalid digest",
    upload: {
      ...queuedUpload,
      request: { ...queuedUpload.request, proposed_envelope_sha256: "invalid" },
    },
  },
  {
    name: "string size",
    upload: { ...queuedUpload, request: { ...queuedUpload.request, proposed_byte_length: "100" } },
  },
  { name: "null entry", upload: null },
])(
  "rejects $name before any contribution upload and preserves the state file",
  async ({ upload }) => {
    const setup = await fixture();
    const directory = join(setup.configRoot, "team-contributions");
    await mkdir(directory);
    const path = join(directory, "state-v1.json");
    const bytes = JSON.stringify({ version: 1, outbox: { [requestId]: upload } });
    await writeFile(path, bytes);
    setup.setOnline(true);
    await expect(setup.runtime.flush()).rejects.toMatchObject({
      code: "CONTRIBUTION_STATE_CORRUPT",
    });
    expect(setup.submitted).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);

test("rejects invalid outbox keys and resumes the queue after the state is repaired", async () => {
  const setup = await fixture();
  const directory = join(setup.configRoot, "team-contributions");
  await mkdir(directory);
  const path = join(directory, "state-v1.json");
  const bytes = JSON.stringify({ version: 1, outbox: { "invalid-request": queuedUpload } });
  await writeFile(path, bytes);
  await expect(setup.runtime.flush()).rejects.toMatchObject({ code: "CONTRIBUTION_STATE_CORRUPT" });
  expect(await readFile(path, "utf8")).toBe(bytes);
  await writeFile(path, JSON.stringify({ version: 1, outbox: {} }));
  expect(await setup.runtime.flush()).toEqual({ sent: 0, pending: 0 });
  expect(setup.submitted).toEqual([]);
});

test("leaves an already delivered contribution untouched on restart", async () => {
  const setup = await fixture();
  const directory = join(setup.configRoot, "team-contributions");
  await mkdir(directory);
  const path = join(directory, "state-v1.json");
  const bytes = JSON.stringify({
    version: 1,
    outbox: {
      [requestId]: {
        ...queuedUpload,
        attempts: 1,
        lastAttemptAt: 100,
        deliveredAt: 100,
        contributionId: "receipt_01",
      },
    },
  });
  await writeFile(path, bytes);
  expect(await setup.runtime.flush()).toEqual({ sent: 0, pending: 0 });
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(setup.submitted).toEqual([]);
});
