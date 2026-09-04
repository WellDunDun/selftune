#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function sanitizeRootManifest(manifest) {
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(
      ([dependencyName]) => !dependencyName.startsWith("@selftune/"),
    ),
  );
  return { ...manifest, dependencies };
}

function sanitizePackedPackage(tarballPath) {
  const absoluteTarballPath = path.resolve(tarballPath);
  const temporaryRoot = fs.mkdtempSync(
    path.join(path.dirname(absoluteTarballPath), ".selftune-packed-package-"),
  );
  const rewrittenTarball = path.join(temporaryRoot, path.basename(absoluteTarballPath));
  try {
    execFileSync("tar", ["-xzf", absoluteTarballPath, "-C", temporaryRoot]);
    const manifestPath = path.join(temporaryRoot, "package", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, `${JSON.stringify(sanitizeRootManifest(manifest), null, 2)}\n`);
    execFileSync("tar", ["-czf", rewrittenTarball, "-C", temporaryRoot, "package"]);
    fs.renameSync(rewrittenTarball, absoluteTarballPath);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

if (require.main === module) {
  const tarballPath = process.argv[2];
  if (!tarballPath) {
    console.error("Usage: node scripts/sanitize-packed-package.cjs <tarball>");
    process.exit(1);
  }
  sanitizePackedPackage(tarballPath);
}

module.exports = { sanitizePackedPackage, sanitizeRootManifest };
