import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as Schema from "effect/Schema";
import { QuarantineRecord } from "../../packages/runtime/dashboard-contract.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPortfolioAudit,
  listQuarantinedSkills,
  quarantineSkill,
  restoreQuarantinedSkill,
} from "../../packages/runtime/skill-portfolio.js";
import type { SessionTelemetryRecord } from "../../packages/runtime/types.js";
import type { TrustedSkillObservationRow } from "../../packages/runtime/localdb/queries.js";
import {
  findInstalledSkillPackages,
  type InstalledSkillPackage,
} from "../../packages/runtime/utils/skill-discovery.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");

function installedSkill(
  name: string,
  options: Partial<InstalledSkillPackage> = {},
): InstalledSkillPackage {
  return {
    name,
    skill_path: `/skills/${name}/SKILL.md`,
    package_path: `/skills/${name}`,
    registry_dir: "/skills",
    modified_at: "2026-01-01T00:00:00.000Z",
    skill_scope: "global",
    ...options,
  };
}

function observation(
  skillName: string,
  index: number,
  triggered: boolean,
  occurredAt = "2026-07-10T00:00:00.000Z",
  skillPath = `/skills/${skillName}/SKILL.md`,
): TrustedSkillObservationRow {
  return {
    skill_name: skillName,
    skill_path: skillPath,
    session_id: `observation-${skillName}-${index}`,
    occurred_at: occurredAt,
    triggered: triggered ? 1 : 0,
    matched_prompt_id: `prompt-${index}`,
    confidence: 1,
    invocation_mode: triggered ? "inferred" : "contextual",
    query_text: `query ${index}`,
  };
}

function session(index: number, timestamp: string): SessionTelemetryRecord {
  return {
    timestamp,
    session_id: `session-${index}`,
    cwd: "/repo",
    transcript_path: `/transcripts/${index}.jsonl`,
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 1,
    last_user_query: `query ${index}`,
  };
}

function createSkill(registry: string, name: string): string {
  const packagePath = join(registry, name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
  writeFileSync(join(packagePath, "reference.md"), `Reference for ${name}.\n`);
  return packagePath;
}

describe("skill portfolio audit", () => {
  test("keeps zero-data skills unobserved instead of calling them unused", () => {
    const result = buildPortfolioAudit([installedSkill("rare-recovery")], [], [], { now: NOW });

    expect(result.skills[0]?.classification).toBe("unobserved");
    expect(result.skills[0]?.recommendation).toBe("measure");
    expect(result.skills[0]?.reason).toContain("not evidence that the skill is unused");
  });

  test("flags never-invoked skills after enough age and subsequent sessions", () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit(
      [installedSkill("never-invoked", { modified_at: "2026-05-01T00:00:00.000Z" })],
      [],
      sessions,
      { now: NOW },
    );

    expect(result.skills[0]?.classification).toBe("inactive_candidate");
    expect(result.skills[0]?.recommendation).toBe("review_quarantine");
    expect(result.skills[0]?.evidence.last_invoked_at).toBeNull();
    expect(result.skills[0]?.evidence.sessions_since_invocation).toBe(25);
    expect(result.skills[0]?.reason).toContain("No trusted invocation has ever been recorded");
  });

  test("does not count sessions from before a never-invoked skill was modified", () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit(
      [installedSkill("newer-than-sessions", { modified_at: "2026-05-01T00:00:00.000Z" })],
      [],
      sessions,
      { now: NOW },
    );

    expect(result.skills[0]?.classification).toBe("unobserved");
    expect(result.skills[0]?.evidence.sessions_since_invocation).toBe(0);
  });

  test("routes repeated contextual misses to repair instead of quarantine", () => {
    const observations = Array.from({ length: 12 }, (_, index) =>
      observation("misrouted", index, false),
    );
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit([installedSkill("misrouted")], observations, sessions, {
      now: NOW,
    });

    expect(result.skills[0]?.classification).toBe("routing_problem");
    expect(result.skills[0]?.recommendation).toBe("repair_routing");
  });

  test("routes high miss rates with a prior invocation to repair instead of quarantine", () => {
    const oldInvocation = observation("misrouted", 0, true, "2026-05-01T00:00:00.000Z");
    const misses = Array.from({ length: 19 }, (_, index) =>
      observation("misrouted", index + 1, false),
    );
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-06-${String((index % 25) + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit(
      [installedSkill("misrouted")],
      [oldInvocation, ...misses],
      sessions,
      { now: NOW },
    );

    expect(result.skills[0]?.classification).toBe("routing_problem");
    expect(result.skills[0]?.evidence.miss_rate).toBe(0.95);
  });

  test("flags only previously invoked skills after enough inactive days and sessions", () => {
    const oldInvocation = "2026-05-01T00:00:00.000Z";
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-06-${String((index % 25) + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit(
      [installedSkill("stale-skill")],
      [observation("stale-skill", 0, true, oldInvocation)],
      sessions,
      { now: NOW, minSessions: 20, inactiveDays: 30 },
    );

    expect(result.skills[0]?.classification).toBe("inactive_candidate");
    expect(result.skills[0]?.recommendation).toBe("review_quarantine");
    expect(result.skills[0]?.evidence.sessions_since_invocation).toBe(25);
  });

  test("protects SelfTune and system-managed skills", () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session(index, `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const result = buildPortfolioAudit(
      [installedSkill("selftune"), installedSkill("platform-skill", { skill_scope: "system" })],
      [],
      sessions,
      { now: NOW },
    );

    expect(result.skills.map((skill) => skill.classification)).toEqual(["protected", "protected"]);
  });

  test("prefers consolidation review over inactivity", () => {
    const result = buildPortfolioAudit(
      [installedSkill("family-one")],
      [observation("family-one", 0, true, "2026-01-01T00:00:00.000Z")],
      Array.from({ length: 30 }, (_, index) =>
        session(index, `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
      ),
      { now: NOW, consolidationSkillNames: new Set(["family-one"]) },
    );

    expect(result.skills[0]?.classification).toBe("consolidation_candidate");
    expect(result.skills[0]?.recommendation).toBe("review_consolidation");
  });

  test("uses only sessions from a project skill's repository", () => {
    const projectSkill = installedSkill("project-only", {
      skill_path: "/repo-a/.agents/skills/project-only/SKILL.md",
      package_path: "/repo-a/.agents/skills/project-only",
      skill_scope: "project",
      skill_project_root: "/repo-a",
    });
    const oldInvocation = observation(
      "project-only",
      0,
      true,
      "2026-05-01T00:00:00.000Z",
      projectSkill.skill_path,
    );
    const unrelatedSessions = Array.from({ length: 25 }, (_, index) => ({
      ...session(index, `2026-06-${String((index % 25) + 1).padStart(2, "0")}T00:00:00.000Z`),
      cwd: "/repo-b",
    }));

    const result = buildPortfolioAudit([projectSkill], [oldInvocation], unrelatedSessions, {
      now: NOW,
    });

    expect(result.skills[0]?.classification).toBe("under_observed");
    expect(result.skills[0]?.evidence.sessions_since_invocation).toBe(0);
  });

  test("does not share observations between duplicate package names", () => {
    const first = installedSkill("duplicate", {
      skill_path: "/one/duplicate/SKILL.md",
      package_path: "/one/duplicate",
    });
    const second = installedSkill("duplicate", {
      skill_path: "/two/duplicate/SKILL.md",
      package_path: "/two/duplicate",
    });
    const observations = Array.from({ length: 10 }, (_, index) =>
      observation("duplicate", index, true, undefined, first.skill_path),
    );

    const result = buildPortfolioAudit([first, second], observations, [], { now: NOW });

    expect(result.skills[0]?.classification).toBe("active");
    expect(result.skills[1]?.classification).toBe("unobserved");
  });
});

describe("reversible skill quarantine", () => {
  test("rejects malformed saved receipts without moving quarantined packages", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-quarantine-invalid-"));
    const registry = join(root, "registry");
    const quarantineRoot = join(root, "quarantine");
    const originalPath = createSkill(registry, "receipt-skill");
    try {
      const quarantined = quarantineSkill({
        installedSkills: findInstalledSkillPackages([registry]),
        skillName: "receipt-skill",
        quarantineRoot,
        now: NOW,
      });
      const receiptPath = join(quarantineRoot, quarantined.quarantine_id, "record.json");
      const saved = readFileSync(receiptPath, "utf8");
      const record = Schema.decodeUnknownSync(Schema.fromJsonString(QuarantineRecord))(saved);
      for (const fields of [
        { status: "unrecognized" },
        { skill_scope: 7 },
        { original_package_path: [] },
        { quarantined_at: null },
        { restored_at: false },
      ]) {
        writeFileSync(receiptPath, JSON.stringify({ ...record, ...fields }));
        expect(() =>
          restoreQuarantinedSkill({ quarantineId: quarantined.quarantine_id, quarantineRoot }),
        ).toThrow("is invalid");
        expect(existsSync(originalPath)).toBe(false);
        expect(existsSync(quarantined.quarantined_package_path)).toBe(true);
        expect(listQuarantinedSkills(quarantineRoot)).toEqual([]);
      }
      writeFileSync(receiptPath, saved);
      expect(
        restoreQuarantinedSkill({ quarantineId: quarantined.quarantine_id, quarantineRoot }).status,
      ).toBe("restored");
      expect(existsSync(originalPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("moves the complete package, returns undo, restores exactly, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-"));
    const registry = join(root, "registry");
    const quarantineRoot = join(root, "quarantine");
    mkdirSync(registry, { recursive: true });
    const originalPackagePath = createSkill(registry, "stale-skill");

    try {
      const firstInventory = findInstalledSkillPackages([registry]);
      const quarantined = quarantineSkill({
        installedSkills: firstInventory,
        skillName: "stale-skill",
        quarantineRoot,
        now: NOW,
      });

      expect(quarantined.status).toBe("quarantined");
      expect(quarantined.undo_command).toContain(quarantined.quarantine_id);
      expect(existsSync(originalPackagePath)).toBe(false);
      expect(existsSync(join(quarantined.quarantined_package_path, "reference.md"))).toBe(true);
      expect(listQuarantinedSkills(quarantineRoot)).toHaveLength(1);

      const retriedQuarantine = quarantineSkill({
        installedSkills: findInstalledSkillPackages([registry]),
        skillName: "stale-skill",
        quarantineRoot,
      });
      expect(retriedQuarantine.status).toBe("already_quarantined");
      expect(retriedQuarantine.quarantine_id).toBe(quarantined.quarantine_id);

      const restored = restoreQuarantinedSkill({
        quarantineId: quarantined.quarantine_id,
        quarantineRoot,
        now: NOW,
      });
      expect(restored.status).toBe("restored");
      expect(existsSync(join(originalPackagePath, "SKILL.md"))).toBe(true);
      expect(existsSync(join(originalPackagePath, "reference.md"))).toBe(true);
      expect(listQuarantinedSkills(quarantineRoot)).toEqual([]);

      const retriedRestore = restoreQuarantinedSkill({
        quarantineId: quarantined.quarantine_id,
        quarantineRoot,
      });
      expect(retriedRestore.status).toBe("already_restored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run does not move or persist the package", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-"));
    const registry = join(root, "registry");
    const quarantineRoot = join(root, "quarantine");
    mkdirSync(registry, { recursive: true });
    const packagePath = createSkill(registry, "preview-skill");

    try {
      const receipt = quarantineSkill({
        installedSkills: findInstalledSkillPackages([registry]),
        skillName: "preview-skill",
        quarantineRoot,
        dryRun: true,
      });

      expect(receipt.dry_run).toBe(true);
      expect(receipt.undo_command).toBeNull();
      expect(existsSync(packagePath)).toBe(true);
      expect(existsSync(quarantineRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks protected skills and ambiguous duplicate names", () => {
    expect(() =>
      quarantineSkill({
        installedSkills: [installedSkill("selftune")],
        skillName: "selftune",
      }),
    ).toThrow("protected");

    expect(() =>
      quarantineSkill({
        installedSkills: [
          installedSkill("duplicate", { skill_path: "/one/duplicate/SKILL.md" }),
          installedSkill("duplicate", { skill_path: "/two/duplicate/SKILL.md" }),
        ],
        skillName: "duplicate",
      }),
    ).toThrow("multiple registries");
  });

  test("protects a symlinked package in the system registry", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-"));
    const codexHome = join(root, ".codex");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const systemRegistry = join(codexHome, "skills", ".system");
    const packageTarget = createSkill(join(root, "packages"), "system-link");
    mkdirSync(systemRegistry, { recursive: true });
    symlinkSync(packageTarget, join(systemRegistry, "system-link"));

    try {
      const inventory = findInstalledSkillPackages([systemRegistry]);
      expect(inventory[0]?.skill_scope).toBe("system");
      expect(() =>
        quarantineSkill({
          installedSkills: inventory,
          skillName: "system-link",
          quarantineRoot: join(root, "quarantine"),
        }),
      ).toThrow("protected");
    } finally {
      if (previousCodexHome == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps lexical project scope for a symlinked package", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-"));
    const projectRoot = join(root, "project");
    const projectRegistry = join(projectRoot, ".agents", "skills");
    const packageTarget = createSkill(join(root, "packages"), "project-link");
    mkdirSync(projectRegistry, { recursive: true });
    symlinkSync(packageTarget, join(projectRegistry, "project-link"));

    try {
      const inventory = findInstalledSkillPackages([projectRegistry]);
      expect(inventory[0]?.skill_scope).toBe("project");
      expect(inventory[0]?.skill_project_root).toBe(projectRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restores relative package symlinks even while quarantined links are dangling", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-"));
    const registry = join(root, "registry");
    const packages = join(root, "packages");
    const quarantineRoot = join(root, "quarantine");
    createSkill(packages, "relative-link");
    mkdirSync(registry, { recursive: true });
    const originalPackagePath = join(registry, "relative-link");
    symlinkSync("../packages/relative-link", originalPackagePath);

    try {
      const quarantined = quarantineSkill({
        installedSkills: findInstalledSkillPackages([registry]),
        skillName: "relative-link",
        quarantineRoot,
      });
      expect(existsSync(quarantined.quarantined_package_path)).toBe(false);
      expect(listQuarantinedSkills(quarantineRoot)).toHaveLength(1);

      const restored = restoreQuarantinedSkill({
        quarantineId: quarantined.quarantine_id,
        quarantineRoot,
      });
      expect(restored.status).toBe("restored");
      expect(existsSync(join(originalPackagePath, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks restore when archived package content no longer matches its receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-portfolio-integrity-"));
    const registry = join(root, "registry");
    const quarantineRoot = join(root, "quarantine");
    createSkill(registry, "changed-archive");
    try {
      const receipt = quarantineSkill({
        installedSkills: findInstalledSkillPackages([registry]),
        skillName: "changed-archive",
        quarantineRoot,
      });
      writeFileSync(
        join(receipt.quarantined_package_path, "SKILL.md"),
        "---\nname: changed-archive\ndescription: altered\n---\n",
      );
      expect(() =>
        restoreQuarantinedSkill({ quarantineId: receipt.quarantine_id, quarantineRoot }),
      ).toThrow("integrity check failed");
      expect(existsSync(receipt.quarantined_package_path)).toBe(true);
      expect(existsSync(join(registry, "changed-archive"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("skills CLI entrypoint", () => {
  test("preserves the grouped audit subcommand", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "selftune-portfolio-home-"));
    try {
      const result = Bun.spawnSync(["bun", "apps/cli/src/main.ts", "skills", "audit", "--json"], {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          SELFTUNE_HOME: isolatedHome,
          SELFTUNE_NO_ANALYTICS: "1",
          CI: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = Buffer.from(result.stdout).toString("utf8");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        installed_count: expect.any(Number),
        skills: expect.any(Array),
      });
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
