/**
 * selftune registry install — Download and extract a skill from the registry.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { registryRequest } from "./client.js";

export async function cliMain() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--"));
  const globalFlag = args.includes("--global");

  if (!name) {
    console.error(
      JSON.stringify({
        error: "Usage: selftune registry install <name>",
        guidance: { next_command: "selftune registry list" },
      }),
    );
    process.exit(1);
  }

  // Find entry by name
  const listResult = await registryRequest<{
    entries: Array<{
      id: string;
      name: string;
      current_version?: { id: string; version: string; content_hash: string };
    }>;
  }>("GET", `?name=${encodeURIComponent(name)}`);

  if (!listResult.success || !listResult.data?.entries?.length) {
    console.error(
      JSON.stringify({
        error: `Skill '${name}' not found in registry`,
        guidance: { next_command: "selftune registry list" },
      }),
    );
    process.exit(1);
  }

  const entry = listResult.data.entries[0];
  const entryId = entry.id;

  // Get detail with versions
  const detailResult = await registryRequest<{
    entry: { id: string; name: string };
    versions: Array<{ id: string; version: string; content_hash: string; is_current: boolean }>;
  }>("GET", `/${entryId}`);

  if (!detailResult.success) {
    console.error(JSON.stringify({ error: detailResult.error }));
    process.exit(1);
  }

  const currentVersion = detailResult.data?.versions?.find((v) => v.is_current);
  if (!currentVersion) {
    console.error(JSON.stringify({ error: "No current version found" }));
    process.exit(1);
  }

  // Request presigned download via sync
  const syncResult = await registryRequest<{
    entries: Array<{
      download_url?: string;
      latest_version: string;
      latest_content_hash: string;
    }>;
  }>("POST", "/sync", {
    body: { installations: [{ entry_id: entryId, current_version_hash: "none" }] },
  });

  const downloadUrl = syncResult.data?.entries?.[0]?.download_url;
  if (!downloadUrl) {
    console.error(JSON.stringify({ error: "Could not get download URL" }));
    process.exit(1);
  }

  // Download archive
  console.log(`Installing ${name} v${currentVersion.version}...`);
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    console.error(JSON.stringify({ error: `Download failed: HTTP ${response.status}` }));
    process.exit(1);
  }
  const archiveBuffer = Buffer.from(await response.arrayBuffer());

  // Determine install path
  const targetBase = globalFlag
    ? join(process.env.HOME || "~", ".claude", "skills")
    : join(process.cwd(), ".claude", "skills");
  const targetDir = join(targetBase, name);

  // Extract archive
  await mkdir(targetDir, { recursive: true });
  const archivePath = `/tmp/selftune-install-${Date.now()}.tar.gz`;
  await writeFile(archivePath, archiveBuffer);
  const proc = Bun.spawn(["tar", "xzf", archivePath, "-C", targetDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await proc.exited;

  await unlink(archivePath).catch(() => {});

  if (proc.exitCode !== 0) {
    console.error(JSON.stringify({ error: "Failed to extract archive" }));
    process.exit(1);
  }

  // Record installation on server
  await registryRequest("POST", `/${entryId}/install`, {
    body: { install_path: targetDir, device_id: hostname() },
  });

  // Update local state
  const statePath = join(process.env.HOME || "~", ".selftune", "registry-state.json");
  let state: Array<{ entryId: string; name: string; versionHash: string; installPath: string }> =
    [];
  try {
    state = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {}
  state = state.filter((s) => s.entryId !== entryId);
  state.push({ entryId, name, versionHash: currentVersion.content_hash, installPath: targetDir });
  await mkdir(join(process.env.HOME || "~", ".selftune"), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));

  console.log(
    JSON.stringify({
      success: true,
      name,
      version: currentVersion.version,
      path: targetDir,
      global: globalFlag,
    }),
  );
}
