import type {
  DashboardOverviewModule,
  DashboardPluginsModule,
  DashboardRecipientSharesModule,
  DashboardSkillSetsModule,
  DashboardSkillsModule,
  DashboardTeamCollaborationModule,
} from "./adapter";
import type { DashboardCapabilityModule } from "./capabilities";
import type { ServerProfileController } from "./server-profiles";

export interface DashboardChromeModule {
  readonly profiles?: ServerProfileController;
}

export interface DashboardHostModules {
  readonly capability: DashboardCapabilityModule;
  readonly skillSets: DashboardSkillSetsModule;
  readonly skills: DashboardSkillsModule;
  readonly plugins: DashboardPluginsModule;
  readonly recipientShares: DashboardRecipientSharesModule;
  readonly teamCollaboration: DashboardTeamCollaborationModule;
  readonly overview?: DashboardOverviewModule;
  readonly chrome?: DashboardChromeModule;
}
