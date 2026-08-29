import type {
  DesktopInstallBootstrapController,
  DesktopInstallHandoffIngestResult,
} from "./desktop-install-bootstrap";
import { parseDesktopPackHandoff } from "./desktop-pack-handoff";

interface DesktopInstallHandoffEventBridgeOptions {
  readonly controller: DesktopInstallBootstrapController;
  readonly trustedBuild: boolean;
  readonly show: () => void | Promise<void>;
  readonly openPack: (packUrl: string) => void | Promise<void>;
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
  let pendingPackUrl: string | null = null;
  let lastPackUrl: string | null = null;
  const revealIfAccepted = (result: DesktopInstallHandoffIngestResult) => {
    if (result.accepted) {
      if (ready) void options.show();
      else revealPending = true;
    }
    return result;
  };
  const ingestUrl = (url: string): DesktopInstallHandoffIngestResult => {
    const pack = parseDesktopPackHandoff(url);
    if (!pack) return revealIfAccepted(options.controller.ingestUrl(url));
    if (!options.trustedBuild) return { accepted: false, reason: "untrusted_build" };
    if (pack.packUrl === lastPackUrl) return { accepted: false, reason: "duplicate" };
    lastPackUrl = pack.packUrl;
    if (ready) void options.openPack(pack.packUrl);
    else pendingPackUrl = pack.packUrl;
    return { accepted: true };
  };
  const ingestArgv = (argv: ReadonlyArray<string>): DesktopInstallHandoffIngestResult => {
    const links = argv.filter((value) => value.startsWith("selftune://"));
    if (links.length > 1) return { accepted: false, reason: "multiple" };
    return links[0] ? ingestUrl(links[0]) : revealIfAccepted(options.controller.ingestArgv(argv));
  };
  return {
    coldStart: ingestArgv,
    markReady() {
      ready = true;
      if (pendingPackUrl) {
        const packUrl = pendingPackUrl;
        pendingPackUrl = null;
        void options.openPack(packUrl);
      }
      if (!revealPending) return;
      revealPending = false;
      void options.show();
    },
    openUrl(event, url) {
      event.preventDefault();
      return ingestUrl(url);
    },
    secondInstance: ingestArgv,
  };
}
