import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  BaselineResult,
  evaluateReleaseGate,
  ReleaseGateInput,
  RemoteLibrary,
  RemoteLibraryMemory,
} from "@selftune/control-plane";
import { Effect, ManagedRuntime } from "effect";

import { loadLibraryCatalog } from "../../packages/runtime/library-catalog.js";
import { openDb } from "../../packages/runtime/localdb/db.js";
import type { RemoteLibraryHandle } from "../../packages/runtime/remote-library-runtime.js";
import {
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "../../packages/runtime/remote-library-sync.js";
import {
  quarantineSkill,
  restoreQuarantinedSkill,
} from "../../packages/runtime/skill-portfolio.js";
import { applySkillSet, createSkillSet, planSkillSet } from "../../packages/runtime/skill-sets.js";
import {
  draftSynthesisCandidate,
  evaluateSynthesisCandidate,
  releaseSynthesisCandidate,
  reviewSynthesisCandidate,
  scanSynthesisCandidates,
} from "../../packages/runtime/synthesis.js";
import type { CreatePackageEvaluationSummary } from "../../packages/runtime/types.js";
import { findInstalledSkillPackages } from "../../packages/runtime/utils/skill-discovery.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function createSkill(registry: string, name: string): string {
  const path = join(registry, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} work.\n---\n# ${name}\n`,
  );
  return path;
}

function memoryHandle(): RemoteLibraryHandle {
  const runtime = ManagedRuntime.make(RemoteLibraryMemory);
  const use = <A>(program: (remote: RemoteLibrary["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* program(yield* RemoteLibrary);
      }),
    );
  return {
    capabilities: () => use((remote) => remote.capabilities),
    putObject: (objectHash, bytes) => use((remote) => remote.putObject({ objectHash, bytes })),
    hasObject: (objectHash) => use((remote) => remote.hasObject(objectHash)),
    getObject: (objectHash) => use((remote) => remote.getObject(objectHash)),
    head: () => use((remote) => remote.head),
    getSnapshot: (snapshotId) => use((remote) => remote.getSnapshot(snapshotId)),
    commitSnapshot: (snapshot) => use((remote) => remote.commitSnapshot(snapshot)),
    diagnostics: () => use((remote) => remote.diagnostics),
    dispose: () => runtime.dispose(),
  };
}

function passingPackageEvaluation(
  skillName: string,
  skillPath: string,
): CreatePackageEvaluationSummary {
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
      proposal_id: "library-lifecycle",
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
      measured_at: "2026-07-15T00:00:00.000Z",
    },
  };
}

describe("black-box local Library lifecycle", () => {
  test("moves evidence through draft, evaluation, distribution, archive, sync, and clean restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-library-lifecycle-"));
    roots.push(root);
    const configRoot = join(root, "client-a");
    const codexRegistry = join(root, ".agents", "skills");
    const openCodeRegistry = join(root, ".opencode", "skills");
    createSkill(codexRegistry, "research");
    createSkill(openCodeRegistry, "research");
    createSkill(codexRegistry, "trial-skill");

    const firstCatalog = await loadLibraryCatalog({
      searchDirs: [codexRegistry, openCodeRegistry],
      skillSetConfigRoot: configRoot,
      quarantineRoot: join(configRoot, "quarantine"),
    });
    expect(firstCatalog.skills.find((skill) => skill.name === "research")?.locations).toHaveLength(
      2,
    );

    const db = openDb(":memory:");
    for (let index = 1; index <= 3; index += 1) {
      db.run(
        `INSERT INTO session_telemetry (
          session_id, timestamp, cwd, skills_triggered_json, skills_invoked_json,
          assistant_turns, errors_encountered, last_user_query
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `session-${index}`,
          `2026-07-0${index}T00:00:00.000Z`,
          join(root, `project-${index}`),
          "[]",
          "[]",
          2,
          0,
          "Prepare release notes",
        ],
      );
    }
    const snapshot = await scanSynthesisCandidates({ configRoot, db });
    const candidate = snapshot.candidates[0]!;
    await reviewSynthesisCandidate(
      {
        candidateId: candidate.candidateId,
        action: "accept",
        reason: "Reusable evidence across projects.",
      },
      { configRoot, now: new Date("2026-07-15T00:00:00.000Z") },
    );
    const drafted = await draftSynthesisCandidate(candidate.candidateId, undefined, { configRoot });
    expect(existsSync(join(drafted.draft.skill_dir, "evals", "generated.json"))).toBe(true);
    const provenance = JSON.parse(
      readFileSync(join(drafted.draft.skill_dir, "selftune.synthesis.json"), "utf8"),
    ) as { held_out_session_ids: string[] };
    expect(provenance.held_out_session_ids.length).toBeGreaterThan(0);

    const result = evaluateReleaseGate(
      ReleaseGateInput.make({
        candidateId: candidate.candidateId,
        evidenceSnapshotId: snapshot.snapshotId,
        packageValid: true,
        replayPassed: true,
        draft: BaselineResult.make({
          baseline: "composite",
          caseCount: 4,
          activationAccuracy: 0.9,
          routingQuality: 0.9,
          outcomeQuality: 0.9,
          contextTokens: 220,
          regressions: [],
        }),
        baselines: [
          BaselineResult.make({
            baseline: "no_skill",
            caseCount: 4,
            activationAccuracy: 0.8,
            routingQuality: 0.8,
            outcomeQuality: 0.6,
            contextTokens: 0,
            regressions: [],
          }),
          BaselineResult.make({
            baseline: "existing_skills",
            caseCount: 4,
            activationAccuracy: 0.85,
            routingQuality: 0.8,
            outcomeQuality: 0.7,
            contextTokens: 400,
            regressions: [],
          }),
        ],
        minimumOutcomeLift: 0.05,
        maximumActivationRegression: 0.02,
      }),
    );
    expect(result.recommended).toBe(true);

    await evaluateSynthesisCandidate(candidate.candidateId, {
      configRoot,
      runCreatePublish: async () => ({
        skill: drafted.draft.skill_name,
        skill_path: drafted.draft.skill_path,
        published: true,
        watch_started: false,
        watch_gate_blocked: false,
        next_command: null,
        package_evaluation: passingPackageEvaluation(
          drafted.draft.skill_name,
          drafted.draft.skill_path,
        ),
        replay_exit_code: 0,
        baseline_exit_code: 0,
        watch_exit_code: null,
        watch_result: null,
        watch_stdout: "",
        watch_stderr: "",
        watch_gate_passed: null,
        watch_gate_warnings: [],
        watch_trust_score: null,
        watch_gate_bypassed: false,
      }),
    });
    const released = await releaseSynthesisCandidate(candidate.candidateId, { configRoot });

    const skillSet = createSkillSet(
      {
        name: "Release projects",
        harnesses: ["codex", "opencode"],
        skills: [{ name: released.skill_name, package_path: released.package_path }],
      },
      { configRoot },
    );
    const projectRoot = join(root, "materialized-project");
    mkdirSync(projectRoot);
    const receipt = applySkillSet(
      { set_id: skillSet.set_id, project_root: projectRoot },
      { configRoot },
    );
    expect(receipt.status).toBe("applied");
    expect(
      existsSync(join(projectRoot, ".agents", "skills", drafted.draft.skill_name, "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectRoot, ".opencode", "skills", drafted.draft.skill_name, "SKILL.md")),
    ).toBe(true);

    const installed = findInstalledSkillPackages([codexRegistry]);
    const archived = quarantineSkill({
      installedSkills: installed,
      skillName: "trial-skill",
      quarantineRoot: join(configRoot, "quarantine"),
    });
    expect(existsSync(join(codexRegistry, "trial-skill"))).toBe(false);
    restoreQuarantinedSkill({
      quarantineId: archived.quarantine_id,
      quarantineRoot: join(configRoot, "quarantine"),
    });
    expect(existsSync(join(codexRegistry, "trial-skill", "SKILL.md"))).toBe(true);

    const handle = memoryHandle();
    try {
      const synced = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences: {
          releasedSkills: true,
          drafts: true,
          skillSets: true,
          metadata: true,
          decisionHistory: true,
        },
        catalogOptions: {
          searchDirs: [codexRegistry, openCodeRegistry],
          quarantineRoot: join(configRoot, "quarantine"),
        },
      });
      expect(synced.snapshot.artifacts.some((artifact) => artifact.artifactType === "draft")).toBe(
        true,
      );
      const cleanRoot = join(root, "client-b");
      await restoreRemoteLibrary({ handle, targetRoot: cleanRoot });
      expect(existsSync(join(cleanRoot, "synthesis", "remote-decisions.json"))).toBe(true);
      expect(existsSync(join(cleanRoot, "skill-sets", `${skillSet.set_id}.json`))).toBe(true);
      expect(existsSync(join(cleanRoot, ".agents"))).toBe(false);
      const restoredProject = join(root, "restored-materialized-project");
      mkdirSync(restoredProject);
      const restoredPlan = planSkillSet(
        { set_id: skillSet.set_id, project_root: restoredProject },
        { configRoot: cleanRoot },
      );
      expect(restoredPlan.conflicts).toBe(0);
      expect(restoredPlan.creates).toBe(2);
      const restoredReceipt = applySkillSet(
        { set_id: skillSet.set_id, project_root: restoredProject },
        { configRoot: cleanRoot },
      );
      expect(restoredReceipt.status).toBe("applied");
      expect(
        existsSync(join(restoredProject, ".agents", "skills", released.skill_name, "SKILL.md")),
      ).toBe(true);
    } finally {
      await handle.dispose();
      db.close();
    }
  });
});
