export {
  countSyncedRecords,
  createDefaultCliSetupCapabilities,
  type DefaultCliSetupCapabilitiesOptions,
  type HookInstallContext,
  type HookInstaller,
  type HookInstallers,
  type ScheduleInstallOutcome,
  type ScheduleInstallRequest,
  type ScheduleManager,
  type SetupCapabilities,
  type SetupInstallResult,
  type SourceSync,
} from "./capabilities.js";
export { convergeSetup, type SetupStepResult, type SetupStepStatus } from "./converge.js";
export {
  inspectSetupState,
  resolveSetupConfigPath,
  type SetupEnvironment,
  type SetupHarnessState,
  type SetupScheduleState,
  type SetupState,
} from "./inspect.js";
export {
  defaultSetupPlan,
  SETUP_HARNESS_IDS,
  type DefaultSetupPlanOptions,
  type HookHarnessId,
  type SetupHarnessId,
  type SetupPlan,
} from "./plan.js";
export {
  migrateLegacyOnboardingPreferences,
  type OnboardingMigrationResult,
} from "./preferences.js";
export {
  linkCloudAccount,
  type DeviceCodeTransport,
  type LinkCloudAccountDependencies,
  type LinkCloudAccountEvents,
  type LinkCloudAccountInput,
  type LinkCloudAccountResult,
} from "./link-account.js";
