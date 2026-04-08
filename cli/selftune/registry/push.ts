/**
 * selftune registry push — Archive and upload a skill folder as a new version.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { registryRequest } from "./client.js";

interface FileManifestEntry {
  path: string;
  hash: string;
  size: number;
}

async function collectFiles(
  dir: string,
  base?: string,
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = base ? join(base, entry.name) : entry.name;
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".env" ||
      entry.name.startsWith(".env.")
    )
      continue;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relPath)));
    } else {
      files.push({ path: relPath, content: await readFile(fullPath) });
    }
  }
  return files;
}

export async function cliMain() {
  const args = process.argv.slice(2);
  const nameArg = args.find((a) => !a.startsWith("--"));
  const versionFlag = args.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  const summaryFlag = args.find((a) => a.startsWith("--summary="))?.slice("--summary=".length);

  // Find skill folder
  const cwd = process.cwd();
  const skillMd = join(cwd, "SKILL.md");
  try {
    await stat(skillMd);
  } catch {
    console.error(
      JSON.stringify({
        error: "No SKILL.md found in current directory. Navigate to a skill folder first.",
        guidance: { next_command: "cd <skill-directory>" },
      }),
    );
    process.exit(1);
  }

  // Read SKILL.md to extract name and description
  const skillContent = await readFile(skillMd, "utf-8");
  const nameMatch = skillContent.match(/^name:\s*(.+)$/m);
  const descMatch = skillContent.match(/^description:\s*(.+)$/m);
  const name = nameArg || nameMatch?.[1]?.trim() || "unnamed-skill";
  const description = descMatch?.[1]?.trim() || "";

  // Collect all files
  const files = await collectFiles(cwd);
  const manifest: FileManifestEntry[] = files.map((f) => ({
    path: f.path,
    hash: createHash("sha256").update(f.content).digest("hex"),
    size: f.content.length,
  }));

  // Create tar.gz archive using system tar (available on all platforms)
  const archivePath = `/tmp/selftune-registry-${Date.now()}.tar.gz`;
  const proc = Bun.spawn(
    [
      "tar",
      "czf",
      archivePath,
      "-C",
      cwd,
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=.env",
      "--exclude=.env.*",
      ".",
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.error(JSON.stringify({ error: "Failed to create archive" }));
    process.exit(1);
  }
  const archiveBuffer = await readFile(archivePath);
  const archiveHash = createHash("sha256").update(archiveBuffer).digest("hex");

  // Clean up temp file
  await unlink(archivePath).catch(() => {});

  // Determine version
  const version = versionFlag || `0.1.${Date.now()}`;

  // Build multipart form
  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      name,
      entry_type: "skill",
      description,
      version,
      change_summary: summaryFlag || undefined,
      file_manifest: manifest,
      content_hash: archiveHash,
    }),
  );
  formData.append(
    "archive",
    new Blob([archiveBuffer], { type: "application/gzip" }),
    `${name}.tar.gz`,
  );

  // Try to push as new version first, fall back to create
  console.log(
    `Pushing ${name} v${version} (${(archiveBuffer.length / 1024).toFixed(1)} KB, ${files.length} files)...`,
  );

  // First check if entry exists
  const listResult = await registryRequest<{ entries: Array<{ id: string; name: string }> }>(
    "GET",
    `?name=${encodeURIComponent(name)}`,
  );

  let result;
  if (listResult.success && listResult.data?.entries?.length) {
    const entryId = listResult.data.entries[0].id;
    result = await registryRequest("POST", `/${entryId}/versions`, { formData });
  } else {
    result = await registryRequest("POST", "", { formData });
  }

  if (result.success) {
    console.log(
      JSON.stringify({
        success: true,
        name,
        version,
        files: files.length,
        size: archiveBuffer.length,
        hash: archiveHash,
      }),
    );
  } else {
    console.error(
      JSON.stringify({
        error: result.error,
        guidance: { next_command: "selftune registry list" },
      }),
    );
    process.exit(1);
  }
}
