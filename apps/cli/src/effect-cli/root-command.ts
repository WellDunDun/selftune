import * as Command from "effect/unstable/cli/Command";

import { makeAlphaCommand, type AlphaCommandActions } from "./commands/alpha.js";
import { makeBadgeCommand, type BadgeAction } from "./commands/badge.js";
import { makeContributeCommand, type ContributeAction } from "./commands/contribute.js";
import {
  makeContributionsCommand,
  type ContributionsCommandActions,
} from "./commands/contributions.js";
import {
  makeCreatorContributionsCommand,
  type CreatorContributionsCommandActions,
} from "./commands/creator-contributions.js";
import { makeCreateCommand, type CreateCommandActions } from "./commands/create.js";
import { makeDashboardCommand, type DashboardAction } from "./commands/dashboard.js";
import { makeDaemonCommand, type DaemonCommandActions } from "./commands/daemon.js";
import { makeExportCommand, type ExportAction } from "./commands/export.js";
import { makeEvalCommand, type EvalAction } from "./commands/eval.js";
import { makeQuickstartCommand, type QuickstartAction } from "./commands/quickstart.js";
import { makePublishCommand, type PublishAction } from "./commands/publish.js";
import { makeProjectCommand, type ProjectAction } from "./commands/project.js";
import { makeLibraryCommand, type LibraryAction } from "./commands/library.js";
import { makeReadOnlyCommands, type ReadOnlyCommandActions } from "./commands/read-only.js";
import { makeRecoverCommand, type RecoverAction } from "./commands/recover.js";
import { makeRegistryCommand, type RegistryAction } from "./commands/registry.js";
import { makeServiceCommand, type ServiceCommandActions } from "./commands/service.js";
import { makeSkillSetsCommand, type SkillSetsAction } from "./commands/sets.js";
import { makeSkillsCommand, type SkillsCommandActions } from "./commands/skills.js";
import { makeSyncCommand, type SyncAction } from "./commands/sync.js";
import { makeWatchCommand, type WatchAction } from "./commands/watch.js";
import { makeTelemetryCommand, type TelemetryCommandAction } from "./commands/telemetry.js";
import { makeUninstallCommand, type UninstallAction } from "./commands/uninstall.js";
import { makeVerifyCommand, type VerifyAction } from "./commands/verify.js";
import { makeWorkflowsCommand, type WorkflowsAction } from "./commands/workflows.js";

export interface EffectCommandRootOptions {
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

export function makeEffectCommandRoot(options: EffectCommandRootOptions = {}) {
  const { doctorCommand, statusCommand, lastCommand } = makeReadOnlyCommands(
    options.readOnlyActions,
  );

  return Command.make("selftune").pipe(
    Command.withSubcommands([
      doctorCommand,
      statusCommand,
      lastCommand,
      makeTelemetryCommand(options.telemetryAction),
      makeRecoverCommand(options.recoverAction),
      makeRegistryCommand(options.registryAction),
      makeBadgeCommand(options.badgeAction),
      makeContributeCommand(options.contributeAction),
      makeContributionsCommand(options.contributionsActions),
      makeCreatorContributionsCommand(options.creatorContributionsActions),
      makeCreateCommand(options.createActions),
      makeExportCommand(options.exportAction),
      makeEvalCommand(options.evalAction),
      makeAlphaCommand(options.alphaActions),
      makeDashboardCommand(options.dashboardAction),
      makeLibraryCommand(options.libraryAction),
      makeDaemonCommand(options.daemonActions),
      makeServiceCommand(options.serviceActions),
      makeSkillSetsCommand(options.skillSetsAction),
      makeSkillsCommand(options.skillsActions),
      makeSyncCommand(options.syncAction),
      makeWatchCommand(options.watchAction),
      makeQuickstartCommand(options.quickstartAction),
      makePublishCommand(options.publishAction),
      makeProjectCommand(options.projectAction),
      makeUninstallCommand(options.uninstallAction),
      makeVerifyCommand(options.verifyAction),
      makeWorkflowsCommand(options.workflowsAction),
    ]),
    Command.withDescription("SelfTune migrated commands"),
  );
}
