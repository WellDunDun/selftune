import * as Schema from "effect/Schema";

export type PortablePluginExportTarget = "claude" | "openai" | "agent-plugins-v1" | "dual" | "all";

export interface PortablePluginExportFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface PortablePluginExportSkill {
  readonly name: string;
  readonly files: ReadonlyArray<PortablePluginExportFile>;
}

export interface PortablePluginProjection {
  readonly pluginName: string;
  readonly files: ReadonlyArray<PortablePluginExportFile>;
}

export class PortablePluginExportError extends Schema.TaggedErrorClass<PortablePluginExportError>()(
  "PortablePluginExportError",
  { message: Schema.String },
) {}

function invalidPluginExport(message: string): PortablePluginExportError {
  return PortablePluginExportError.make({ message });
}

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

function slug(value: string): string {
  return (
    value
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "selftune-plugin"
  );
}

function safePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw invalidPluginExport(`Plugin contains an unsafe path: ${path}`);
  }
  return normalized;
}

function json<Value>(path: string, value: Value): PortablePluginExportFile {
  return { path, content: new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`) };
}

export function projectPortablePluginFiles(input: {
  readonly target: PortablePluginExportTarget;
  readonly name: string;
  readonly description: string;
  readonly skillSetId: string;
  readonly skillSetRevisionSha256: string;
  readonly skills: ReadonlyArray<PortablePluginExportSkill>;
}): PortablePluginProjection {
  if (input.skills.length === 0) {
    throw invalidPluginExport("Plugin export requires at least one skill.");
  }
  const pluginName = slug(input.name);
  const common = { name: pluginName, description: input.description };
  const files: PortablePluginExportFile[] = [];
  if (input.target === "claude" || input.target === "dual" || input.target === "all") {
    files.push(json(".claude-plugin/plugin.json", common));
  }
  if (input.target === "openai" || input.target === "dual" || input.target === "all") {
    files.push(json(".codex-plugin/plugin.json", { ...common, skills: "./skills/" }));
  }
  if (input.target === "agent-plugins-v1" || input.target === "all") {
    files.push(
      json("plugin.json", {
        $schema: PLUGIN_SCHEMA,
        ...common,
        extensions: {
          "dev.selftune": {
            skillSetId: input.skillSetId,
            skillSetRevisionSha256: input.skillSetRevisionSha256,
          },
        },
      }),
    );
  }
  const names = new Set<string>();
  for (const skill of input.skills) {
    const name = slug(skill.name);
    if (names.has(name)) {
      throw invalidPluginExport(`Plugin contains duplicate skill name: ${name}`);
    }
    names.add(name);
    if (!skill.files.some((file) => safePath(file.path).toLowerCase() === "skill.md")) {
      throw invalidPluginExport(
        `Plugin skill "${skill.name}" does not contain a root SKILL.md file.`,
      );
    }
    for (const file of skill.files) {
      const path = safePath(file.path);
      files.push({
        path: `skills/${name}/${path.toLowerCase() === "skill.md" ? "SKILL.md" : path}`,
        content: file.content,
      });
    }
  }
  return { pluginName, files };
}

const CRC32 = new Uint32Array(
  Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  }),
);

function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createPortablePluginZip(
  files: ReadonlyArray<PortablePluginExportFile>,
): Uint8Array {
  if (files.length === 0) throw invalidPluginExport("Plugin ZIP requires at least one file.");
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const ordered = files.map((file) => ({ ...file, path: safePath(file.path) }));
  ordered.sort((left, right) => left.path.localeCompare(right.path));
  for (const file of ordered) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw invalidPluginExport(`Plugin ZIP contains duplicate path: ${file.path}`);
    }
    seen.add(key);
    const name = encoder.encode(safePath(file.path));
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, checksum(file.content), true);
    view.setUint32(18, file.content.byteLength, true);
    view.setUint32(22, file.content.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    local.push(header, name, file.content);
    const entry = new Uint8Array(46);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0x0800, true);
    entryView.setUint16(14, 33, true);
    entryView.setUint32(16, checksum(file.content), true);
    entryView.setUint32(20, file.content.byteLength, true);
    entryView.setUint32(24, file.content.byteLength, true);
    entryView.setUint16(28, name.byteLength, true);
    entryView.setUint32(42, offset, true);
    central.push(entry, name);
    offset += header.byteLength + name.byteLength + file.content.byteLength;
  }
  const centralBytes = concat(central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, ordered.length, true);
  endView.setUint16(10, ordered.length, true);
  endView.setUint32(12, centralBytes.byteLength, true);
  endView.setUint32(16, offset, true);
  return concat([...local, centralBytes, end]);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
