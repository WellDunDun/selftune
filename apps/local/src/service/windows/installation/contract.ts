import type { AuthorityEvidence } from "../../authority/evidence.js";
import type { WindowsScheduledTaskState } from "../scheduler.js";
import type { WindowsServiceLegacyCleanupJournal } from "./legacy-cleanup.js";
import type {
  WindowsServiceInstallationArtifacts,
  WindowsServiceInstallationReceipt,
} from "./model.js";

export interface WindowsServiceLegacyRuntimeIdentity {
  readonly configDir: string;
  readonly executablePath: string;
  readonly owner: "cli" | "desktop";
  readonly port: number;
}

export interface WindowsServiceInstallationEvidenceBase {
  readonly currentUserSid: string;
  readonly task: WindowsScheduledTaskState;
}

export type WindowsServiceInstallationEvidence =
  | AuthorityEvidence<
      WindowsServiceInstallationEvidenceBase,
      { readonly receipt: WindowsServiceInstallationReceipt },
      {
        readonly artifacts: WindowsServiceInstallationArtifacts;
        readonly runtimeIdentity?: WindowsServiceLegacyRuntimeIdentity;
      },
      { readonly reason: string }
    >
  | (WindowsServiceInstallationEvidenceBase & {
      readonly _tag: "LegacyCleanupPending";
      readonly journal: WindowsServiceLegacyCleanupJournal;
    });
