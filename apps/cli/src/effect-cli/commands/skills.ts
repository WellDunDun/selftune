import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { SKILLS_HELP } from "@selftune/runtime/skill-portfolio/help";
import type {
  RunSkillsAuditOptions,
  RunSkillsConsolidateOptions,
  RunSkillsConsolidationRollbackOptions,
  RunSkillsQuarantineOptions,
  RunSkillsRestoreOptions,
  SkillsConsolidationResult,
  SkillsConsolidationRollbackResult,
} from "@selftune/runtime/skill-portfolio/programs";
import type {
  PortfolioAuditResult,
  QuarantineReceipt,
  QuarantineRecord,
} from "@selftune/runtime/dashboard-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

import {
  SKILLS_INTERNAL_AUDIT_HELP_FLAG,
  SKILLS_INTERNAL_CONSOLIDATION_ROLLBACK_HELP_FLAG,
  SKILLS_INTERNAL_CONSOLIDATE_HELP_FLAG,
  SKILLS_INTERNAL_PARENT_HELP_FLAG,
  SKILLS_INTERNAL_QUARANTINED_HELP_FLAG,
  SKILLS_INTERNAL_QUARANTINE_HELP_FLAG,
  SKILLS_INTERNAL_RESTORE_HELP_FLAG,
  decodeSkillsInternalValue,
} from "../compatibility/skills.js";

export interface SkillsCommandActions {
  readonly audit: (options: RunSkillsAuditOptions, json: boolean) => Effect.Effect<void, CLIError>;
  readonly quarantined: (json: boolean) => Effect.Effect<void, CLIError>;
  readonly quarantine: (
    options: RunSkillsQuarantineOptions,
    json: boolean,
  ) => Effect.Effect<void, CLIError>;
  readonly restore: (
    options: RunSkillsRestoreOptions,
    json: boolean,
  ) => Effect.Effect<void, CLIError>;
  readonly consolidate: (
    options: RunSkillsConsolidateOptions,
    json: boolean,
  ) => Effect.Effect<void, CLIError>;
  readonly consolidationRollback: (
    options: RunSkillsConsolidationRollbackOptions,
    json: boolean,
  ) => Effect.Effect<void, CLIError>;
}

interface SkillsModule {
  readonly runSkillsAuditProgram: (options: RunSkillsAuditOptions) => PortfolioAuditResult;
  readonly formatSkillsAudit: (result: PortfolioAuditResult, json: boolean) => string;
  readonly runSkillsQuarantinedProgram: () => ReadonlyArray<QuarantineRecord>;
  readonly formatSkillsQuarantined: (
    records: ReadonlyArray<QuarantineRecord>,
    json: boolean,
  ) => string;
  readonly runSkillsQuarantineProgram: (options: RunSkillsQuarantineOptions) => QuarantineReceipt;
  readonly runSkillsRestoreProgram: (options: RunSkillsRestoreOptions) => QuarantineReceipt;
  readonly formatSkillsReceipt: (receipt: QuarantineReceipt, json: boolean) => string;
  readonly runSkillsConsolidateProgram: (
    options: RunSkillsConsolidateOptions,
  ) => Effect.Effect<SkillsConsolidationResult, CLIError>;
  readonly formatSkillsConsolidation: (result: SkillsConsolidationResult, json: boolean) => string;
  readonly runSkillsConsolidationRollbackProgram: (
    options: RunSkillsConsolidationRollbackOptions,
  ) => Effect.Effect<SkillsConsolidationRollbackResult, CLIError>;
  readonly formatSkillsConsolidationRollback: (
    result: SkillsConsolidationRollbackResult,
    json: boolean,
  ) => string;
}

export interface SkillsActionDependencies {
  readonly loadModule: () => Promise<SkillsModule>;
  readonly print: (message: string) => void;
  readonly setExitCode: (exitCode: number) => void;
}

const LIVE_DEPENDENCIES: SkillsActionDependencies = {
  loadModule: () => import("@selftune/runtime/skill-portfolio/programs"),
  print: (message) => process.stdout.write(`${message}\n`),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function importFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load skills support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

function toCliError(operation: string, cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Skills ${operation} failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        `selftune skills ${operation} --help`,
      );
}

function execute<Result>(
  operation: string,
  dependencies: SkillsActionDependencies,
  run: (runtime: SkillsModule) => Result,
  format: (runtime: SkillsModule, result: Result) => string,
) {
  return Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise({
      try: dependencies.loadModule,
      catch: importFailure,
    });
    const result = yield* Effect.try({
      try: () => run(runtime),
      catch: (cause) => toCliError(operation, cause),
    });
    const output = yield* Effect.try({
      try: () => format(runtime, result),
      catch: (cause) => toCliError(operation, cause),
    });
    yield* Effect.try({
      try: () => {
        dependencies.print(output);
        dependencies.setExitCode(0);
      },
      catch: (cause) => toCliError(operation, cause),
    });
  }).pipe(Effect.withSpan(`selftune.cli.skills.${operation}`));
}

export function makeLiveSkillsCommandActions(
  dependencies: SkillsActionDependencies = LIVE_DEPENDENCIES,
): SkillsCommandActions {
  return {
    audit: (options, json) =>
      execute(
        "audit",
        dependencies,
        (runtime) => runtime.runSkillsAuditProgram(options),
        (runtime, result) => runtime.formatSkillsAudit(result, json),
      ),
    quarantined: (json) =>
      execute(
        "quarantined",
        dependencies,
        (runtime) => runtime.runSkillsQuarantinedProgram(),
        (runtime, result) => runtime.formatSkillsQuarantined(result, json),
      ),
    quarantine: (options, json) =>
      execute(
        "quarantine",
        dependencies,
        (runtime) => runtime.runSkillsQuarantineProgram(options),
        (runtime, result) => runtime.formatSkillsReceipt(result, json),
      ),
    restore: (options, json) =>
      execute(
        "restore",
        dependencies,
        (runtime) => runtime.runSkillsRestoreProgram(options),
        (runtime, result) => runtime.formatSkillsReceipt(result, json),
      ),
    consolidate: (options, json) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.tryPromise({
          try: dependencies.loadModule,
          catch: importFailure,
        });
        const result = yield* runtime
          .runSkillsConsolidateProgram(options)
          .pipe(Effect.mapError((cause) => toCliError("consolidate", cause)));
        const output = yield* Effect.try({
          try: () => runtime.formatSkillsConsolidation(result, json),
          catch: (cause) => toCliError("consolidate", cause),
        });
        yield* Effect.try({
          try: () => {
            dependencies.print(output);
            dependencies.setExitCode(result.already_consolidated ? 3 : result.success ? 0 : 1);
          },
          catch: (cause) => toCliError("consolidate", cause),
        });
      }).pipe(Effect.withSpan("selftune.cli.skills.consolidate")),
    consolidationRollback: (options, json) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.tryPromise({
          try: dependencies.loadModule,
          catch: importFailure,
        });
        const result = yield* runtime
          .runSkillsConsolidationRollbackProgram(options)
          .pipe(Effect.mapError((cause) => toCliError("consolidation-rollback", cause)));
        const output = yield* Effect.try({
          try: () => runtime.formatSkillsConsolidationRollback(result, json),
          catch: (cause) => toCliError("consolidation-rollback", cause),
        });
        yield* Effect.try({
          try: () => {
            dependencies.print(output);
            dependencies.setExitCode(0);
          },
          catch: (cause) => toCliError("consolidation-rollback", cause),
        });
      }).pipe(Effect.withSpan("selftune.cli.skills.consolidationRollback")),
  };
}

function decode(value: Option.Option<string>): string | undefined {
  return decodeSkillsInternalValue(Option.getOrUndefined(value));
}

function decodeMany(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.map((value) => decodeSkillsInternalValue(value) ?? "");
}

export function makeSkillsCommand(actions: SkillsCommandActions = makeLiveSkillsCommandActions()) {
  const audit = Command.make(
    "audit",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_AUDIT_HELP_FLAG),
      minSessions: Flag.string("min-sessions").pipe(Flag.optional),
      inactiveDays: Flag.string("inactive-days").pipe(Flag.optional),
      searchDirs: Flag.string("search-dir").pipe(Flag.atLeast(0)),
      json: Flag.boolean("json"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SKILLS_HELP)
        : actions.audit(
            {
              minSessions: Number(decode(input.minSessions) ?? "20"),
              inactiveDays: Number(decode(input.inactiveDays) ?? "30"),
              searchDirs: decodeMany(input.searchDirs),
            },
            input.json,
          ),
  );
  const quarantined = Command.make(
    "quarantined",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_QUARANTINED_HELP_FLAG),
      json: Flag.boolean("json"),
    },
    (input) => (input.internalHelp ? Console.log(SKILLS_HELP) : actions.quarantined(input.json)),
  );
  const quarantine = Command.make(
    "quarantine",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_QUARANTINE_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
      skillPath: Flag.string("skill-path").pipe(Flag.optional),
      yes: Flag.boolean("yes"),
      dryRun: Flag.boolean("dry-run"),
      json: Flag.boolean("json"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SKILLS_HELP)
        : actions.quarantine(
            {
              skill: decode(input.skill),
              skillPath: decode(input.skillPath),
              approved: input.yes,
              dryRun: input.dryRun,
            },
            input.json,
          ),
  );
  const restore = Command.make(
    "restore",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_RESTORE_HELP_FLAG),
      quarantineId: Flag.string("id").pipe(Flag.optional),
      dryRun: Flag.boolean("dry-run"),
      json: Flag.boolean("json"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SKILLS_HELP)
        : actions.restore({ id: decode(input.quarantineId), dryRun: input.dryRun }, input.json),
  );
  const consolidate = Command.make(
    "consolidate",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_CONSOLIDATE_HELP_FLAG),
      skill: Flag.string("skill").pipe(Flag.optional),
      allSafe: Flag.boolean("all-safe"),
      searchDirs: Flag.string("search-dir").pipe(Flag.atLeast(0)),
      yes: Flag.boolean("yes"),
      dryRun: Flag.boolean("dry-run"),
      json: Flag.boolean("json"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SKILLS_HELP)
        : actions.consolidate(
            {
              skill: decode(input.skill),
              allSafe: input.allSafe,
              searchDirs: decodeMany(input.searchDirs),
              approved: input.yes,
              dryRun: input.dryRun,
            },
            input.json,
          ),
  );
  const consolidationRollback = Command.make(
    "consolidation-rollback",
    {
      internalHelp: Flag.boolean(SKILLS_INTERNAL_CONSOLIDATION_ROLLBACK_HELP_FLAG),
      decisionId: Flag.string("id").pipe(Flag.optional),
      yes: Flag.boolean("yes"),
      dryRun: Flag.boolean("dry-run"),
      json: Flag.boolean("json"),
    },
    (input) =>
      input.internalHelp
        ? Console.log(SKILLS_HELP)
        : actions.consolidationRollback(
            {
              id: decode(input.decisionId),
              approved: input.yes,
              dryRun: input.dryRun,
            },
            input.json,
          ),
  );

  return Command.make(
    "skills",
    { internalHelp: Flag.boolean(SKILLS_INTERNAL_PARENT_HELP_FLAG) },
    ({ internalHelp }) => (internalHelp ? Console.log(SKILLS_HELP) : Effect.void),
  ).pipe(
    Command.withSubcommands([
      audit,
      quarantined,
      quarantine,
      restore,
      consolidate,
      consolidationRollback,
    ]),
    Command.withDescription("Audit and manage the installed skill portfolio"),
  );
}
