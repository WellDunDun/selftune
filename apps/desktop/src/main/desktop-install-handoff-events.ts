import type {
  DesktopInstallBootstrapController,
  DesktopInstallHandoffIngestResult,
} from "./desktop-install-bootstrap";

interface DesktopInstallHandoffEventBridgeOptions {
  readonly controller: DesktopInstallBootstrapController;
  readonly show: () => void | Promise<void>;
}

interface PreventableOpenEvent {
  readonly preventDefault: () => void;
}

export interface DesktopInstallHandoffEventBridge {
  readonly coldStart: (argv: ReadonlyArray<string>) => DesktopInstallHandoffIngestResult;
  readonly markReady: () => void;
  readonly openUrl: (event: PreventableOpenEvent, url: string) => DesktopInstallHandoffIngestResult;
  readonly secondInstance: (argv: ReadonlyArray<string>) => DesktopInstallHandoffIngestResult;
}

export function createDesktopInstallHandoffEventBridge(
  options: DesktopInstallHandoffEventBridgeOptions,
): DesktopInstallHandoffEventBridge {
  let ready = false;
  let revealPending = false;
  const revealIfAccepted = (result: DesktopInstallHandoffIngestResult) => {
    if (result.accepted) {
      if (ready) void options.show();
      else revealPending = true;
    }
    return result;
  };
  return {
    coldStart: (argv) => revealIfAccepted(options.controller.ingestArgv(argv)),
    markReady() {
      ready = true;
      if (!revealPending) return;
      revealPending = false;
      void options.show();
    },
    openUrl(event, url) {
      event.preventDefault();
      return revealIfAccepted(options.controller.ingestUrl(url));
    },
    secondInstance: (argv) => revealIfAccepted(options.controller.ingestArgv(argv)),
  };
}
