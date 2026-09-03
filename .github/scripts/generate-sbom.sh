#!/usr/bin/env bash
set -euo pipefail
: "${TARBALL_PATH:?Set TARBALL_PATH to the packed candidate}"
: "${SBOM_TOOLCHAIN_DIR:?Set SBOM_TOOLCHAIN_DIR to the installed locked toolchain}"
: "${SBOM_OUTPUT:?Set SBOM_OUTPUT to an absolute output path}"
TARBALL_PATH="$(cd "$(dirname "$TARBALL_PATH")" && pwd)/$(basename "$TARBALL_PATH")"
SBOM_TOOLCHAIN_DIR="$(cd "$SBOM_TOOLCHAIN_DIR" && pwd)"
SBOM_OUTPUT="$(cd "$(dirname "$SBOM_OUTPUT")" && pwd)/$(basename "$SBOM_OUTPUT")"
SBOM_TMP="$(mktemp -d)"
trap 'rm -rf "$SBOM_TMP"' EXIT
tar -xzf "$TARBALL_PATH" -C "$SBOM_TMP"
cd "$SBOM_TMP/package"
node -e "const fs=require('node:fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); delete pkg.workspaces; fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');"

# The SBOM is generated from the packed candidate before publishing to npm so
# an unresolvable bundled dependency tree fails the release while npm,
# the GitHub release, and the self-host image are still in sync.
npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null

SBOM_LOG="$SBOM_TMP/cyclonedx.log"
if ! node "$SBOM_TOOLCHAIN_DIR/node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js" \
  --package-lock-only \
  --omit dev \
  --no-workspaces \
  --validate \
  -v -v \
  --output-file "$SBOM_OUTPUT" \
  >"$SBOM_LOG" 2>&1; then
  cat "$SBOM_LOG" >&2
  exit 1
fi
cat "$SBOM_LOG"
if grep --fixed-strings --quiet "skipped validating BOM" "$SBOM_LOG"; then
  echo "CycloneDX skipped SBOM validation; refusing to publish." >&2
  exit 1
fi
if ! grep --fixed-strings --line-regexp --quiet "INFO  | BOM result appears valid" "$SBOM_LOG"; then
  echo "CycloneDX did not confirm successful SBOM validation; refusing to publish." >&2
  exit 1
fi

node - "$SBOM_TMP/package/package.json" "$SBOM_OUTPUT" <<'NODE'
const fs = require("node:fs");
const [, , packagePath, bomPath] = process.argv;
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const bom = JSON.parse(fs.readFileSync(bomPath, "utf8"));
const rootRef = bom.metadata?.component?.["bom-ref"];
const root = bom.dependencies?.find((entry) => entry.ref === rootRef);
if (!root) throw new Error(`Missing SBOM root dependency node ${rootRef}`);
const namesByRef = new Map(
  (bom.components ?? []).map((component) => [
    component["bom-ref"],
    `${component.group ? `${component.group}/` : ""}${component.name}`,
  ]),
);
const actual = (root.dependsOn ?? [])
  .map((ref) => {
    const name = namesByRef.get(ref);
    if (!name) throw new Error(`Unresolved SBOM root dependency ${ref}`);
    return name;
  })
  .sort();
const expected = Object.keys(pkg.dependencies ?? {}).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Incomplete SBOM root dependencies: expected ${expected.length} [${expected.join(", ")}], got ${actual.length} [${actual.join(", ")}]`,
  );
}
console.log(`SBOM root dependency coverage: ${actual.length}/${expected.length}`);
NODE
