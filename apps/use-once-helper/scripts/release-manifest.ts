import { readFile, rename, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { createSignedHelperReleaseManifest } from "../src/release-manifest";

function option(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? undefined : Bun.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing required ${name} value.`);
  return value;
}

const artifactPath = option("--artifact");
const target = option("--target");
const privateKeyPath = option("--private-key");
const keyId = option("--key-id");
const outputPath = `${artifactPath}.manifest.json`;
const temporaryOutput = `${outputPath}.tmp`;
const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string;
};

const manifest = createSignedHelperReleaseManifest({
  version: packageJson.version,
  target,
  artifactName: basename(artifactPath),
  artifact: new Uint8Array(await readFile(artifactPath)),
  keyId,
  privateKeyPem: await readFile(privateKeyPath, "utf8"),
});
await writeFile(temporaryOutput, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
await rename(temporaryOutput, outputPath);
// oxlint-disable-next-line no-console
console.log(outputPath);
