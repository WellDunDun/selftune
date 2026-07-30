import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import packageJson from "../../../../package.json" with { type: "json" };
import { CLIError } from "@selftune/runtime/utils/cli-error";
import { prepareEffectCliArguments } from "./argument-compatibility.js";
import type { AlphaCommandActions } from "./commands/alpha.js";
import type { BadgeAction } from "./commands/badge.js";
import type { ContributeAction } from "./commands/contribute.js";
import type { ContributionsCommandActions } from "./commands/contributions.js";
import type { CreatorContributionsCommandActions } from "./commands/creator-contributions.js";
import type { CreateCommandActions } from "./commands/create.js";
import type { DashboardAction } from "./commands/dashboard.js";
import type { DaemonCommandActions } from "./commands/daemon.js";
import type { EvalAction } from "./commands/eval.js";
import type { ExportAction } from "./commands/export.js";
import type { QuickstartAction } from "./commands/quickstart.js";
import type { PublishAction } from "./commands/publish.js";
import type { ProjectAction } from "./commands/project.js";
import type { LibraryAction } from "./commands/library.js";
import type { ReadOnlyCommandActions } from "./commands/read-only.js";
import type { RecoverAction } from "./commands/recover.js";
import type { RegistryAction } from "./commands/registry.js";
import type { ServiceCommandActions } from "./commands/service.js";
import type { SkillSetsAction } from "./commands/sets.js";
import type { SkillsCommandActions } from "./commands/skills.js";
import type { SyncAction } from "./commands/sync.js";
import type { WatchAction } from "./commands/watch.js";
import type { TelemetryCommandAction } from "./commands/telemetry.js";
import type { UninstallAction } from "./commands/uninstall.js";
import type { VerifyAction } from "./commands/verify.js";
import type { WorkflowsAction } from "./commands/workflows.js";
import { makeEffectCommandRoot } from "./root-command.js";

const liveEffectCommandRoot = makeEffectCommandRoot();

const runLiveCommand = Command.runWith(liveEffectCommandRoot, {
  version: packageJson.version,
});

export const makeEffectCliProgram = Effect.fn("selftune.cli.program")(function* (
  args: ReadonlyArray<string>,
) {
  const preparedArgs = yield* prepareEffectCliArguments(args);
  yield* runLiveCommand(preparedArgs);
});

export interface EffectCliTestProgramOptions {
  readonly alphaActions?: AlphaCommandActions;
  readonly badgeAction?: BadgeAction;
  readonly contributeAction?: ContributeAction;
  readonly contributionsActions?: ContributionsCommandActions;
  readonly creatorContributionsActions?: CreatorContributionsCommandActions;
  readonly createActions?: CreateCommandActions;
  readonly dashboardAction?: DashboardAction;
  readonly daemonActions?: DaemonCommandActions;
  readonly evalAction?: EvalAction;
  readonly exportAction?: ExportAction;
  readonly quickstartAction?: QuickstartAction;
  readonly publishAction?: PublishAction;
  readonly projectAction?: ProjectAction;
  readonly readOnlyActions?: ReadOnlyCommandActions;
  readonly libraryAction?: LibraryAction;
  readonly recoverAction?: RecoverAction;
  readonly registryAction?: RegistryAction;
  readonly serviceActions?: ServiceCommandActions;
  readonly skillSetsAction?: SkillSetsAction;
  readonly skillsActions?: SkillsCommandActions;
  readonly syncAction?: SyncAction;
  readonly watchAction?: WatchAction;
  readonly telemetryAction?: TelemetryCommandAction;
  readonly uninstallAction?: UninstallAction;
  readonly verifyAction?: VerifyAction;
  readonly workflowsAction?: WorkflowsAction;
}

const disabledTestAlphaAction = (action: keyof AlphaCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live alpha ${action} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestAlphaActions: AlphaCommandActions = {
  upload: disabledTestAlphaAction("upload"),
  relink: disabledTestAlphaAction("relink"),
};

const disabledTestBadgeAction: BadgeAction = () =>
  Effect.fail(
    new CLIError(
      "Live badge generation is disabled in the Effect CLI test program.",
      "INTERNAL_ERROR",
    ),
  );

const disabledTestContributeAction: ContributeAction = () =>
  Effect.fail(
    new CLIError("Live contribute is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestContributionsAction = (operation: keyof ContributionsCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live contributions ${operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestContributionsActions: ContributionsCommandActions = {
  status: disabledTestContributionsAction("status"),
  preview: disabledTestContributionsAction("preview"),
  approve: disabledTestContributionsAction("approve"),
  revoke: disabledTestContributionsAction("revoke"),
  setDefault: disabledTestContributionsAction("setDefault"),
  upload: disabledTestContributionsAction("upload"),
  reset: disabledTestContributionsAction("reset"),
};

const disabledTestCreatorContributionsAction =
  (operation: keyof CreatorContributionsCommandActions) => () =>
    Effect.fail(
      new CLIError(
        `Live creator contributions ${operation} is disabled in the Effect CLI test program.`,
        "INTERNAL_ERROR",
      ),
    );

const disabledTestCreatorContributionsActions: CreatorContributionsCommandActions = {
  status: disabledTestCreatorContributionsAction("status"),
  enable: disabledTestCreatorContributionsAction("enable"),
  disable: disabledTestCreatorContributionsAction("disable"),
};

const disabledTestDashboardAction: DashboardAction = () =>
  Effect.fail(
    new CLIError("Live dashboard is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestCreateAction = (action: keyof CreateCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live create ${action} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestCreateActions: CreateCommandActions = {
  init: disabledTestCreateAction("init"),
  status: disabledTestCreateAction("status"),
  scaffold: disabledTestCreateAction("scaffold"),
  check: disabledTestCreateAction("check"),
  replay: disabledTestCreateAction("replay"),
  baseline: disabledTestCreateAction("baseline"),
  report: disabledTestCreateAction("report"),
  publish: disabledTestCreateAction("publish"),
};

const disabledTestDaemonAction = (action: keyof DaemonCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live daemon ${action} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestDaemonActions: DaemonCommandActions = {
  run: disabledTestDaemonAction("run"),
  status: disabledTestDaemonAction("status"),
  stop: disabledTestDaemonAction("stop"),
  rotateToken: disabledTestDaemonAction("rotateToken"),
};

const disabledTestEvalAction: EvalAction = () =>
  Effect.fail(
    new CLIError("Live eval is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestExportAction: ExportAction = () =>
  Effect.fail(
    new CLIError("Live export is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestQuickstartAction: QuickstartAction = () =>
  Effect.fail(
    new CLIError("Live quickstart is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestPublishAction: PublishAction = () =>
  Effect.fail(
    new CLIError("Live publish is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestProjectAction: ProjectAction = (operation) =>
  Effect.fail(
    new CLIError(
      `Live project ${operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestReadOnlyAction = (command: keyof ReadOnlyCommandActions) => () =>
  Effect.fail(
    new CLIError(`Live ${command} is disabled in the Effect CLI test program.`, "INTERNAL_ERROR"),
  );

const disabledTestReadOnlyActions: ReadOnlyCommandActions = {
  doctor: disabledTestReadOnlyAction("doctor"),
  status: disabledTestReadOnlyAction("status"),
  last: disabledTestReadOnlyAction("last"),
};

const disabledTestRecoverAction: RecoverAction = () =>
  Effect.fail(
    new CLIError("Live recovery is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestRegistryAction: RegistryAction = (input) =>
  Effect.fail(
    new CLIError(
      `Live registry ${input.operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestServiceAction = (action: keyof ServiceCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live service ${action} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestServiceActions: ServiceCommandActions = {
  install: disabledTestServiceAction("install"),
  maintenance: disabledTestServiceAction("maintenance"),
  status: disabledTestServiceAction("status"),
  start: disabledTestServiceAction("start"),
  stop: disabledTestServiceAction("stop"),
  restart: disabledTestServiceAction("restart"),
  uninstall: disabledTestServiceAction("uninstall"),
};

const disabledTestSkillsAction = (operation: keyof SkillsCommandActions) => () =>
  Effect.fail(
    new CLIError(
      `Live skills ${operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestSkillsActions: SkillsCommandActions = {
  audit: disabledTestSkillsAction("audit"),
  quarantined: disabledTestSkillsAction("quarantined"),
  quarantine: disabledTestSkillsAction("quarantine"),
  restore: disabledTestSkillsAction("restore"),
  consolidate: disabledTestSkillsAction("consolidate"),
  consolidationRollback: disabledTestSkillsAction("consolidationRollback"),
};

const disabledTestSkillSetsAction: SkillSetsAction = (input) =>
  Effect.fail(
    new CLIError(
      `Live Skill Sets ${input.operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestSyncAction: SyncAction = () =>
  Effect.fail(
    new CLIError("Live sync is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestWatchAction: WatchAction = () =>
  Effect.fail(
    new CLIError("Live watch is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestLibraryAction: LibraryAction = (input) =>
  Effect.fail(
    new CLIError(
      `Live Skill Library ${input.operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

const disabledTestTelemetryAction: TelemetryCommandAction = () =>
  Effect.fail(
    new CLIError(
      "Live telemetry changes are disabled in the Effect CLI test program.",
      "INTERNAL_ERROR",
    ),
  );

const disabledTestUninstallAction: UninstallAction = () =>
  Effect.fail(
    new CLIError("Live uninstall is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestVerifyAction: VerifyAction = () =>
  Effect.fail(
    new CLIError("Live verify is disabled in the Effect CLI test program.", "INTERNAL_ERROR"),
  );

const disabledTestWorkflowsAction: WorkflowsAction = (input) =>
  Effect.fail(
    new CLIError(
      `Live workflows ${input.operation} is disabled in the Effect CLI test program.`,
      "INTERNAL_ERROR",
    ),
  );

export function makeEffectCliTestProgram(
  args: ReadonlyArray<string>,
  options: EffectCliTestProgramOptions = {},
) {
  const runTestCommand = Command.runWith(
    makeEffectCommandRoot({
      alphaActions: options.alphaActions ?? disabledTestAlphaActions,
      badgeAction: options.badgeAction ?? disabledTestBadgeAction,
      contributeAction: options.contributeAction ?? disabledTestContributeAction,
      contributionsActions: options.contributionsActions ?? disabledTestContributionsActions,
      creatorContributionsActions:
        options.creatorContributionsActions ?? disabledTestCreatorContributionsActions,
      createActions: options.createActions ?? disabledTestCreateActions,
      dashboardAction: options.dashboardAction ?? disabledTestDashboardAction,
      daemonActions: options.daemonActions ?? disabledTestDaemonActions,
      evalAction: options.evalAction ?? disabledTestEvalAction,
      exportAction: options.exportAction ?? disabledTestExportAction,
      quickstartAction: options.quickstartAction ?? disabledTestQuickstartAction,
      publishAction: options.publishAction ?? disabledTestPublishAction,
      projectAction: options.projectAction ?? disabledTestProjectAction,
      readOnlyActions: options.readOnlyActions ?? disabledTestReadOnlyActions,
      libraryAction: options.libraryAction ?? disabledTestLibraryAction,
      recoverAction: options.recoverAction ?? disabledTestRecoverAction,
      registryAction: options.registryAction ?? disabledTestRegistryAction,
      serviceActions: options.serviceActions ?? disabledTestServiceActions,
      skillSetsAction: options.skillSetsAction ?? disabledTestSkillSetsAction,
      skillsActions: options.skillsActions ?? disabledTestSkillsActions,
      syncAction: options.syncAction ?? disabledTestSyncAction,
      watchAction: options.watchAction ?? disabledTestWatchAction,
      telemetryAction: options.telemetryAction ?? disabledTestTelemetryAction,
      uninstallAction: options.uninstallAction ?? disabledTestUninstallAction,
      verifyAction: options.verifyAction ?? disabledTestVerifyAction,
      workflowsAction: options.workflowsAction ?? disabledTestWorkflowsAction,
    }),
    { version: packageJson.version },
  );
  return Effect.gen(function* () {
    const preparedArgs = yield* prepareEffectCliArguments(args);
    yield* runTestCommand(preparedArgs).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
  });
}
