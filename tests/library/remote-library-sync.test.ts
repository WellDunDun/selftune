import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  RemoteLibrary,
  RemoteLibraryMemory,
  RemoteLibraryUnavailable,
} from "@selftune/control-plane";
import { Effect, ManagedRuntime } from "effect";

import { openDb } from "../../packages/runtime/localdb/db.js";
import { loadLibraryCatalog } from "../../packages/runtime/library/catalog.js";
import type { RemoteLibraryHandle } from "../../packages/runtime/remote-library-runtime.js";
import { applySkillSetWithRemoteDependencies } from "../../packages/runtime/skill-set-remote-apply.js";
import {
  exportRemoteLibrary,
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "../../packages/runtime/remote-library-sync.js";
import {
  loadSkillIntelligenceFeedback,
  setSkillClassificationOverride,
} from "@selftune/runtime/skill-intelligence/feedback";
import {
  applySkillSet,
  createSkillSet,
  deleteSkillSet,
  getSkillSet,
  isSkillSetDeleted,
  planSkillSet,
} from "../../packages/runtime/skill-sets.js";
import { listSynthesisReleases } from "../../packages/runtime/synthesis.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
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
  test("syncs privacy-safe learned state and merges it into another local database", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-learned-state-sync-"));
    const handle = memoryHandle();
    const source = openDb(":memory:");
    const destination = openDb(":memory:");
    try {
      setSkillClassificationOverride(
        {
          skill_id: "research",
          skill_name: "research",
          category: "research",
          inferred_category: "general",
          reason: "Corrected from /Users/private/transcripts/session.jsonl",
        },
        source,
        new Date("2026-07-16T10:01:00.000Z"),
      );
      const preferences = {
        releasedSkills: false,
        drafts: false,
        skillSets: false,
        metadata: false,
        decisionHistory: true,
      };
      const synced = await syncRemoteLibrary({
        handle,
        db: source,
        configRoot: join(root, "client-a"),
        preferences,
        catalogOptions: { searchDirs: [] },
        now: new Date("2026-07-16T11:00:00.000Z"),
      });
      const learnedArtifact = synced.snapshot.artifacts.find(
        (artifact) => artifact.artifactType === "learned_state",
      );
      expect(learnedArtifact).toBeDefined();
      if (!learnedArtifact) throw new Error("Expected learned state artifact.");
      const remoteText = new TextDecoder().decode(
        await handle.getObject(learnedArtifact.objectHash),
      );
      expect(remoteText).not.toContain("/Users/private");
      expect(remoteText).not.toContain("session.jsonl");

      const unchanged = await syncRemoteLibrary({
        handle,
        db: source,
        configRoot: join(root, "client-a"),
        preferences,
        catalogOptions: { searchDirs: [] },
        now: new Date("2026-07-16T11:30:00.000Z"),
      });
      expect(unchanged.uploaded).toBe(0);
      expect(unchanged.unchanged).toBe(1);
      expect(unchanged.snapshot.snapshotId).toBe(synced.snapshot.snapshotId);

      const restoredRoot = join(root, "restored-client");
      await restoreRemoteLibrary({ handle, targetRoot: restoredRoot });
      const restored = openDb(join(restoredRoot, "selftune.db"));
      try {
        expect(loadSkillIntelligenceFeedback(restored).classificationOverrides).toEqual([
          expect.objectContaining({ skill_id: "research", category: "research" }),
        ]);
      } finally {
        restored.close();
      }

      await syncRemoteLibrary({
        handle,
        db: destination,
        configRoot: join(root, "client-b"),
        preferences,
        catalogOptions: { searchDirs: [] },
        now: new Date("2026-07-16T12:00:00.000Z"),
      });
      expect(loadSkillIntelligenceFeedback(destination).classificationOverrides).toEqual([
        expect.objectContaining({ skill_id: "research", category: "research" }),
      ]);
    } finally {
      source.close();
      destination.close();
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redacts draft provenance and review reasons before the remote boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-privacy-"));
    const handle = memoryHandle();
    const rawSessionId = "private-session-550e8400-e29b-41d4-a716-446655440000";
    const heldOutSessionId = "held-out-private-session";
    const secret = ["sk-", "EXAMPLECREDENTIALPLACEHOLDER123456"].join("");
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

  test("does not rehydrate a locally deleted Skill Set from Sync & Backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-set-tombstone-"));
    const handle = memoryHandle();
    const preferences = {
      releasedSkills: false,
      drafts: false,
      skillSets: true,
      metadata: false,
      decisionHistory: false,
    };
    try {
      const firstRoot = join(root, "client-a");
      const packagePath = createSkill(join(root, "registry"), "research");
      const set = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot: firstRoot },
      );
      await syncRemoteLibrary({ handle, configRoot: firstRoot, preferences });

      const secondRoot = join(root, "client-b");
      await syncRemoteLibrary({ handle, configRoot: secondRoot, preferences });
      expect(getSkillSet(set.set_id, { configRoot: secondRoot }).set_id).toBe(set.set_id);

      deleteSkillSet(set.set_id, { configRoot: secondRoot });
      await syncRemoteLibrary({ handle, configRoot: secondRoot, preferences });

      expect(isSkillSetDeleted(set.set_id, { configRoot: secondRoot })).toBe(true);
      expect(() => getSkillSet(set.set_id, { configRoot: secondRoot })).toThrow(/was not found/);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("does not treat installed catalog skills as SelfTune releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-installed-not-released-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const registry = join(root, "registry");
      const installed = createSkill(registry, "installed-only");
      writeFileSync(
        join(installed, "example.md"),
        `Documentation placeholder: sk-${"A".repeat(24)}\n`,
      );

      const result = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: false,
          metadata: true,
          decisionHistory: false,
        },
        catalogOptions: { searchDirs: [registry] },
      });

      expect(result.snapshot.artifacts.map((artifact) => artifact.artifactType)).toEqual([
        "metadata",
      ]);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("backs up one explicitly selected local skill and discovers it on another device", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-explicit-skill-backup-"));
    const handle = memoryHandle();
    const preferences = {
      releasedSkills: false,
      drafts: false,
      skillSets: false,
      metadata: false,
      decisionHistory: false,
    };
    try {
      const firstRoot = join(root, "first-device");
      const registry = join(root, "registry");
      const packagePath = createSkill(registry, "portable-local-skill");
      const sourceCatalog = await loadLibraryCatalog({
        searchDirs: [registry],
        skillSetConfigRoot: firstRoot,
      });
      const sourceSkill = sourceCatalog.skills.find(
        (skill) => skill.name === "portable-local-skill",
      );
      expect(sourceSkill).toBeDefined();
      if (!sourceSkill) throw new Error("Expected the local skill in the source catalog.");

      const backedUp = await syncRemoteLibrary({
        handle,
        configRoot: firstRoot,
        preferences,
        catalogOptions: { searchDirs: [registry] },
        selectedSkillIds: [sourceSkill.skillId],
      });
      expect(backedUp.uploaded).toBe(1);
      expect(backedUp.snapshot.artifacts).toEqual([
        expect.objectContaining({
          artifactType: "skill_revision",
          revisionHash: computeSkillVersionHash(join(packagePath, "SKILL.md")),
        }),
      ]);

      const secondRoot = join(root, "second-device");
      await syncRemoteLibrary({
        handle,
        configRoot: secondRoot,
        preferences,
        catalogOptions: { searchDirs: [] },
      });
      const destinationCatalog = await loadLibraryCatalog({
        searchDirs: [],
        skillSetConfigRoot: secondRoot,
      });
      const discovered = destinationCatalog.skills.find(
        (skill) => skill.name === "portable-local-skill",
      );
      expect(discovered?.lifecycle).toBe("library");
      expect(discovered?.locations).toEqual([expect.objectContaining({ sourceKind: "cached" })]);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("backs up a verifiable installation when a newer active duplicate cannot be hashed", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-explicit-skill-duplicate-"));
    const handle = memoryHandle();
    const preferences = {
      releasedSkills: false,
      drafts: false,
      skillSets: false,
      metadata: false,
      decisionHistory: false,
    };
    try {
      const configRoot = join(root, "first-device");
      const verifiablePackage = createSkill(join(root, "global-registry"), "portable-local-skill");
      const invalidPackage = createSkill(join(root, "project-registry"), "portable-local-skill");
      symlinkSync(join(root, "missing-cache-entry"), join(invalidPackage, "broken-cache-link"));
      utimesSync(
        join(verifiablePackage, "SKILL.md"),
        new Date("2026-07-15T08:00:00.000Z"),
        new Date("2026-07-15T08:00:00.000Z"),
      );
      utimesSync(
        join(invalidPackage, "SKILL.md"),
        new Date("2026-07-15T09:00:00.000Z"),
        new Date("2026-07-15T09:00:00.000Z"),
      );

      const catalogOptions = {
        searchDirs: [join(root, "global-registry"), join(root, "project-registry")],
      };
      const sourceCatalog = await loadLibraryCatalog({
        ...catalogOptions,
        skillSetConfigRoot: configRoot,
      });
      const sourceSkill = sourceCatalog.skills.find(
        (skill) => skill.name === "portable-local-skill",
      );
      expect(sourceSkill).toBeDefined();
      if (!sourceSkill) throw new Error("Expected duplicate local skill installations.");
      expect(sourceSkill.locations).toHaveLength(2);
      expect(sourceSkill.revisions).toEqual([
        expect.objectContaining({
          contentHash: computeSkillVersionHash(join(verifiablePackage, "SKILL.md")),
        }),
      ]);

      const backedUp = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences,
        catalogOptions,
        selectedSkillIds: [sourceSkill.skillId],
      });

      expect(backedUp.uploaded).toBe(1);
      expect(backedUp.snapshot.artifacts).toEqual([
        expect.objectContaining({
          artifactType: "skill_revision",
          revisionHash: computeSkillVersionHash(join(verifiablePackage, "SKILL.md")),
        }),
      ]);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("downloads missing pinned revisions before applying a Skill Set", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-remote-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "remote-only-skill");
      const set = createSkillSet(
        {
          name: "Remote apply",
          harnesses: ["codex"],
          skills: [{ name: "remote-only-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      await syncRemoteLibrary({
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
      rmSync(join(configRoot, "library", "packages"), { recursive: true, force: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);

      const result = await applySkillSetWithRemoteDependencies(
        { set_id: set.set_id, project_root: projectRoot },
        { configRoot, remoteHandle: handle },
      );

      expect(result.dependencies_downloaded).toBe(1);
      expect(result.status).toBe("applied");
      expect(
        existsSync(join(projectRoot, ".agents", "skills", "remote-only-skill", "SKILL.md")),
      ).toBe(true);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers a hosted Skill Set on a new device before downloading its skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-new-device-set-apply-"));
    const handle = memoryHandle();
    const preferences = {
      releasedSkills: false,
      drafts: false,
      skillSets: true,
      metadata: false,
      decisionHistory: false,
    };
    try {
      const firstRoot = join(root, "first-device");
      const packagePath = createSkill(join(root, "registry"), "hosted-skill");
      const set = createSkillSet(
        {
          name: "Hosted development",
          harnesses: ["codex"],
          skills: [{ name: "hosted-skill", package_path: packagePath }],
        },
        { configRoot: firstRoot },
      );
      await syncRemoteLibrary({
        handle,
        configRoot: firstRoot,
        preferences,
        catalogOptions: { searchDirs: [] },
      });

      const secondRoot = join(root, "second-device");
      await syncRemoteLibrary({
        handle,
        configRoot: secondRoot,
        preferences,
        catalogOptions: { searchDirs: [] },
      });
      const discovered = getSkillSet(set.set_id, { configRoot: secondRoot });
      expect(discovered.revision_hash).toBe(set.revision_hash);
      expect(existsSync(discovered.skills[0]!.library_package_path)).toBe(false);

      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const result = await applySkillSetWithRemoteDependencies(
        { set_id: discovered.set_id, project_root: projectRoot },
        { configRoot: secondRoot, remoteHandle: handle },
      );
      expect(result.dependencies_downloaded).toBe(1);
      expect(existsSync(join(projectRoot, ".agents", "skills", "hosted-skill", "SKILL.md"))).toBe(
        true,
      );
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not read Sync & Backup when every pinned revision is local", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-local-set-apply-"));
    const handle = memoryHandle();
    let remoteReads = 0;
    const trackingHandle: RemoteLibraryHandle = {
      ...handle,
      head: async () => {
        remoteReads += 1;
        return handle.head();
      },
    };
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "local-skill");
      const set = createSkillSet(
        {
          name: "Local apply",
          harnesses: ["codex"],
          skills: [{ name: "local-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);

      const result = await applySkillSetWithRemoteDependencies(
        { set_id: set.set_id, project_root: projectRoot },
        { configRoot, remoteHandle: trackingHandle },
      );

      expect(result.dependencies_downloaded).toBe(0);
      expect(result.status).toBe("applied");
      expect(remoteReads).toBe(0);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs a missing Library package when the project revision is already correct", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-repair-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "repair-skill");
      const set = createSkillSet(
        {
          name: "Repair apply",
          harnesses: ["codex"],
          skills: [{ name: "repair-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      await syncRemoteLibrary({
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
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      applySkillSet({ set_id: set.set_id, project_root: projectRoot }, { configRoot });
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });

      const result = await applySkillSetWithRemoteDependencies(
        { set_id: set.set_id, project_root: projectRoot },
        { configRoot, remoteHandle: handle },
      );

      expect(result.dependencies_downloaded).toBe(1);
      expect(result.status).toBe("unchanged");
      expect(existsSync(join(set.skills[0]!.library_package_path, "SKILL.md"))).toBe(true);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("downloads only the missing revisions from a partially populated Library", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-partial-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const firstPath = createSkill(join(root, "registry"), "first-skill");
      const secondPath = createSkill(join(root, "registry"), "second-skill");
      const set = createSkillSet(
        {
          name: "Partial apply",
          harnesses: ["codex"],
          skills: [
            { name: "first-skill", package_path: firstPath },
            { name: "second-skill", package_path: secondPath },
          ],
        },
        { configRoot },
      );
      await syncRemoteLibrary({
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
      rmSync(set.skills[1]!.library_package_path, { recursive: true, force: true });
      const firstSkillPath = set.skills[0]!.library_package_path;
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);

      const result = await applySkillSetWithRemoteDependencies(
        { set_id: set.set_id, project_root: projectRoot },
        { configRoot, remoteHandle: handle },
      );

      expect(result.dependencies_downloaded).toBe(1);
      expect(existsSync(join(firstSkillPath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(set.skills[1]!.library_package_path, "SKILL.md"))).toBe(true);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a corrupted remote revision before changing the Library or project", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-corrupt-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "corrupt-skill");
      const set = createSkillSet(
        {
          name: "Corrupt apply",
          harnesses: ["codex"],
          skills: [{ name: "corrupt-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      await syncRemoteLibrary({
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
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const corruptingHandle: RemoteLibraryHandle = {
        ...handle,
        getObject: async (objectHash) => {
          const bytes = Uint8Array.from(await handle.getObject(objectHash));
          bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          return bytes;
        },
      };

      await expect(
        applySkillSetWithRemoteDependencies(
          { set_id: set.set_id, project_root: projectRoot },
          { configRoot, remoteHandle: corruptingHandle },
        ),
      ).rejects.toThrow("failed object verification");
      expect(existsSync(set.skills[0]!.library_package_path)).toBe(false);
      expect(existsSync(join(projectRoot, ".agents"))).toBe(false);

      const retry = await applySkillSetWithRemoteDependencies(
        { set_id: set.set_id, project_root: projectRoot },
        { configRoot, remoteHandle: handle },
      );
      expect(retry.dependencies_downloaded).toBe(1);
      expect(retry.status).toBe("applied");
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("reports a pinned revision that is unavailable from Sync & Backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-missing-remote-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "missing-remote-skill");
      const set = createSkillSet(
        {
          name: "Missing remote apply",
          harnesses: ["codex"],
          skills: [{ name: "missing-remote-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      await syncRemoteLibrary({
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
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const incompleteHandle: RemoteLibraryHandle = {
        ...handle,
        head: async () => {
          const head = await handle.head();
          return head
            ? {
                ...head,
                artifacts: head.artifacts.filter((item) => item.artifactType !== "skill_revision"),
              }
            : null;
        },
      };

      await expect(
        applySkillSetWithRemoteDependencies(
          { set_id: set.set_id, project_root: projectRoot },
          { configRoot, remoteHandle: incompleteHandle },
        ),
      ).rejects.toThrow('Pinned revision for "missing-remote-skill" is not available');
      expect(existsSync(join(projectRoot, ".agents"))).toBe(false);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns a retryable machine-readable error when Sync & Backup is offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-offline-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "offline-skill");
      const set = createSkillSet(
        {
          name: "Offline apply",
          harnesses: ["codex"],
          skills: [{ name: "offline-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const offlineHandle: RemoteLibraryHandle = {
        ...handle,
        head: async () => {
          throw RemoteLibraryUnavailable.make({ operation: "head", message: "offline" });
        },
      };

      try {
        await applySkillSetWithRemoteDependencies(
          { set_id: set.set_id, project_root: projectRoot },
          { configRoot, remoteHandle: offlineHandle },
        );
        throw new Error("Expected the offline apply to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(CLIError);
        if (!(error instanceof CLIError)) throw error;
        expect(error.code).toBe("API_ERROR");
        expect(error.retryable).toBe(true);
        expect(error.message).toContain("could not be reached");
      }
      expect(existsSync(join(projectRoot, ".agents"))).toBe(false);
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns an authentication error when Sync & Backup rejects the credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-auth-set-apply-"));
    const handle = memoryHandle();
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "auth-skill");
      const set = createSkillSet(
        {
          name: "Authentication apply",
          harnesses: ["codex"],
          skills: [{ name: "auth-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const unauthorizedHandle: RemoteLibraryHandle = {
        ...handle,
        head: async () => {
          throw RemoteLibraryUnavailable.make({ operation: "head", message: "HTTP 401" });
        },
      };

      try {
        await applySkillSetWithRemoteDependencies(
          { set_id: set.set_id, project_root: projectRoot },
          { configRoot, remoteHandle: unauthorizedHandle },
        );
        throw new Error("Expected the unauthorized apply to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(CLIError);
        if (!(error instanceof CLIError)) throw error;
        expect(error.code).toBe("AUTH_MISSING");
        expect(error.retryable).toBe(false);
        expect(error.message).toContain("credentials were rejected");
      }
    } finally {
      await handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks project conflicts before downloading missing revisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-conflict-set-apply-"));
    const handle = memoryHandle();
    let remoteReads = 0;
    const trackingHandle: RemoteLibraryHandle = {
      ...handle,
      head: async () => {
        remoteReads += 1;
        return handle.head();
      },
    };
    try {
      const configRoot = join(root, "client");
      const packagePath = createSkill(join(root, "registry"), "conflict-skill");
      const set = createSkillSet(
        {
          name: "Conflict apply",
          harnesses: ["codex"],
          skills: [{ name: "conflict-skill", package_path: packagePath }],
        },
        { configRoot },
      );
      rmSync(set.skills[0]!.library_package_path, { recursive: true, force: true });
      const projectRoot = join(root, "project");
      createSkill(join(projectRoot, ".agents", "skills"), "conflict-skill");
      writeFileSync(
        join(projectRoot, ".agents", "skills", "conflict-skill", "local-change.md"),
        "Keep this project revision.\n",
      );

      await expect(
        applySkillSetWithRemoteDependencies(
          { set_id: set.set_id, project_root: projectRoot },
          { configRoot, remoteHandle: trackingHandle },
        ),
      ).rejects.toThrow("blocked by 1 destination conflict");
      expect(remoteReads).toBe(0);
      expect(existsSync(set.skills[0]!.library_package_path)).toBe(false);
      expect(
        existsSync(join(projectRoot, ".agents", "skills", "conflict-skill", "local-change.md")),
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
      const restoredManifest = getSkillSet("research-projects", { configRoot: cleanRoot });
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
  }, 15_000);
});
