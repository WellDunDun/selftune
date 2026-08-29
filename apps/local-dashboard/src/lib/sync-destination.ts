export const SELFTUNE_CLOUD_SYNC_URL = "https://cloud.selftune.dev";

export type SyncDestination = "cloud" | "self_hosted";

export interface SyncDestinationCopy {
  readonly name: string;
  readonly connected: string;
  readonly notConnected: string;
  readonly checking: string;
  readonly unavailable: string;
  readonly synced: string;
  readonly connectFailed: string;
  readonly previewFailed: string;
  readonly syncFailed: string;
}

export function syncDestinationFromUrl(url: string): SyncDestination {
  if (!url.trim()) return "cloud";
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "cloud.selftune.dev" || hostname === "api.selftune.dev"
      ? "cloud"
      : "self_hosted";
  } catch {
    return "cloud";
  }
}

export function syncDestinationName(destination: SyncDestination): string {
  return destination === "cloud" ? "SelfTune Cloud" : "self-hosted server";
}

export function syncDestinationCopy(destination: SyncDestination): SyncDestinationCopy {
  const name = syncDestinationName(destination);
  return {
    name,
    connected: `Connected to ${name}`,
    notConnected: `Not connected to ${name}`,
    checking: `Checking ${name} integrity...`,
    unavailable: `${name} unavailable`,
    synced: destination === "cloud" ? "Cloud inventory updated" : `Synced to ${name}`,
    connectFailed: `Could not connect to ${name}`,
    previewFailed:
      destination === "cloud"
        ? "Could not inspect the local inventory"
        : `Could not preview backup for ${name}`,
    syncFailed:
      destination === "cloud"
        ? "Could not update the Cloud inventory"
        : `Could not sync to ${name}`,
  };
}
