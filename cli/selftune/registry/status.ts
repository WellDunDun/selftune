/**
 * selftune registry status — Show installed entries and version drift.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { registryRequest } from "./client.js";

export async function cliMain() {
  const statePath = join(process.env.HOME || "~", ".selftune", "registry-state.json");
  let state: Array<{ entryId: string; name: string; versionHash: string; installPath: string }>;
  try {
    state = JSON.parse(await readFile(statePath, "utf-8"));
  } catch {
    console.log(JSON.stringify({ message: "No registry installations found." }));
    return;
  }

  if (state.length === 0) {
    console.log(JSON.stringify({ message: "No registry installations found." }));
    return;
  }

  const syncResult = await registryRequest<{
    entries: Array<{
      entry_id: string;
      name: string;
      has_update: boolean;
      latest_version: string;
      current_version: string;
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

  const entries = syncResult.data?.entries || [];
  const table = entries.map((e) => ({
    name: e.name,
    installed: e.current_version,
    latest: e.latest_version,
    status: e.has_update ? "behind" : "up-to-date",
  }));

  console.log(
    JSON.stringify({
      installations: table,
      total: state.length,
      updates_available: entries.filter((e) => e.has_update).length,
    }),
  );
}
