import type { SelfTuneDesktopBridge as NativeBridge, SelfTuneDesktopTestBridge } from "./index";

declare global {
  type SelfTuneBackgroundServiceState = Awaited<ReturnType<NativeBridge["getBackgroundService"]>>;

  interface SelfTuneDesktopBridge extends Pick<
    NativeBridge,
    | "getRuntime"
    | "focus"
    | "getBackgroundService"
    | "getThisMacProfile"
    | "openFolder"
    | "chooseFolder"
    | "openExternal"
    | "setBackgroundService"
  > {
    readonly getUpdateStatus?: NativeBridge["getUpdateStatus"];
    readonly checkForUpdates?: NativeBridge["checkForUpdates"];
  }

  interface Window {
    readonly selftuneDesktop?: SelfTuneDesktopBridge;
    readonly selftuneDesktopTest?: SelfTuneDesktopTestBridge;
  }
}
