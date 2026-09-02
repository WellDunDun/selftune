#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const backupPath = path.join(repoRoot, ".publish-package-json-backup.json");
const nodeModulesBackupRoot = path.join(repoRoot, ".publish-workspace-node-modules");
const workspaceLinkBackupRoot = path.join(repoRoot, ".publish-workspace-links");
const skipNodeModulesIsolation = process.env.SELFTUNE_PUBLISH_SKIP_NODE_MODULES === "1";
const legacyBackupPath = path.join(repoRoot, ".package.json.publish-backup");
const workspaceSpec = "workspace:*";
const workspaceDependencies = {
  "@selftune/config": "packages/config/package.json",
  "@selftune/control-plane": "packages/control-plane/package.json",
  "@selftune/dashboard-core": "packages/dashboard-core/package.json",
  "@selftune/harness-claude-code": "packages/harnesses/claude-code/package.json",
  "@selftune/harness-cline": "packages/harnesses/cline/package.json",
  "@selftune/harness-codex": "packages/harnesses/codex/package.json",
  "@selftune/harness-core": "packages/harnesses/core/package.json",
  "@selftune/harness-openclaw": "packages/harnesses/openclaw/package.json",
  "@selftune/harness-opencode": "packages/harnesses/opencode/package.json",
  "@selftune/harness-pi": "packages/harnesses/pi/package.json",
  "@selftune/harness-registry": "packages/harnesses/registry/package.json",
  "@selftune/local": "apps/local/package.json",
  "@selftune/library": "packages/library/package.json",
  "@selftune/local-store": "packages/local-store/package.json",
  "@selftune/observability": "packages/observability/package.json",
  "@selftune/orchestration": "packages/orchestration/package.json",
  "@selftune/runtime": "packages/runtime/package.json",
  "@selftune/skill-intelligence": "packages/skill-intelligence/package.json",
  "@selftune/source-management": "packages/source-management/package.json",
  "@selftune/telemetry-contract": "packages/telemetry-contract/package.json",
  "@selftune/ui": "packages/ui/package.json",
};
// Bundled workspaces are copied into the root npm artifact. A root .npmignore
// does not apply inside those nested package directories, so this rule lives
// beside the manifest rewriting that creates them. Keep production source,
// migrations, and package metadata; omit only development-only test material.
const developmentOnlyPackageFiles = [
  "!**/*.test.ts",
  "!**/*.test.tsx",
  "!**/*.spec.ts",
  "!**/*.spec.tsx",
  "!**/*.stories.ts",
  "!**/*.stories.tsx",
  "!**/test/**",
  "!**/tests/**",
  "!**/__tests__/**",
];

const runtimePackageFiles = (files) => [...files, ...developmentOnlyPackageFiles];
const flattenedWorkspacePackages = [
  { path: "apps/cli/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "apps/local/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  {
    path: "packages/config/package.json",
    files: runtimePackageFiles(["src/**/*.ts"]),
  },
  {
    path: "packages/control-plane/package.json",
    files: runtimePackageFiles(["index.ts", "src/**/*.ts"]),
  },
  {
    path: "packages/dashboard-core/package.json",
    files: runtimePackageFiles(["index.ts", "src/**/*.ts", "src/**/*.tsx"]),
  },
  {
    path: "packages/harnesses/claude-code/package.json",
    files: runtimePackageFiles(["src/**/*.ts"]),
  },
  { path: "packages/harnesses/cline/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/codex/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/core/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/openclaw/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/opencode/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/pi/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/harnesses/registry/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/library/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  {
    path: "packages/local-store/package.json",
    files: runtimePackageFiles([
      "src/**/*.ts",
      "src/drizzle/meta/_journal.json",
      "src/drizzle/**/*.sql",
    ]),
  },
  { path: "packages/observability/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/orchestration/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  {
    path: "packages/runtime/package.json",
    files: runtimePackageFiles(["**/*.ts", "remote-library/package-bundle-collector.cjs"]),
  },
  { path: "packages/skill-intelligence/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  { path: "packages/source-management/package.json", files: runtimePackageFiles(["src/**/*.ts"]) },
  {
    path: "packages/telemetry-contract/package.json",
    files: runtimePackageFiles([
      "index.ts",
      "src/**/*.ts",
      "fixtures/complete-push.ts",
      "fixtures/evidence-only-push.ts",
      "fixtures/index.ts",
      "fixtures/partial-push-no-sessions.ts",
      "fixtures/partial-push-unresolved-parents.ts",
    ]),
  },
  {
    path: "packages/ui/package.json",
    files: runtimePackageFiles(["index.ts", "src/**/*.ts", "src/**/*.tsx"]),
  },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function workspaceNodeModulesPaths() {
  return [
    ...new Set(
      flattenedWorkspacePackages.map(({ path: relativePath }) =>
        path.join(path.dirname(relativePath), "node_modules"),
      ),
    ),
  ];
}

function moveWorkspaceNodeModules() {
  const moved = [];
  const manifestPath = path.join(nodeModulesBackupRoot, "manifest.json");
  fs.mkdirSync(nodeModulesBackupRoot, { recursive: true });
  writeJson(manifestPath, moved);
  for (const relativePath of workspaceNodeModulesPaths()) {
    const source = path.join(repoRoot, relativePath);
    if (!pathExists(source)) continue;
    const target = path.join(nodeModulesBackupRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    moved.push(relativePath);
    writeJson(manifestPath, moved);
    fs.renameSync(source, target);
  }
}

function restoreWorkspaceNodeModules() {
  const manifestPath = path.join(nodeModulesBackupRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  const moved = readJson(manifestPath);
  for (const relativePath of moved.toReversed()) {
    const source = path.join(nodeModulesBackupRoot, relativePath);
    const target = path.join(repoRoot, relativePath);
    if (!pathExists(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
  }
  fs.rmSync(nodeModulesBackupRoot, { force: true, recursive: true });
}

function normalizeWorkspaceLinks() {
  const manifestPath = path.join(workspaceLinkBackupRoot, "manifest.json");
  const replaced = [];
  fs.mkdirSync(workspaceLinkBackupRoot, { recursive: true });
  writeJson(manifestPath, replaced);

  for (const [dependencyName, workspacePackagePath] of Object.entries(workspaceDependencies)) {
    const linkPath = path.join(repoRoot, "node_modules", dependencyName);
    const backupLinkPath = path.join(workspaceLinkBackupRoot, dependencyName);
    const hadExisting = pathExists(linkPath);
    replaced.push({ dependencyName, hadExisting });
    writeJson(manifestPath, replaced);
    if (hadExisting) {
      fs.mkdirSync(path.dirname(backupLinkPath), { recursive: true });
      fs.renameSync(linkPath, backupLinkPath);
    }

    const workspaceRoot = path.dirname(path.join(repoRoot, workspacePackagePath));
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(
      path.relative(path.dirname(linkPath), workspaceRoot),
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

function restoreWorkspaceLinks() {
  const manifestPath = path.join(workspaceLinkBackupRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  const replaced = readJson(manifestPath);
  for (const { dependencyName, hadExisting } of replaced.toReversed()) {
    const linkPath = path.join(repoRoot, "node_modules", dependencyName);
    const backupLinkPath = path.join(workspaceLinkBackupRoot, dependencyName);
    if (!hadExisting) {
      fs.rmSync(linkPath, { force: true, recursive: true });
      continue;
    }
    if (!pathExists(backupLinkPath)) continue;
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.renameSync(backupLinkPath, linkPath);
  }
  fs.rmSync(workspaceLinkBackupRoot, { force: true, recursive: true });
}

function restoreManifests(backups) {
  for (const [relativePath, contents] of Object.entries(backups)) {
    fs.writeFileSync(path.join(repoRoot, relativePath), contents);
  }
}

if (mode === "prepare") {
  if (
    fs.existsSync(backupPath) ||
    fs.existsSync(nodeModulesBackupRoot) ||
    fs.existsSync(workspaceLinkBackupRoot)
  ) {
    console.error(`Refusing to overwrite active publish state under ${repoRoot}`);
    process.exit(1);
  }

  const packagePaths = [
    packageJsonPath,
    ...flattenedWorkspacePackages.map(({ path: relativePath }) =>
      path.join(repoRoot, relativePath),
    ),
  ];
  const backups = Object.fromEntries(
    packagePaths.map((filePath) => [
      path.relative(repoRoot, filePath),
      fs.readFileSync(filePath, "utf8"),
    ]),
  );
  writeJson(backupPath, backups);
  try {
    if (!skipNodeModulesIsolation) {
      moveWorkspaceNodeModules();
      normalizeWorkspaceLinks();
    }
    const pkg = readJson(packageJsonPath);
    const changes = Object.entries(workspaceDependencies).filter(
      ([dependencyName]) => pkg.dependencies?.[dependencyName] === workspaceSpec,
    );
    for (const [dependencyName, workspacePackagePath] of changes) {
      pkg.dependencies[dependencyName] = readJson(
        path.join(repoRoot, workspacePackagePath),
      ).version;
    }
    writeJson(packageJsonPath, pkg);

    for (const workspacePackage of flattenedWorkspacePackages) {
      const workspacePackagePath = path.join(repoRoot, workspacePackage.path);
      const workspacePkg = readJson(workspacePackagePath);
      workspacePkg.peerDependencies = {
        ...workspacePkg.peerDependencies,
        ...Object.fromEntries(
          Object.entries(workspacePkg.dependencies ?? {}).map(
            ([dependencyName, dependencySpec]) => [
              dependencyName,
              dependencySpec === workspaceSpec ? "*" : dependencySpec,
            ],
          ),
        ),
      };
      delete workspacePkg.dependencies;
      delete workspacePkg.devDependencies;
      workspacePkg.files = workspacePackage.files;
      writeJson(workspacePackagePath, workspacePkg);
    }
  } catch (error) {
    restoreManifests(backups);
    restoreWorkspaceLinks();
    restoreWorkspaceNodeModules();
    fs.rmSync(backupPath, { force: true });
    throw error;
  }
  process.exit(0);
}

if (mode === "restore") {
  if (fs.existsSync(backupPath)) {
    const backups = readJson(backupPath);
    restoreManifests(backups);
    restoreWorkspaceLinks();
    restoreWorkspaceNodeModules();
    fs.unlinkSync(backupPath);
    process.exit(0);
  }

  restoreWorkspaceLinks();
  restoreWorkspaceNodeModules();

  if (fs.existsSync(legacyBackupPath)) {
    fs.copyFileSync(legacyBackupPath, packageJsonPath);
    fs.unlinkSync(legacyBackupPath);
    process.exit(0);
  }
  process.exit(0);
}

console.error("Usage: node scripts/publish-package-json.cjs <prepare|restore>");
process.exit(1);
