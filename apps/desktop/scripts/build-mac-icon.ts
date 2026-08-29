import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = new URL("../build/icon-mac.png", import.meta.url).pathname;
const destination = new URL("../build/icon.icns", import.meta.url).pathname;
const workDirectory = await mkdtemp(join(tmpdir(), "selftune-mac-icon-"));

const representations = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
] as const;

try {
  const chunks: Buffer[] = [];

  for (const representation of representations) {
    const pngPath = join(workDirectory, `${representation.size}.png`);
    const process = Bun.spawn(
      [
        "/usr/bin/sips",
        "-z",
        `${representation.size}`,
        `${representation.size}`,
        source,
        "--out",
        pngPath,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    if ((await process.exited) !== 0) {
      throw new Error(`Failed to render the ${representation.size}px macOS icon.`);
    }

    const png = await readFile(pngPath);
    const header = Buffer.alloc(8);
    header.write(representation.type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + header.length, 4);
    chunks.push(header, png);
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + header.length, 4);
  await writeFile(destination, Buffer.concat([header, body]));
  console.log(`Built ${destination}`);
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
