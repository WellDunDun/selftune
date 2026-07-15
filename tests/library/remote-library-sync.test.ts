import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RemoteLibrary, RemoteLibraryMemory } from "@selftune/control-plane";
import { Effect, ManagedRuntime } from "effect";

import type { RemoteLibraryHandle } from "../../packages/runtime/remote-library-runtime.js";
import {
  exportRemoteLibrary,
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "../../packages/runtime/remote-library-sync.js";
import { applySkillSet, createSkillSet, planSkillSet } from "../../packages/runtime/skill-sets.js";
import { listSynthesisReleases } from "../../packages/runtime/synthesis.js";
import { computeSkillVersionHash } from "../../packages/runtime/utils/skill-discovery.js";

function passingPackageEvaluation(skillName: string, skillPath: string) {
  return {
    skill_name: skillName,
    skill_path: skillPath,
    mode: "package",
    status: "passed",
    evaluation_passed: true,
    next_command: null,
    replay: {
      mode: "package",
      validation_mode: "host_replay",
      agent: "claude",
      proposal_id: "remote-library-sync",
      fixture_id: "held-out-fixture",
      total: 2,
      passed: 2,
      failed: 0,
      pass_rate: 1,
    },
    baseline: {
      mode: "package",
      baseline_pass_rate: 0.5,
      with_skill_pass_rate: 1,
      lift: 0.5,
      adds_value: true,
      measured_at: "2026-07-15T08:00:00.000Z",
    },
  };
}

function createSkill(registry: string, name: string): string {
  const packagePath = join(registry, name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
  writeFileSync(join(packagePath, "workflow.md"), `Workflow for ${name}.\n`);
  return packagePath;
}

function memoryHandle(): RemoteLibraryHandle {
  const runtime = ManagedRuntime.make(RemoteLibraryMemory);
  const service = <A>(use: (remote: RemoteLibrary["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* RemoteLibrary);
      }),
    );
  return {
    capabilities: () => service((remote) => remote.capabilities),
    putObject: (objectHash, bytes) => service((remote) => remote.putObject({ objectHash, bytes })),
    hasObject: (objectHash) => service((remote) => remote.hasObject(objectHash)),
    getObject: (objectHash) => service((remote) => remote.getObject(objectHash)),
    head: () => service((remote) => remote.head),
    getSnapshot: (snapshotId) => service((remote) => remote.getSnapshot(snapshotId)),
    commitSnapshot: (snapshot) => service((remote) => remote.commitSnapshot(snapshot)),
    diagnostics: () => service((remote) => remote.diagnostics),
    dispose: () => runtime.dispose(),
  };
}

describe("Remote Library sync lifecycle", () => {
  test("redacts draft provenance and review reasons before the remote boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-privacy-"));
    const handle = memoryHandle();
    const rawSessionId = "private-session-550e8400-e29b-41d4-a716-446655440000";
    const heldOutSessionId = "held-out-private-session";
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const repositoryPath = "/Users/private/secret-repository";
    try {
      const configRoot = join(root, "client");
      const draftPath = createSkill(join(configRoot, "library", "drafts"), "private-draft");
      writeFileSync(
        join(draftPath, "selftune.synthesis.json"),
        `${JSON.stringify({
          schema_version: 1,
          supporting_session_ids: [rawSessionId],
          held_out_session_ids: [heldOutSessionId],
        })}\n`,
      );
      mkdirSync(join(draftPath, "evals"), { recursive: true });
      writeFileSync(
        join(draftPath, "evals", "generated.json"),
        `${JSON.stringify({ evidence_snapshot_id: "a".repeat(64), note: "safe hash" })}\n`,
      );
      const secretFile = join(draftPath, "private-notes.md");
      writeFileSync(secretFile, `Temporary credential: ${secret}\n`);
      const revisionHash = computeSkillVersionHash(join(draftPath, "SKILL.md"));
      expect(revisionHash).not.toBeNull();
      const gatePath = join(configRoot, "library", "release-gates", "privacy-candidate.json");
      mkdirSync(dirname(gatePath), { recursive: true });
      mkdirSync(join(configRoot, "library", "releases"), { recursive: true });
      writeFileSync(
        gatePath,
        `${JSON.stringify({
          schema_version: 1,
          candidate_id: "privacy-candidate",
          evidence_snapshot_id: "privacy-snapshot",
          skill_name: "private-draft",
          draft_path: draftPath,
          revision_hash: revisionHash,
          evaluated_at: "2026-07-15T08:05:00.000Z",
          recommended: true,
          blockers: [],
          evaluation: null,
        })}\n`,
      );
      writeFileSync(
        join(configRoot, "library", "releases", "privacy-candidate.json"),
        `${JSON.stringify({
          schema_version: 1,
          candidate_id: "privacy-candidate",
          evidence_snapshot_id: "privacy-snapshot",
          skill_name: "private-draft",
          revision_hash: revisionHash,
          package_path: draftPath,
          gate_path: gatePath,
          released_at: "2026-07-15T08:06:00.000Z",
        })}\n`,
      );
      mkdirSync(join(configRoot, "synthesis"), { recursive: true });
      writeFileSync(
        join(configRoot, "synthesis", "candidates.json"),
        `${JSON.stringify({
          snapshotId: "privacy-snapshot",
          evidenceVersion: 1,
          generatedAt: "2026-07-15T08:00:00.000Z",
          candidates: [
            {
              candidateId: "privacy-candidate",
              kind: "coverage_gap",
              title: "Private candidate",
              summary: "A locally reviewed candidate.",
              skillNames: [],
              evidence: {
                evidenceVersion: 1,
                supportSessions: 3,
                projectDiversity: 1,
                temporalSpanDays: 3,
                outcomeQuality: 0.8,
                coUsageLift: null,
                sequenceConsistency: null,
                completionRate: null,
                confidence: 0.7,
                uncertainty: 0.3,
                exploratory: true,
              },
              supportingSessionIds: [rawSessionId],
              heldOutSessionIds: [heldOutSessionId],
              redactedExcerpts: [`Do not sync ${secret} from ${repositoryPath}`],
              generatedAt: "2026-07-15T08:00:00.000Z",
              status: "rejected",
              decision: {
                action: "reject",
                reason: `Found ${secret} in ${repositoryPath} during 550e8400-e29b-41d4-a716-446655440000`,
                decidedAt: "2026-07-15T08:10:00.000Z",
                snoozedUntil: null,
              },
              decisionHistory: [
                {
                  action: "reject",
                  reason: `Found ${secret} in ${repositoryPath} during 550e8400-e29b-41d4-a716-446655440000`,
                  decidedAt: "2026-07-15T08:10:00.000Z",
                  snoozedUntil: null,
                },
              ],
            },
          ],
        })}\n`,
      );

      const syncPrivateArtifacts = () =>
        syncRemoteLibrary({
          handle,
          configRoot,
          preferences: {
            releasedSkills: false,
            drafts: true,
            skillSets: false,
            metadata: false,
            decisionHistory: true,
          },
          catalogOptions: { searchDirs: [] },
        });
      await expect(syncPrivateArtifacts()).rejects.toMatchObject({
        code: "GUARD_BLOCKED",
      });
      rmSync(secretFile);
      await syncPrivateArtifacts();

      const head = await handle.head();
      expect(head).not.toBeNull();
      const payloads = await Promise.all(
        (head?.artifacts ?? []).map(async (artifact) =>
          new TextDecoder().decode(await handle.getObject(artifact.objectHash)),
        ),
      );
      const remoteBytes = payloads.join("\n");
      expect(remoteBytes).not.toContain(rawSessionId);
      expect(remoteBytes).not.toContain(heldOutSessionId);
      expect(remoteBytes).not.toContain(secret);
      expect(remoteBytes).not.toContain(repositoryPath);
      expect(remoteBytes).not.toContain("550e8400-e29b-41d4-a716-446655440000");
      expect(remoteBytes).toContain("[SECRET]");
      expect(remoteBytes).toContain("[PATH]");
      expect(remoteBytes).toContain("[SESSION]");
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("backs every Skill Set dependency even when general skill backup is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-set-closure-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client-a");
      const packagePath = createSkill(join(root, "registry"), "set-only-skill");
      const set = createSkillSet(
        {
          name: "Set closure",
          harnesses: ["codex"],
          skills: [{ name: "set-only-skill", package_path: packagePath }],
        },
        { configRoot, now: new Date("2026-07-15T08:00:00.000Z") },
      );

      const result = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences: {
          releasedSkills: false,
          drafts: false,
          skillSets: true,
          metadata: false,
          decisionHistory: false,
        },
        catalogOptions: { searchDirs: [] },
      });

      expect(result.uploaded).toBe(2);
      expect(result.snapshot.artifacts.map((artifact) => artifact.artifactType).toSorted()).toEqual(
        ["skill_revision", "skill_set"],
      );
      expect(
        result.snapshot.artifacts.find((artifact) => artifact.artifactType === "skill_revision")
          ?.revisionHash,
      ).toBe(set.skills[0]?.content_hash);

      const cleanRoot = join(root, "client-b");
      await restoreRemoteLibrary({ handle, targetRoot: cleanRoot });
      const restoredProject = join(root, "restored-project");
      mkdirSync(restoredProject);
      const receipt = applySkillSet(
        { set_id: set.set_id, project_root: restoredProject },
        { configRoot: cleanRoot },
      );
      expect(receipt.status).toBe("applied");
      expect(
        existsSync(join(restoredProject, ".agents", "skills", "set-only-skill", "SKILL.md")),
      ).toBe(true);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("syncs selected artifacts, exports history, and restores a clean client", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-library-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client-a");
      const registry = join(root, ".opencode", "skills");
      const skillPath = createSkill(registry, "research");
      const set = createSkillSet(
        {
          name: "Research projects",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: skillPath }],
        },
        { configRoot, now: new Date("2026-07-15T08:00:00.000Z") },
      );
      mkdirSync(join(configRoot, "synthesis"), { recursive: true });
      writeFileSync(
        join(configRoot, "synthesis", "candidates.json"),
        `${JSON.stringify({
          snapshotId: "snapshot",
          evidenceVersion: 1,
          generatedAt: "2026-07-15T08:00:00.000Z",
          candidates: [],
        })}\n`,
      );
      const pinned = set.skills[0]!;
      const gatePath = join(configRoot, "library", "release-gates", "research.json");
      mkdirSync(join(configRoot, "library", "releases"), { recursive: true });
      mkdirSync(join(configRoot, "library", "release-gates"), { recursive: true });
      writeFileSync(
        gatePath,
        `${JSON.stringify({
          schema_version: 1,
          candidate_id: "research",
          evidence_snapshot_id: "snapshot",
          candidate_revision_hash: "fixture-candidate-revision",
          skill_name: "research",
          draft_path: pinned.library_package_path,
          revision_hash: pinned.content_hash,
          evaluated_at: "2026-07-15T08:00:00.000Z",
          replay_exit_code: 0,
          baseline_exit_code: 0,
          held_out_eval_ids: ["held-out-fixture"],
          recommended: true,
          blockers: [],
          evaluation: passingPackageEvaluation(
            "research",
            join(pinned.library_package_path, "SKILL.md"),
          ),
        })}\n`,
      );
      writeFileSync(
        join(configRoot, "library", "releases", "research.json"),
        `${JSON.stringify({
          schema_version: 1,
          candidate_id: "research",
          evidence_snapshot_id: "snapshot",
          candidate_revision_hash: "fixture-candidate-revision",
          skill_name: "research",
          revision_hash: pinned.content_hash,
          package_path: pinned.library_package_path,
          gate_path: gatePath,
          released_at: "2026-07-15T08:00:00.000Z",
        })}\n`,
      );

      const result = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: true,
          metadata: true,
          decisionHistory: true,
        },
        catalogOptions: { searchDirs: [registry], quarantineRoot: join(configRoot, "quarantine") },
        now: new Date("2026-07-15T09:00:00.000Z"),
      });

      expect(result.uploaded).toBe(4);
      expect(result.snapshot.artifacts.map((artifact) => artifact.artifactType).toSorted()).toEqual(
        ["decision_history", "metadata", "skill_revision", "skill_set"],
      );
      const secondDevice = await syncRemoteLibrary({
        handle,
        configRoot: join(root, "client-with-no-local-artifacts"),
        preferences: {
          releasedSkills: false,
          drafts: false,
          skillSets: false,
          metadata: false,
          decisionHistory: false,
        },
      });
      expect(secondDevice.snapshot.artifacts).toHaveLength(4);
      expect(secondDevice.snapshot.snapshotId).toBe(result.snapshot.snapshotId);
      const backupPath = join(root, "selftune-library-backup.json");
      const exported = await exportRemoteLibrary({
        handle,
        outputPath: backupPath,
        now: new Date("2026-07-15T10:00:00.000Z"),
      });
      expect(exported.snapshots).toBe(1);
      expect(exported.objects).toBe(4);
      expect(existsSync(backupPath)).toBe(true);

      const cleanRoot = join(root, "client-b");
      const restored = await restoreRemoteLibrary({ handle, targetRoot: cleanRoot });
      expect(restored.restored).toBe(4);
      expect(listSynthesisReleases(cleanRoot)).toHaveLength(1);
      expect(existsSync(join(cleanRoot, "skill-sets", "research-projects.json"))).toBe(true);
      expect(existsSync(join(cleanRoot, "synthesis", "remote-decisions.json"))).toBe(true);
      const packageHashes = readdirSync(join(cleanRoot, "library", "packages"));
      expect(packageHashes).toHaveLength(1);
      expect(
        existsSync(
          join(cleanRoot, "library", "packages", packageHashes[0]!, "research", "SKILL.md"),
        ),
      ).toBe(true);
      const restoredManifest = JSON.parse(
        readFileSync(join(cleanRoot, "skill-sets", "research-projects.json"), "utf8"),
      ) as { skills: Array<{ content_hash: string }> };
      expect(restoredManifest.skills[0]?.content_hash).toBe(packageHashes[0]);
      const restoredProject = join(root, "restored-project");
      mkdirSync(restoredProject);
      const plan = planSkillSet(
        { set_id: "research-projects", project_root: restoredProject },
        { configRoot: cleanRoot },
      );
      expect(plan.conflicts).toBe(0);
      expect(plan.creates).toBe(1);
      const receipt = applySkillSet(
        { set_id: "research-projects", project_root: restoredProject },
        { configRoot: cleanRoot },
      );
      expect(receipt.status).toBe("applied");
      expect(existsSync(join(restoredProject, ".agents", "skills", "research", "SKILL.md"))).toBe(
        true,
      );
      expect(existsSync(join(cleanRoot, ".agents"))).toBe(false);
      expect(existsSync(join(cleanRoot, ".claude"))).toBe(false);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
