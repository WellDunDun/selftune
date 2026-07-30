import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  SELFTUNE_CLOUD_SYNC_URL,
  syncDestinationCopy,
  syncDestinationFromUrl,
  syncDestinationName,
} from "../../apps/local-dashboard/src/lib/sync-destination.js";

describe("Sync & Backup destinations", () => {
  it("recognizes SelfTune Cloud endpoints", () => {
    expect(syncDestinationFromUrl(SELFTUNE_CLOUD_SYNC_URL)).toBe("cloud");
    expect(syncDestinationFromUrl("https://staging-api.selftune.dev")).toBe("cloud");
    expect(syncDestinationName("cloud")).toBe("SelfTune Cloud");
  });

  it("treats private endpoints as self-hosted", () => {
    expect(syncDestinationFromUrl("https://selftune.internal.example")).toBe("self_hosted");
    expect(syncDestinationFromUrl("http://localhost:8787")).toBe("self_hosted");
    expect(syncDestinationName("self_hosted")).toBe("self-hosted server");
  });

  it("defaults an unconfigured destination to SelfTune Cloud", () => {
    expect(syncDestinationFromUrl("")).toBe("cloud");
    expect(syncDestinationFromUrl("not a URL")).toBe("cloud");
  });

  it("uses the selected destination in connection, sync, and error copy", () => {
    expect(syncDestinationCopy("cloud")).toEqual({
      name: "SelfTune Cloud",
      connected: "Connected to SelfTune Cloud",
      notConnected: "Not connected to SelfTune Cloud",
      checking: "Checking SelfTune Cloud integrity...",
      unavailable: "SelfTune Cloud unavailable",
      synced: "Synced to SelfTune Cloud",
      connectFailed: "Could not connect to SelfTune Cloud",
      previewFailed: "Could not preview backup for SelfTune Cloud",
      syncFailed: "Could not sync to SelfTune Cloud",
    });
    expect(syncDestinationCopy("self_hosted")).toEqual({
      name: "self-hosted server",
      connected: "Connected to self-hosted server",
      notConnected: "Not connected to self-hosted server",
      checking: "Checking self-hosted server integrity...",
      unavailable: "self-hosted server unavailable",
      synced: "Synced to self-hosted server",
      connectFailed: "Could not connect to self-hosted server",
      previewFailed: "Could not preview backup for self-hosted server",
      syncFailed: "Could not sync to self-hosted server",
    });
  });

  it("keeps the Settings copy on the customer-facing mental model", () => {
    const settingsSource = readFileSync(
      new URL("../../apps/local-dashboard/src/pages/Settings.tsx", import.meta.url),
      "utf8",
    );
    expect(settingsSource).toContain("Your Library is local. Sync & Backup stores a copy");
    expect(settingsSource).toContain("Raw transcripts are never synced.");
    expect(settingsSource).not.toContain("Remote Library");
  });

  it("uses Sync & Backup in the exported agent-facing removal guidance", () => {
    const customerDocs = [
      new URL("../../skill/workflows/Uninstall.md", import.meta.url),
      new URL("../../skill/workflows/Service.md", import.meta.url),
      new URL("../../skill/references/cli-quick-reference.md", import.meta.url),
    ].map((url) => readFileSync(url, "utf8"));

    for (const document of customerDocs) {
      expect(document).toContain("Sync & Backup");
      expect(document).not.toContain("Remote Library");
    }
  });
});
