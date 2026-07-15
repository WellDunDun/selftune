interface SelfTuneBackgroundServiceState {
  readonly detail: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly running: boolean;
  readonly supported: boolean;
}

interface SelfTuneDesktopBridge {
  readonly getBackgroundService: () => Promise<SelfTuneBackgroundServiceState>;
  readonly openFolder: (path: string) => Promise<void>;
  readonly setBackgroundService: (enabled: boolean) => Promise<SelfTuneBackgroundServiceState>;
}

interface Window {
  readonly selftuneDesktop?: SelfTuneDesktopBridge;
}
