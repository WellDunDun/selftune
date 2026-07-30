export const DEFAULT_DASHBOARD_PORT = 3141;

export interface DashboardInput {
  readonly openBrowser: boolean;
  readonly port: number;
  readonly removedExport: boolean;
  readonly removedOut: boolean;
  readonly restart: boolean;
  readonly serve: boolean;
}
