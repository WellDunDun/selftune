#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const backupPath = path.join(repoRoot, ".package.json.publish-backup");
const dependencyName = "@selftune/telemetry-contract";
const workspaceSpec = "workspace:*";
const publishSpec = "file:packages/telemetry-contract";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

if (mode === "prepare") {
  const pkg = readJson(packageJsonPath);
  const current = pkg.dependencies?.[dependencyName];
  if (current !== workspaceSpec) {
    process.exit(0);
  }

  fs.copyFileSync(packageJsonPath, backupPath);
  pkg.dependencies[dependencyName] = publishSpec;
  writeJson(packageJsonPath, pkg);
  process.exit(0);
}

if (mode === "restore") {
  if (!fs.existsSync(backupPath)) {
    process.exit(0);
  }

  fs.copyFileSync(backupPath, packageJsonPath);
  fs.unlinkSync(backupPath);
  process.exit(0);
}

console.error("Usage: node scripts/publish-package-json.cjs <prepare|restore>");
process.exit(1);
