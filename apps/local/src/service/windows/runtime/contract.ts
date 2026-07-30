export type WindowsRejectedListenerReason =
  | "invalid-pid"
  | "non-loopback-binding"
  | "wildcard-binding";

export type WindowsListenerRecoveryRefusal =
  | "ambiguous-pids"
  | "authenticated-pid-mismatch"
  | "authenticated-port-mismatch"
  | WindowsRejectedListenerReason;

export type WindowsRuntimeAuthorization =
  | {
      readonly _tag: "NonceBound";
      readonly configDir: string;
      readonly executablePath: string;
      readonly installationNonce: string;
      readonly owner: "cli" | "desktop";
      readonly port: number;
    }
  | {
      readonly _tag: "ExactLegacy";
      readonly configDir: string;
      readonly executablePath: string;
      readonly owner: "cli" | "desktop";
      readonly port: number;
    };

export type WindowsShutdownRequestOutcome =
  | "accepted"
  | "instance-mismatch"
  | "rejected"
  | "transport-ambiguous";

export type WindowsAuthenticatedRecoveryRefusal =
  | "health-config-mismatch"
  | "health-executable-missing"
  | "health-executable-mismatch"
  | "health-host-mismatch"
  | "health-instance-id-mismatch"
  | "health-instance-id-missing"
  | "health-installation-nonce-mismatch"
  | "health-installation-nonce-missing"
  | "health-installation-nonce-unexpected"
  | "health-invalid"
  | "health-mode-mismatch"
  | "health-owner-missing"
  | "health-owner-mismatch"
  | "health-pid-mismatch"
  | "health-port-mismatch"
  | "health-service-mismatch"
  | "health-supervision-mismatch"
  | "health-unavailable"
  | "listener-changed-during-verification"
  | "listener-changed-after-termination"
  | "listener-release-timeout"
  | "listener-still-present"
  | "missing-auth-token"
  | "shutdown-refused"
  | WindowsListenerRecoveryRefusal;

export type WindowsListenerRecoveryOutcome =
  | {
      readonly outcome: "absent";
      readonly port: number;
    }
  | {
      readonly instanceId: string;
      readonly outcome: "stopped";
      readonly pid: number;
      readonly port: number;
    }
  | {
      readonly candidatePids: ReadonlyArray<number>;
      readonly outcome: "refused";
      readonly port: number;
      readonly reason: WindowsAuthenticatedRecoveryRefusal;
    };

export type WindowsRuntimeReadiness =
  | {
      readonly _tag: "Ready";
      readonly instanceId: string;
      readonly owner: "cli" | "desktop";
      readonly ownerExecutablePath: string;
      readonly ownerVersion: string;
      readonly pid: number;
      readonly port: number;
    }
  | {
      readonly _tag: "NotReady";
      readonly candidatePids: ReadonlyArray<number>;
      readonly port: number;
      readonly reason: WindowsAuthenticatedRecoveryRefusal | "listener-absent";
    };
