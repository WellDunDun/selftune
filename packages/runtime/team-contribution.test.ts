import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  decodePortableSkillSetEnvelope,
  encodeCanonicalSkillSetSourceManifest,
  encodePortablePackageBundle,
  encodePortableSkillSetEnvelope,
} from "@selftune/control-plane";

import { makeTeamSkillSetContributionRuntime } from "./team-contribution.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selftune-team-contribution-"));
  const configRoot = join(root, "config");
  const codex = join(root, "codex", "review");
  const claude = join(root, "claude", "review");
  await Promise.all([
    mkdir(configRoot),
    mkdir(codex, { recursive: true }),
    mkdir(claude, { recursive: true }),
  ]);
  const baseSkill = new TextEncoder().encode("---\nname: review\n---\n# Review\n");
  const sealed = await Effect.runPromise(
    encodePortablePackageBundle({
      files: [{ path: "SKILL.md", content: baseSkill }],
    }),
  );
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
          terms: { licenseExpression: "MIT", noticePaths: [] },
        },
      ],
    }),
  );
  await Promise.all([
    writeFile(join(codex, "SKILL.md"), "---\nname: review\n---\n# Better review\n"),
    writeFile(join(claude, "SKILL.md"), "---\nname: review\n---\n# Different review\n"),
  ]);
  const submitted: unknown[] = [];
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
    const state = JSON.parse(
      await readFile(join(setup.configRoot, "team-contributions", "state-v1.json"), "utf8"),
    );
    expect(JSON.stringify(state)).not.toContain(setup.codex);
    expect(JSON.stringify(state)).not.toContain("Better review");
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
      decodePortableSkillSetEnvelope(Uint8Array.from((firstRequest as { bytes: number[] }).bytes)),
    );
    expect(envelope.components[0]?.package.files[0]?.content).toEqual(
      new TextEncoder().encode("---\nname: review\n---\n# Better review\n"),
    );
  });
});
