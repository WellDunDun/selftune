#!/usr/bin/env bun
import * as Schema from "effect/Schema";

const UpdateFileEntry = Schema.Struct({
  url: Schema.String,
  sha512: Schema.String,
  size: Schema.Number,
});

const UpdateManifest = Schema.Struct({
  version: Schema.String,
  files: Schema.Array(UpdateFileEntry),
  path: Schema.String,
  sha512: Schema.String,
  releaseDate: Schema.String,
});

type UpdateManifest = typeof UpdateManifest.Type;

function parseManifest(source: string, path: string): UpdateManifest {
  try {
    return Schema.decodeUnknownSync(UpdateManifest)(Bun.YAML.parse(source));
  } catch (error) {
    throw new Error(
      `Unrecognized electron-builder update manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function serializeManifest(manifest: UpdateManifest): string {
  return [
    `version: ${manifest.version}`,
    "files:",
    ...manifest.files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${manifest.path}`,
    `sha512: ${manifest.sha512}`,
    `releaseDate: '${manifest.releaseDate}'`,
    "",
  ].join("\n");
}

const [primaryPath, secondaryPath, outputPath] = process.argv.slice(2);
if (!primaryPath || !secondaryPath || !outputPath) {
  throw new Error("Usage: merge-latest-mac-yml.ts <primary.yml> <secondary.yml> <output.yml>");
}

const primary = parseManifest(await Bun.file(primaryPath).text(), primaryPath);
const secondary = parseManifest(await Bun.file(secondaryPath).text(), secondaryPath);
if (primary.version !== secondary.version) {
  throw new Error(`Cannot merge update manifests for ${primary.version} and ${secondary.version}.`);
}

const seen = new Set<string>();
const files = [...primary.files, ...secondary.files].filter((file) => {
  if (seen.has(file.url)) return false;
  seen.add(file.url);
  return true;
});

await Bun.write(outputPath, serializeManifest({ ...primary, files }));
process.stdout.write(`Merged ${files.length} macOS update artifacts into ${outputPath}\n`);
