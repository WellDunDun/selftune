export type ServiceMaintenanceAction = "doctor" | "repair-lock";

export interface ServiceMaintenanceInput {
  readonly json: boolean;
}

export type ServiceLockDiagnosticState =
  | "changed_during_inspection"
  | "fenced"
  | "invalid_blocking_file"
  | "legacy_active_or_unverifiable"
  | "legacy_stale_repairable"
  | "not_applicable"
  | "ready_to_fence";

export interface ServiceLockDiagnostic {
  readonly pid?: number;
  readonly reason?: string;
  readonly repairable: boolean;
  readonly retryable?: boolean;
  readonly startedAt?: string;
  readonly state: ServiceLockDiagnosticState;
}

export interface ServiceMaintenanceResponse {
  readonly action: ServiceMaintenanceAction;
  readonly diagnostic: ServiceLockDiagnostic;
  readonly ok: boolean;
  readonly platform: NodeJS.Platform;
  readonly result?: "already_fenced" | "not_needed" | "repaired";
}
