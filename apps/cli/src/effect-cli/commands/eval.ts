import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "@selftune/runtime/constants";
import type { EvalCommandRequest } from "@selftune/runtime/eval/cli-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export type EvalAction = (request: EvalCommandRequest) => Effect.Effect<void, CLIError>;

interface EvalModule {
  readonly runEvalProgram: (request: EvalCommandRequest) => Effect.Effect<void, unknown>;
}

export interface EvalActionDependencies {
  readonly loadModule: () => Promise<EvalModule>;
}

const LIVE_EVAL_DEPENDENCIES: EvalActionDependencies = {
  loadModule: () => import("@selftune/runtime/eval/programs"),
};

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function evalImportFailure(cause: unknown): CLIError {
  return new CLIError(
    `Unable to load eval support: ${failureMessage(cause)}`,
    "INTERNAL_ERROR",
    "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
  );
}

export function toEvalCliError(cause: unknown, action: EvalCommandRequest["action"]): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(failureMessage(cause), "OPERATION_FAILED", `selftune eval ${action} --help`);
}

export const runEvalActionWithDependencies = Effect.fn("selftune.cli.eval")(function* (
  request: EvalCommandRequest,
  dependencies: EvalActionDependencies,
) {
  const evalModule = yield* Effect.tryPromise({
    try: dependencies.loadModule,
    catch: evalImportFailure,
  });
  const program = yield* Effect.try({
    try: () => evalModule.runEvalProgram(request),
    catch: (cause) => toEvalCliError(cause, request.action),
  });
  yield* program.pipe(Effect.mapError((cause) => toEvalCliError(cause, request.action)));
});

export const runEvalAction: EvalAction = (request) =>
  runEvalActionWithDependencies(request, LIVE_EVAL_DEPENDENCIES);

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

export function makeEvalCommand(action: EvalAction = runEvalAction) {
  const generate = Command.make(
    "generate",
    {
      skill: optionalString("skill", "Skill name (required unless --list-skills)"),
      output: Flag.string("output").pipe(
        Flag.withAlias("out"),
        Flag.withDescription("Output file path (default: <skill>_trigger_eval.json)"),
        Flag.optional,
      ),
      agent: optionalString("agent", "Agent CLI for synthetic or blended generation"),
      max: Flag.string("max").pipe(
        Flag.withDescription("Maximum eval entries per side"),
        Flag.withDefault("50"),
      ),
      seed: Flag.string("seed").pipe(
        Flag.withDescription("Deterministic shuffle seed"),
        Flag.withDefault("42"),
      ),
      listSkills: Flag.boolean("list-skills").pipe(
        Flag.withDescription("List skills with trusted-vs-raw readiness counts"),
      ),
      stats: Flag.boolean("stats").pipe(
        Flag.withDescription("Show aggregate telemetry stats for the skill"),
      ),
      noNegatives: Flag.boolean("no-negatives").pipe(
        Flag.withDescription("Exclude negative examples from output"),
      ),
      noTaxonomy: Flag.boolean("no-taxonomy").pipe(
        Flag.withDescription("Skip invocation_type classification"),
      ),
      skillLog: Flag.string("skill-log").pipe(
        Flag.withDescription("Skill usage JSONL override"),
        Flag.withDefault(SKILL_LOG),
      ),
      queryLog: Flag.string("query-log").pipe(
        Flag.withDescription("Query log JSONL override"),
        Flag.withDefault(QUERY_LOG),
      ),
      telemetryLog: Flag.string("telemetry-log").pipe(
        Flag.withDescription("Session telemetry JSONL override"),
        Flag.withDefault(TELEMETRY_LOG),
      ),
      synthetic: Flag.boolean("synthetic").pipe(
        Flag.withDescription("Generate from SKILL.md instead of logs"),
      ),
      autoSynthetic: Flag.boolean("auto-synthetic").pipe(
        Flag.withDescription("Fall back to cold-start generation when trusted logs are sparse"),
      ),
      blend: Flag.boolean("blend").pipe(
        Flag.withDescription("Blend log-derived and synthetic eval entries"),
      ),
      skillPath: optionalString("skill-path", "Path to SKILL.md for synthetic generation"),
      model: optionalString("model", "Model override for synthetic generation"),
    },
    (input) =>
      action({
        action: "generate",
        input: {
          skill: Option.getOrUndefined(input.skill),
          output: Option.getOrUndefined(input.output),
          agent: Option.getOrUndefined(input.agent),
          max: input.max,
          seed: input.seed,
          listSkills: input.listSkills,
          stats: input.stats,
          noNegatives: input.noNegatives,
          noTaxonomy: input.noTaxonomy,
          skillLog: input.skillLog,
          queryLog: input.queryLog,
          telemetryLog: input.telemetryLog,
          synthetic: input.synthetic,
          autoSynthetic: input.autoSynthetic,
          blend: input.blend,
          skillPath: Option.getOrUndefined(input.skillPath),
          model: Option.getOrUndefined(input.model),
        },
      }),
  ).pipe(
    Command.withDescription("Build eval sets from logs or SKILL.md"),
    Command.withExamples([
      {
        command: "selftune eval generate --skill research",
        description: "Generate an eval set from observed sessions",
      },
      {
        command: "selftune eval generate --skill research --auto-synthetic --skill-path SKILL.md",
        description: "Use synthetic cold-start generation when telemetry is sparse",
      },
    ]),
  );

  const unitTest = Command.make(
    "unit-test",
    {
      skill: optionalString("skill", "Skill name (required)"),
      tests: optionalString("tests", "Unit-test JSON path"),
      runAgent: Flag.boolean("run-agent").pipe(
        Flag.withDescription("Run tests through an agent instead of static dry-run checks"),
      ),
      generate: Flag.boolean("generate").pipe(
        Flag.withDescription("Generate tests from skill content using an agent"),
      ),
      skillPath: optionalString("skill-path", "Skill file used for test generation"),
      evalSet: optionalString("eval-set", "Eval set used as failure context"),
      model: optionalString("model", "Model override for agent calls"),
    },
    (input) =>
      action({
        action: "unit-test",
        input: {
          skill: Option.getOrUndefined(input.skill),
          tests: Option.getOrUndefined(input.tests),
          runAgent: input.runAgent,
          generate: input.generate,
          skillPath: Option.getOrUndefined(input.skillPath),
          evalSet: Option.getOrUndefined(input.evalSet),
          model: Option.getOrUndefined(input.model),
        },
      }),
  ).pipe(Command.withDescription("Run or generate skill unit tests"));

  const run = Command.make(
    "run",
    {
      skillPath: optionalString("skill-path", "Skill directory or SKILL.md path (required)"),
      evals: optionalString("evals", "Override evals/evals.json"),
      workspace: optionalString("workspace", "Override the sibling evaluation workspace"),
      baselineSkillPath: optionalString(
        "baseline-skill-path",
        "Previous skill version to use as the baseline",
      ),
      feedback: optionalString("feedback", "Human feedback JSON to copy into the iteration"),
      agent: optionalString("agent", "Agent CLI for isolated runs and grading"),
      model: optionalString("model", "Model override"),
      json: Flag.boolean("json").pipe(Flag.withDescription("Print benchmark result as JSON")),
    },
    (input) =>
      action({
        action: "run",
        input: {
          skillPath: Option.getOrUndefined(input.skillPath),
          evals: Option.getOrUndefined(input.evals),
          workspace: Option.getOrUndefined(input.workspace),
          baselineSkillPath: Option.getOrUndefined(input.baselineSkillPath),
          feedback: Option.getOrUndefined(input.feedback),
          agent: Option.getOrUndefined(input.agent),
          model: Option.getOrUndefined(input.model),
          json: input.json,
        },
      }),
  ).pipe(Command.withDescription("Run paired Agent Skills output-quality evaluations"));

  const importSkillsBench = Command.make(
    "import",
    {
      dir: optionalString("dir", "SkillsBench corpus directory (required)"),
      skill: optionalString("skill", "Target skill name (required)"),
      output: optionalString("output", "Output eval-set JSON path"),
      matchStrategy: Flag.choice("match-strategy", ["exact", "fuzzy"]).pipe(
        Flag.withDescription("Task matching strategy"),
        Flag.withDefault("exact"),
      ),
    },
    (input) =>
      action({
        action: "import",
        input: {
          dir: Option.getOrUndefined(input.dir),
          skill: Option.getOrUndefined(input.skill),
          output: Option.getOrUndefined(input.output),
          matchStrategy: input.matchStrategy,
        },
      }),
  ).pipe(Command.withDescription("Import a SkillsBench task corpus as eval entries"));

  const composability = Command.make(
    "composability",
    {
      skill: optionalString("skill", "Skill name to analyze (required)"),
      window: optionalString("window", "Limit analysis to the newest positive number of sessions"),
      telemetryLog: optionalString(
        "telemetry-log",
        "Read session telemetry from a JSONL path instead of SQLite",
      ),
    },
    (input) =>
      action({
        action: "composability",
        input: {
          skill: Option.getOrUndefined(input.skill),
          window: Option.getOrUndefined(input.window),
          telemetryLog: Option.getOrUndefined(input.telemetryLog),
        },
      }),
  ).pipe(
    Command.withDescription("Analyze skill co-occurrence conflicts"),
    Command.withExamples([
      {
        command: "selftune eval composability --skill research --window 30",
        description: "Analyze the newest 30 sessions containing the research skill",
      },
    ]),
  );

  const familyOverlap = Command.make(
    "family-overlap",
    {
      prefix: optionalString("prefix", "Installed or observed skill-family prefix"),
      skills: optionalString("skills", "Comma-separated explicit skill names"),
      parentSkill: optionalString("parent-skill", "Override the inferred parent skill name"),
      minOverlap: optionalString("min-overlap", "Minimum overlap ratio from 0 through 1"),
      minShared: optionalString("min-shared", "Minimum positive integer shared-query count"),
    },
    (input) =>
      action({
        action: "family-overlap",
        input: {
          prefix: Option.getOrUndefined(input.prefix),
          skills: Option.getOrUndefined(input.skills),
          parentSkill: Option.getOrUndefined(input.parentSkill),
          minOverlap: Option.getOrUndefined(input.minOverlap),
          minShared: Option.getOrUndefined(input.minShared),
        },
      }),
  ).pipe(Command.withDescription("Detect sibling-skill overlap and consolidation pressure"));

  return Command.make("eval").pipe(
    Command.withSubcommands([
      generate,
      unitTest,
      run,
      importSkillsBench,
      composability,
      familyOverlap,
    ]),
    Command.withDescription(
      `Evaluation and testing tools

Actions: generate, unit-test, run, import, composability, family-overlap

Recommended creator loop:
  1. selftune eval generate --skill <name>
  2. selftune eval unit-test --skill <name> --generate --skill-path <path>
  3. selftune evolve --skill <name> --skill-path <path> --dry-run --validation-mode replay
  4. selftune grade baseline --skill <name> --skill-path <path>

Run 'selftune eval <action> --help' for action-specific options.`,
    ),
  );
}
