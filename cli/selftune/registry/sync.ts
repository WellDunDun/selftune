/**
 * selftune registry sync — Check for updates and pull latest versions.
 */

import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { registryRequest } from "./client.js";

interface LocalState {
  entryId: string;
  name: string;
  versionHash: string;
  installPath: string;
}

function getStatePath(): string {
  return join(process.env.HOME || "~", ".selftune", "registry-state.json");
}

async function loadState(): Promise<LocalState[]> {
  try {
    const raw = await readFile(getStatePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveState(state: LocalState[]): Promise<void> {
  await mkdir(join(process.env.HOME || "~", ".selftune"), { recursive: true });
  await writeFile(getStatePath(), JSON.stringify(state, null, 2));
}

export async function cliMain() {
  const state = await loadState();
  if (state.length === 0) {
    console.log(
      JSON.stringify({
        message: "No registry installations found. Use 'selftune registry install <name>' first.",
      }),
    );
    return;
  }

  // Check for updates
  const syncResult = await registryRequest<{
    entries: Array<{
      entry_id: string;
      name: string;
      has_update: boolean;
      latest_version: string;
      latest_content_hash: string;
      download_url?: string;
    }>;
  }>("POST", "/sync", {
    body: {
      installations: state.map((s) => ({
        entry_id: s.entryId,
        current_version_hash: s.versionHash,
      })),
    },
  });

  if (!syncResult.success) {
    console.error(JSON.stringify({ error: syncResult.error }));
    process.exit(1);
  }

  const updates = syncResult.data?.entries?.filter((e) => e.has_update) || [];
  if (updates.length === 0) {
    console.log(JSON.stringify({ message: "All installations up to date", count: state.length }));
    return;
  }

  console.log(`Found ${updates.length} update(s)...`);
  let synced = 0;
  let failed = 0;

  for (const update of updates) {
    if (!update.download_url) {
      failed++;
      continue;
    }

    const localEntry = state.find((s) => s.entryId === update.entry_id);
    if (!localEntry) {
      failed++;
      continue;
    }

    try {
      const response = await fetch(update.download_url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        failed++;
        continue;
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      const archivePath = `/tmp/selftune-sync-${Date.now()}.tar.gz`;
      await writeFile(archivePath, archiveBuffer);

      // Extract to existing install path
      const proc = Bun.spawn(["tar", "xzf", archivePath, "-C", localEntry.installPath], {
        stdout: "ignore",
        stderr: "pipe",
      });
      await proc.exited;
      await unlink(archivePath).catch(() => {});

      if (proc.exitCode === 0) {
        localEntry.versionHash = update.latest_content_hash;
        synced++;
        console.log(`  updated: ${update.name} -> v${update.latest_version}`);
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  await saveState(state);
  console.log(JSON.stringify({ synced, failed, total: state.length }));
}
