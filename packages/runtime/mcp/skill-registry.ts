import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { Option, Schema } from "effect";

import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  type InstalledSkillPackage,
} from "../utils/skill-discovery.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

const MAX_FILES = 100;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;

export interface SkillResourceEntry {
  uri: string;
  digest: string;
}

const Frontmatter = Schema.Record(Schema.String, Schema.Json);
const decodeSkillMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
  }),
);
export const McpSkillEntry = Schema.Struct({
  uri: Schema.String,
  frontmatter: Frontmatter,
  resources: Schema.mutable(
    Schema.Array(Schema.Struct({ uri: Schema.String, digest: Schema.String })),
  ),
});
export type McpSkillEntry = typeof McpSkillEntry.Type;

interface IndexedResource extends SkillResourceEntry {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface IndexedSkill {
  entry: McpSkillEntry;
  name: string;
  description: string;
  revision: string;
  resources: IndexedResource[];
}

export interface SkillRegistryOptions {
  searchDirs?: string[];
  cwd?: string;
  homeDir?: string;
  codexHome?: string;
  pageSize?: number;
}

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.optionalKey(Schema.Literal("2.0")),
  id: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite()), Schema.Null]),
  ),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
});
export type JsonRpcRequest = typeof JsonRpcRequest.Type;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: typeof Schema.Json.Type;
  error?: { code: number; message: string };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Parse every top-level frontmatter key while preserving unknown fields. */
export function parseSkillFrontmatter(content: string): typeof Frontmatter.Type {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const parsed = Bun.YAML.parse(lines.slice(1, end).join("\n"));
  return Option.getOrElse(Schema.decodeUnknownOption(Frontmatter)(parsed), () => ({}));
}

function mimeType(path: string): string {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.(?:md|mdx|txt|ya?ml|ts|tsx|js|jsx|css|html|sh|py)$/i.test(path)) return "text/plain";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.pdf$/i.test(path)) return "application/pdf";
  return "application/octet-stream";
}

function collectFiles(root: string, current = root, files: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectFiles(root, path, files);
    else if (entry.isFile()) {
      files.push(path);
      if (files.length > MAX_FILES) return files;
    }
  }
  return files;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function indexSkill(skill: InstalledSkillPackage): IndexedSkill | undefined {
  const root = realpathSync(skill.package_path);
  const files = collectFiles(root).toSorted((left, right) => {
    if (basename(left) === "SKILL.md") return -1;
    if (basename(right) === "SKILL.md") return 1;
    return left.localeCompare(right);
  });
  if (files.length === 0 || files.length > MAX_FILES) return undefined;
  const records = files.map((path) => {
    const normalized = relative(root, path).split(sep).join("/");
    if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(`Unsafe skill resource path: ${normalized}`);
    }
    return { path, normalized, bytes: readFileSync(path) };
  });
  const skillFile = records.find((file) => file.normalized === "SKILL.md");
  if (!skillFile || skillFile.bytes.byteLength > MAX_SKILL_MD_BYTES) return undefined;
  if (records.some((file) => file.bytes.byteLength > MAX_RESOURCE_BYTES)) return undefined;
  if (records.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_SKILL_BYTES)
    return undefined;

  const content = skillFile.bytes.toString("utf8");
  const parsed = parseFrontmatter(content);
  const frontmatter = parseSkillFrontmatter(content);
  const metadata = decodeSkillMetadata(frontmatter);
  const name = (metadata.name || parsed.name || skill.name).trim();
  const description = (metadata.description || parsed.description || "").trim();
  if (!name || !description || name !== basename(root)) return undefined;
  const revision = createHash("sha256")
    .update(
      records
        .map((file) => `${file.normalized}\0${digest(file.bytes)}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  const rootUri = `skill://selftune/${revision}/${encodeURIComponent(name)}`;
  const resources = records.map((file) => ({
    uri: `${rootUri}/${encodePath(file.normalized)}`,
    digest: digest(file.bytes),
    path: file.path,
    mimeType: mimeType(file.normalized),
    bytes: file.bytes,
  }));
  const uri = resources.find((resource) => resource.path === skillFile.path)?.uri;
  if (!uri) return undefined;
  return {
    name,
    description,
    revision,
    resources,
    entry: {
      uri,
      frontmatter: { ...frontmatter, name, description },
      resources: resources.map(({ uri: resourceUri, digest: resourceDigest }) => ({
        uri: resourceUri,
        digest: resourceDigest,
      })),
    },
  };
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
}

function score(skill: IndexedSkill, query: string): number {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0) return 0;
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  let value = 0;
  for (const term of terms) {
    if (name === term) value += 12;
    else if (name.includes(term)) value += 7;
    if (description.includes(term)) value += 3;
  }
  if (`${name} ${description}`.includes(query.trim().toLowerCase())) value += 8;
  return value / terms.length;
}

const decodeListParams = Schema.decodeUnknownSync(
  Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
);
const decodeUriParams = Schema.decodeUnknownSync(Schema.Struct({ uri: Schema.String }));
const decodeToolParams = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Json) }),
);
const decodeSearchParams = Schema.decodeUnknownSync(
  Schema.Struct({
    query: Schema.String.check(Schema.isPattern(/\S/)),
    limit: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 })),
    ),
  }),
);
const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeRequest = Schema.decodeUnknownOption(JsonRpcRequest);

interface SkillListResult {
  skills: McpSkillEntry[];
  nextCursor?: string;
}

export class LocalSkillRegistry {
  private readonly skills: IndexedSkill[];
  private readonly pageSize: number;

  constructor(options: SkillRegistryOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const homeDir = options.homeDir ?? process.env.SELFTUNE_HOME ?? process.env.HOME ?? "";
    const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homeDir, ".codex");
    const searchDirs = options.searchDirs ?? getDefaultSkillSearchDirs(cwd, homeDir, codexHome);
    const seen = new Set<string>();
    this.skills = findInstalledSkillPackages(searchDirs, homeDir, codexHome)
      .map((candidate) => {
        try {
          return indexSkill(candidate);
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is IndexedSkill => {
        if (!candidate || seen.has(candidate.name)) return false;
        seen.add(candidate.name);
        return true;
      });
    this.pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 100));
  }

  list(cursor?: string): SkillListResult {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid cursor");
    const page = this.skills.slice(offset, offset + this.pageSize);
    const next = offset + page.length;
    const result: SkillListResult = {
      skills: page.map((skill) => skill.entry),
    };
    if (next < this.skills.length) result.nextCursor = String(next);
    return result;
  }

  get(uri: string): McpSkillEntry {
    const skill = this.skills.find((candidate) => candidate.entry.uri === uri);
    if (!skill) throw new Error("Unknown skill URI");
    return skill.entry;
  }

  read(uri: string): { contents: Array<Record<string, string>> } {
    const resource = this.skills
      .flatMap((skill) => skill.resources)
      .find((item) => item.uri === uri);
    if (!resource) throw new Error("Unknown resource URI");
    const bytes = resource.bytes;
    return resource.mimeType.startsWith("text/") || resource.mimeType === "application/json"
      ? {
          contents: [
            { uri, mimeType: resource.mimeType, text: Buffer.from(bytes).toString("utf8") },
          ],
        }
      : {
          contents: [
            { uri, mimeType: resource.mimeType, blob: Buffer.from(bytes).toString("base64") },
          ],
        };
  }

  search(query: string, limit = 5) {
    const bounded = Math.max(1, Math.min(limit, 20));
    return this.skills
      .map((skill) => ({ skill, score: score(skill, query) }))
      .filter((item) => item.score > 0)
      .toSorted(
        (left, right) =>
          right.score - left.score || left.skill.name.localeCompare(right.skill.name),
      )
      .slice(0, bounded)
      .map(({ skill, score: relevance }) => ({
        uri: skill.entry.uri,
        name: skill.name,
        description: skill.description,
        revision: skill.revision,
        score: relevance,
      }));
  }
}

export function handleSkillRegistryRequest(
  registry: LocalSkillRegistry,
  request: JsonRpcRequest,
): JsonRpcResponse | undefined {
  if (request.id === undefined) return undefined;
  const id = request.id;
  try {
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2026-07-28",
            serverInfo: { name: "selftune-skill-registry", version: "0.1.0" },
            capabilities: {
              extensions: { "io.modelcontextprotocol/skills": {} },
              resources: {},
              tools: {},
            },
            instructions:
              "Search the local skill catalog before broad skill-related tasks. Loading instructions never grants tool permissions.",
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "skills/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { ...registry.list(decodeListParams(params).cursor) },
        };
      case "skills/get":
        return { jsonrpc: "2.0", id, result: { skill: registry.get(decodeUriParams(params).uri) } };
      case "resources/read":
        return { jsonrpc: "2.0", id, result: registry.read(decodeUriParams(params).uri) };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
      case "tools/call": {
        const tool = decodeToolParams(params);
        if (tool.name === "search_skills") {
          const args = decodeSearchParams(tool.arguments);
          const results = registry.search(args.query, args.limit);
          return toolResult(id, { results });
        }
        if (tool.name === "load_skill") {
          const args = decodeUriParams(tool.arguments);
          const skill = registry.get(args.uri);
          return toolResult(id, { skill, ...registry.read(skill.uri) });
        }
        throw new Error("Unknown tool");
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

const toolDefinitions = [
  {
    name: "search_skills",
    title: "Search local skills",
    description:
      "Search SelfTune's local skill catalog by task or intent. Returns canonical immutable skill URIs; use load_skill on the selected URI.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "load_skill",
    title: "Load a local skill",
    description:
      "Load one exact skill revision by canonical URI, including SKILL.md and its resource manifest. Does not install, execute, or grant permissions.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", pattern: "^skill://" } },
      required: ["uri"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

function toolResult(id: string | number | null, value: typeof Schema.Json.Type): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: value,
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
}

export function handleSkillRegistryLine(
  registry: LocalSkillRegistry,
  line: string,
): JsonRpcResponse | undefined {
  const json = decodeJsonLine(line);
  if (Option.isNone(json))
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  const request = decodeRequest(json.value);
  if (Option.isNone(request))
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  return handleSkillRegistryRequest(registry, request.value);
}

export async function runSkillRegistryStdio(options: SkillRegistryOptions = {}): Promise<void> {
  const registry = new LocalSkillRegistry(options);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        const response = handleSkillRegistryLine(registry, line);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      newline = pending.indexOf("\n");
    }
  }
  const finalLine = pending.trim();
  if (finalLine) {
    const response = handleSkillRegistryLine(registry, finalLine);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
