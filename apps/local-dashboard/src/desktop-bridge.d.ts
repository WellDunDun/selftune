interface SelfTuneBackgroundServiceState {
  readonly detail: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly running: boolean;
  readonly supported: boolean;
}

interface SelfTuneDesktopBridge {
  readonly focus: () => Promise<void>;
  readonly getBackgroundService: () => Promise<SelfTuneBackgroundServiceState>;
  readonly getThisMacProfile: () => Promise<{
    readonly id: "local:this-mac";
    readonly kind: "local";
    readonly name: "This Mac";
    readonly origin: string;
  } | null>;
  readonly openFolder: (path: string) => Promise<void>;
  readonly chooseFolder: () => Promise<string | null>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly setBackgroundService: (enabled: boolean) => Promise<SelfTuneBackgroundServiceState>;
}

interface Window {
  readonly selftuneDesktop?: SelfTuneDesktopBridge;
}
