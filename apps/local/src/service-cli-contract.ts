export const DEFAULT_SERVICE_PORT = 7888;

export type ServiceAction = "install" | "restart" | "start" | "status" | "stop" | "uninstall";

export type ServiceRuntimeOwner = "desktop" | "cli";

export interface ServiceInput {
  readonly boot: boolean;
  readonly configDir?: string;
  readonly executable?: string;
  readonly json: boolean;
  readonly owner?: ServiceRuntimeOwner;
  readonly port: number;
  readonly resourceDir?: string;
  readonly version?: string;
}
