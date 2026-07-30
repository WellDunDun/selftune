export const DEFAULT_DAEMON_PORT = 7888;

export type DaemonRuntimeMode = "standalone" | "dev-server" | "test";
export type DaemonRuntimeOwner = "desktop" | "cli";

export const SERVICE_INSTALLATION_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isServiceInstallationNonce(value: string): boolean {
  return SERVICE_INSTALLATION_NONCE_PATTERN.test(value);
}

export interface DaemonRunInput {
  readonly configDir?: string;
  readonly foreground: boolean;
  readonly hostname?: string;
  readonly owner?: DaemonRuntimeOwner;
  readonly port?: number;
  readonly readySentinel: boolean;
  readonly runtimeMode?: DaemonRuntimeMode;
  readonly serviceInstallationNonce?: string;
  readonly spaDir?: string;
  readonly supervised: boolean;
}

export interface DaemonStatusInput {
  readonly configDir?: string;
  readonly json: boolean;
}

export interface DaemonStopInput {
  readonly configDir?: string;
  readonly expectedInstanceId?: string;
  readonly expectedPid?: number;
}

export interface DaemonRotateTokenInput {
  readonly configDir?: string;
}
