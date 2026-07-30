import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_COMMAND_GROUPS } from "../../apps/cli/src/commands/router.js";
import {
  makeLiveSkillsCommandActions,
  type SkillsActionDependencies,
  type SkillsCommandActions,
} from "../../apps/cli/src/effect-cli/commands/skills.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import type {
  PortfolioAuditResult,
  QuarantineReceipt,
  QuarantineRecord,
} from "../../packages/runtime/dashboard-contract.js";
import type {
  RunSkillsAuditOptions,
  RunSkillsQuarantineOptions,
  RunSkillsRestoreOptions,
  SkillsConsolidationResult,
  SkillsConsolidationRollbackResult,
} from "../../packages/runtime/skill-portfolio/programs.js";
import {
  formatSkillsConsolidation,
  formatSkillsConsolidationRollback,
  formatSkillsAudit,
  formatSkillsQuarantined,
  formatSkillsReceipt,
  runSkillsQuarantineProgram,
  runSkillsRestoreProgram,
} from "../../packages/runtime/skill-portfolio/programs.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

function disabled(operation: string) {
  return () => Effect.fail(new CLIError(`unexpected ${operation}`, "INTERNAL_ERROR"));
}

function makeActions(overrides: Partial<SkillsCommandActions>): SkillsCommandActions {
  return {
    audit: overrides.audit ?? disabled("audit"),
    quarantined: overrides.quarantined ?? disabled("quarantined"),
    quarantine: overrides.quarantine ?? disabled("quarantine"),
    restore: overrides.restore ?? disabled("restore"),
    consolidate: overrides.consolidate ?? disabled("consolidate"),
    consolidationRollback: overrides.consolidationRollback ?? disabled("consolidationRollback"),
  };
}

function run(args: ReadonlyArray<string>, skillsActions: SkillsCommandActions) {
  return Effect.runPromise(
    makeEffectCliTestProgram(args, { skillsActions }).pipe(Effect.provide(BunServices.layer)),
  );
}

type SkillsModule = Awaited<ReturnType<SkillsActionDependencies["loadModule"]>>;

const unusedRuntimeOperation = () => {
  throw new Error("unused runtime operation");
};

function makeRuntimeModule(overrides: Partial<SkillsModule> = {}): SkillsModule {
  return {
    runSkillsAuditProgram: unusedRuntimeOperation,
    formatSkillsAudit: unusedRuntimeOperation,
    runSkillsQuarantinedProgram: unusedRuntimeOperation,
    formatSkillsQuarantined: unusedRuntimeOperation,
    runSkillsQuarantineProgram: unusedRuntimeOperation,
    runSkillsRestoreProgram: unusedRuntimeOperation,
    formatSkillsReceipt: unusedRuntimeOperation,
    runSkillsConsolidateProgram: unusedRuntimeOperation,
    formatSkillsConsolidation: unusedRuntimeOperation,
    runSkillsConsolidationRollbackProgram: unusedRuntimeOperation,
    formatSkillsConsolidationRollback: unusedRuntimeOperation,
    ...overrides,
  };
}

const auditResult: PortfolioAuditResult = {
  generated_at: "2026-01-02T03:04:05.000Z",
  thresholds: { min_sessions: 20, inactive_days: 30, min_checks: 5, routing_miss_rate: 0.2 },
  session_count: 0,
  installed_count: 0,
  counts: {
    protected: 0,
    unobserved: 0,
    under_observed: 0,
    routing_problem: 0,
    active: 0,
    inactive_candidate: 0,
    consolidation_candidate: 0,
  },
  skills: [],
};

const quarantineRecord: QuarantineRecord = {
  schema_version: 1,
  quarantine_id: "q-1",
  status: "quarantined",
  skill_name: "demo",
  skill_scope: "global",
  original_package_path: "/skills/demo",
  original_skill_path: "/skills/demo/SKILL.md",
  quarantined_package_path: "/quarantine/demo",
  package_version_hash: null,
  quarantined_at: "2026-01-02T03:04:05.000Z",
  restored_at: null,
};

const receipt: QuarantineReceipt = {
  success: true,
  status: "quarantined",
  skill_name: "demo",
  quarantine_id: "q-1",
  original_package_path: "/skills/demo",
  quarantined_package_path: "/quarantine/demo",
  package_version_hash: null,
  dry_run: false,
  undo_command: "selftune skills restore --id q-1",
};

const consolidationResult: SkillsConsolidationResult = {
  success: true,
  operation: "consolidate_skill_installations",
  dry_run: false,
  mode: "single",
  requested_skill: "demo",
  already_consolidated: false,
  counts: {
    recommended: 1,
    selected: 1,
    planned: 0,
    applied: 1,
    review_required: 0,
    failed: 0,
  },
  items: [
    {
      skill_name: "demo",
      status: "applied",
      confidence: "source_current",
      reason: "Current with source.",
      canonical: {
        content_hash: "hash",
        package_path: "/skills/demo",
        skill_path: "/skills/demo/SKILL.md",
        library_package_path: "/library/hash/demo",
      },
      targets: [
        {
          action: "replace_with_link",
          package_path: "/project/.agents/skills/demo",
          skill_path: "/project/.agents/skills/demo/SKILL.md",
          content_hash: "old-hash",
          project_root: "/project",
          connection: "codex",
          archive_id: "archive-1",
          archive_destination: "/archive/demo",
        },
      ],
      decision_id: "decision-1",
      receipt_id: "receipt-1",
      applied_at: "2026-01-02T03:04:05.000Z",
      rollback_behavior: "Restore archived copies and remove managed links.",
      undo_command: "selftune skills consolidation-rollback --id decision-1 --yes --json",
      error: null,
    },
  ],
};

const rollbackResult: SkillsConsolidationRollbackResult = {
  success: true,
  operation: "rollback_skill_consolidation",
  dry_run: false,
  decision_id: "decision-1",
  skill_name: "demo",
  status: "rolled_back",
  receipt_id: "receipt-1",
  restored_paths: ["/project/.agents/skills/demo"],
  removed_links: ["/project/.agents/skills/demo"],
  rolled_back_at: "2026-01-02T03:05:05.000Z",
};

const alreadyConsolidatedResult: SkillsConsolidationResult = {
  ...consolidationResult,
  already_consolidated: true,
  counts: {
    recommended: 0,
    selected: 0,
    planned: 0,
    applied: 0,
    review_required: 0,
    failed: 0,
  },
  items: [],
};

describe("Effect CLI skills command", () => {
  test("dispatches a single-skill consolidation preview through the public CLI", async () => {
    const calls: unknown[] = [];
    const actions = {
      ...makeActions({}),
      consolidate: (options: unknown, json: boolean) =>
        Effect.sync(() => calls.push(["consolidate", options, json])),
    };

    await run(
      [
        "skills",
        "consolidate",
        "--skill",
        "agent-browser",
        "--search-dir=/projects/app/.agents/skills",
        "--dry-run",
        "--json",
      ],
      actions,
    );

    expect(calls).toEqual([
      [
        "consolidate",
        {
          skill: "agent-browser",
          allSafe: false,
          searchDirs: ["/projects/app/.agents/skills"],
          approved: false,
          dryRun: true,
        },
        true,
      ],
    ]);
  });

  test("dispatches consolidation rollback with explicit approval through the public CLI", async () => {
    const calls: unknown[] = [];
    const actions = makeActions({
      consolidationRollback: (options, json) =>
        Effect.sync(() => calls.push(["consolidation-rollback", options, json])),
    });

    await run(
      ["skills", "consolidation-rollback", "--id", "decision-1", "--yes", "--json"],
      actions,
    );

    expect(calls).toEqual([
      ["consolidation-rollback", { id: "decision-1", approved: true, dryRun: false }, true],
    ]);
  });

  test("dispatches the original portfolio leaves with defaults and complete typed options", async () => {
    const calls: unknown[] = [];
    const actions = makeActions({
      audit: (options, json) => Effect.sync(() => calls.push(["audit", options, json])),
      quarantined: (json) => Effect.sync(() => calls.push(["quarantined", json])),
      quarantine: (options, json) => Effect.sync(() => calls.push(["quarantine", options, json])),
      restore: (options, json) => Effect.sync(() => calls.push(["restore", options, json])),
    });

    await run(["skills", "audit"], actions);
    await run(
      [
        "skills",
        "audit",
        "--min-sessions",
        "5",
        "--inactive-days=9",
        "--search-dir",
        "one",
        "--search-dir=two",
        "--json",
      ],
      actions,
    );
    await run(["skills", "quarantined", "--json"], actions);
    await run(
      [
        "skills",
        "quarantine",
        "--skill",
        "demo",
        "--skill-path=/skills/demo/SKILL.md",
        "--yes",
        "--dry-run",
        "--json",
      ],
      actions,
    );
    await run(["skills", "restore", "--id", "q-1", "--dry-run", "--json"], actions);

    expect(calls).toEqual([
      ["audit", { minSessions: 20, inactiveDays: 30, searchDirs: [] }, false],
      ["audit", { minSessions: 5, inactiveDays: 9, searchDirs: ["one", "two"] }, true],
      ["quarantined", true],
      [
        "quarantine",
        {
          skill: "demo",
          skillPath: "/skills/demo/SKILL.md",
          approved: true,
          dryRun: true,
        },
        true,
      ],
      ["restore", { id: "q-1", dryRun: true }, true],
    ]);
  });

  test("preserves repeated, empty, leading-dash, embedded-equals, and integer quirks", async () => {
    const audits: RunSkillsAuditOptions[] = [];
    const quarantines: RunSkillsQuarantineOptions[] = [];
    const restores: RunSkillsRestoreOptions[] = [];
    const actions = makeActions({
      audit: (options) => Effect.sync(() => audits.push(options)),
      quarantine: (options) => Effect.sync(() => quarantines.push(options)),
      restore: (options) => Effect.sync(() => restores.push(options)),
    });

    await run(
      [
        "skills",
        "audit",
        "--min-sessions",
        "4",
        "--min-sessions=0001",
        "--search-dir=",
        "--search-dir=-draft",
        "--search-dir=a=b=c",
      ],
      actions,
    );
    await run(
      ["skills", "quarantine", "--skill", "first", "--skill=-x", "--skill-path=a=b", "--dry-run"],
      actions,
    );
    await run(["skills", "audit", `--min-sessions=${"9".repeat(400)}`], actions);
    await run(["skills", "restore", "--id", "first", "--id="], actions);

    expect(audits).toEqual([
      { minSessions: 1, inactiveDays: 30, searchDirs: ["", "-draft", "a=b=c"] },
      { minSessions: Infinity, inactiveDays: 30, searchDirs: [] },
    ]);
    expect(quarantines).toEqual([{ skill: "-x", skillPath: "a=b", approved: false, dryRun: true }]);
    expect(restores).toEqual([{ id: "", dryRun: false }]);
  });

  test("keeps parent help fail-open, parent -hh unknown, and leaf help strict", async () => {
    const actions = makeActions({});
    await run(["skills"], actions);
    await run(["skills", "--help", "--bogus"], actions);
    await run(["skills", "audit", "-hh"], actions);
    await run(["skills", "audit", "--help", "--min-sessions", "0"], actions);
    await run(["skills", "quarantine", "--help"], actions);

    const unknown = await Effect.runPromise(
      makeEffectCliTestProgram(["skills", "-hh"], { skillsActions: actions }).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(unknown).toMatchObject({
      code: "UNKNOWN_COMMAND",
      message: "Unknown skills subcommand: -hh",
    });

    const errors = await Promise.all(
      [
        ["skills", "audit", "--help", "--bad"],
        ["skills", "quarantined", "--help", "positional"],
        ["skills", "restore", "--help", "--unknown"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { skillsActions: actions }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INVALID_FLAG" }));
  });

  test("rejects invalid numbers and strict grammar before actions", async () => {
    const actions = makeActions({});
    const errors = await Promise.all(
      [
        ["skills", "audit", "--min-sessions=0"],
        ["skills", "audit", "--inactive-days=-1"],
        ["skills", "audit", "--min-sessions=1.5"],
        ["skills", "audit", "--min-sessions=1e2"],
        ["skills", "audit", "positional"],
        ["skills", "audit", "--json=true"],
        ["skills", "quarantine", "--no-json"],
        ["skills", "restore", "--id"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args, { skillsActions: actions }).pipe(
            Effect.provide(BunServices.layer),
            Effect.flip,
          ),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INVALID_FLAG" }));
  });

  test("preserves unknown-subcommand error identity", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["skills", "unknown", "ignored"], {
        skillsActions: makeActions({}),
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );
    expect(error).toMatchObject({
      code: "UNKNOWN_COMMAND",
      message: "Unknown skills subcommand: unknown",
      suggestion: "selftune skills --help",
    });
  });

  test("test programs fail closed for every operation", async () => {
    const errors = await Promise.all(
      [
        ["skills", "audit"],
        ["skills", "quarantined"],
        ["skills", "quarantine", "--skill", "demo", "--dry-run"],
        ["skills", "restore", "--id", "q-1"],
        ["skills", "consolidate", "--skill", "demo", "--dry-run"],
        ["skills", "consolidation-rollback", "--id", "decision-1", "--dry-run"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );
    errors.forEach((error) => expect(error).toMatchObject({ code: "INTERNAL_ERROR" }));
  });

  test("runtime programs preserve guard ordering and exact text and JSON formatting", () => {
    expect(() => runSkillsQuarantineProgram({ skill: "", approved: true })).toThrow(
      "--skill NAME is required.",
    );
    expect(() => runSkillsQuarantineProgram({ skill: "demo" })).toThrow(
      "Quarantine requires explicit approval through --yes.",
    );
    expect(() => runSkillsRestoreProgram({ id: "" })).toThrow("--id ID is required.");

    expect(formatSkillsAudit(auditResult, false)).toBe("Installed skill portfolio: 0 packages");
    expect(formatSkillsAudit(auditResult, true)).toBe(JSON.stringify(auditResult, null, 2));
    expect(formatSkillsQuarantined([], false)).toBe("No skills are currently quarantined.");
    expect(formatSkillsQuarantined([quarantineRecord], false)).toBe(
      "Quarantined skills: 1\n- demo (q-1)",
    );
    expect(formatSkillsReceipt(receipt, false)).toBe(
      "demo: quarantined\n  Quarantine ID: q-1\n  Undo: selftune skills restore --id q-1",
    );
    expect(formatSkillsReceipt(receipt, true)).toBe(JSON.stringify(receipt, null, 2));
    expect(formatSkillsConsolidation(consolidationResult, false)).toContain(
      "Undo: selftune skills consolidation-rollback --id decision-1 --yes --json",
    );
    expect(formatSkillsConsolidation(consolidationResult, true)).toBe(
      JSON.stringify(consolidationResult, null, 2),
    );
    expect(formatSkillsConsolidationRollback(rollbackResult, false)).toBe(
      "Consolidation rollback rolled_back: demo (decision-1).",
    );
    expect(formatSkillsConsolidationRollback(rollbackResult, true)).toBe(
      JSON.stringify(rollbackResult, null, 2),
    );
  });

  test("live actions lazy-load, preserve explicit JSON choice, and own output and exit", async () => {
    const loads: string[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const actions = makeLiveSkillsCommandActions({
      loadModule: async () => {
        loads.push("skills");
        return makeRuntimeModule({
          runSkillsAuditProgram: () => auditResult,
          formatSkillsAudit: (_result, json) => `audit:${json}`,
          runSkillsQuarantinedProgram: () => [quarantineRecord],
          formatSkillsQuarantined: (_records, json) => `quarantined:${json}`,
          runSkillsQuarantineProgram: () => receipt,
          runSkillsRestoreProgram: () => receipt,
          formatSkillsReceipt: (_result, json) => `receipt:${json}`,
          runSkillsConsolidateProgram: () => Effect.succeed(consolidationResult),
          formatSkillsConsolidation: (_result, json) => `consolidate:${json}`,
          runSkillsConsolidationRollbackProgram: () => Effect.succeed(rollbackResult),
          formatSkillsConsolidationRollback: (_result, json) => `rollback:${json}`,
        });
      },
      print: (message) => output.push(message),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Effect.runPromise(actions.audit({}, false));
    await Effect.runPromise(actions.quarantined(true));
    await Effect.runPromise(actions.quarantine({ skill: "demo", dryRun: true }, false));
    await Effect.runPromise(actions.restore({ id: "q-1" }, true));
    await Effect.runPromise(actions.consolidate({ skill: "demo", approved: true }, true));
    await Effect.runPromise(
      actions.consolidationRollback({ id: "decision-1", approved: true }, false),
    );

    expect(loads).toEqual(["skills", "skills", "skills", "skills", "skills", "skills"]);
    expect(output).toEqual([
      "audit:false",
      "quarantined:true",
      "receipt:false",
      "receipt:true",
      "consolidate:true",
      "rollback:false",
    ]);
    expect(exitCodes).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("uses the agent-contract no-op exit code when a skill is already consolidated", async () => {
    const exitCodes: number[] = [];
    const actions = makeLiveSkillsCommandActions({
      loadModule: async () =>
        makeRuntimeModule({
          runSkillsConsolidateProgram: () => Effect.succeed(alreadyConsolidatedResult),
          formatSkillsConsolidation: () => "already consolidated",
        }),
      print: () => {},
      setExitCode: (exitCode) => exitCodes.push(exitCode),
    });

    await Effect.runPromise(actions.consolidate({ skill: "demo", approved: true }, true));

    expect(exitCodes).toEqual([3]);
  });

  test("maps import, runtime, formatter, printer, and exit failures while preserving CLIError", async () => {
    const noOutput = { print: () => {}, setExitCode: () => {} };
    const importError = await Effect.runPromise(
      makeLiveSkillsCommandActions({
        ...noOutput,
        loadModule: async () => {
          throw new Error("missing module");
        },
      })
        .audit({}, false)
        .pipe(Effect.flip),
    );
    expect(importError).toMatchObject({ code: "INTERNAL_ERROR" });

    const sentinel = new CLIError("sentinel", "GUARD_BLOCKED", undefined, 2);
    const identity = await Effect.runPromise(
      makeLiveSkillsCommandActions({
        ...noOutput,
        loadModule: async () =>
          makeRuntimeModule({
            runSkillsAuditProgram: () => {
              throw sentinel;
            },
          }),
      })
        .audit({}, false)
        .pipe(Effect.flip),
    );
    expect(identity).toBe(sentinel);

    const errors = await Promise.all(
      [
        {
          module: makeRuntimeModule({
            runSkillsAuditProgram: () => auditResult,
            formatSkillsAudit: () => {
              throw new Error("format failed");
            },
          }),
          print: () => {},
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runSkillsAuditProgram: () => auditResult,
            formatSkillsAudit: () => "audit",
          }),
          print: () => {
            throw new Error("print failed");
          },
          setExitCode: () => {},
        },
        {
          module: makeRuntimeModule({
            runSkillsAuditProgram: () => auditResult,
            formatSkillsAudit: () => "audit",
          }),
          print: () => {},
          setExitCode: () => {
            throw new Error("exit failed");
          },
        },
      ].map((boundary) =>
        Effect.runPromise(
          makeLiveSkillsCommandActions({
            loadModule: async () => boundary.module,
            print: boundary.print,
            setExitCode: boundary.setExitCode,
          })
            .audit({}, false)
            .pipe(Effect.flip),
        ),
      ),
    );
    errors.forEach((error) =>
      expect(error).toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("Skills audit failed:"),
      }),
    );
  });

  test("is Effect-owned, absent from legacy routing, and owns its lazy module", () => {
    expect(isEffectCliInvocation("skills", [])).toBe(true);
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("skills");
    const source = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/effect-cli/commands/skills.ts"),
      "utf8",
    );
    expect(source).toContain('import("@selftune/runtime/skill-portfolio/programs")');
    expect(source).not.toMatch(/\bcliMain\b|process\.argv|process\.exit\s*\(/);
    expect(source).not.toMatch(/Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/);
  });
});
