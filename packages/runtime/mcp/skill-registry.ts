import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

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

export interface McpSkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillResourceEntry[];
}

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

export interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Parse every top-level frontmatter key while preserving unknown fields. */
export function parseSkillFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const parsed = Bun.YAML.parse(lines.slice(1, end).join("\n"));
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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
  const name = String(frontmatter.name || parsed.name || skill.name).trim();
  const description = String(frontmatter.description || parsed.description || "").trim();
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

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

  list(cursor?: string): { skills: McpSkillEntry[]; nextCursor?: string } {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid cursor");
    const page = this.skills.slice(offset, offset + this.pageSize);
    const next = offset + page.length;
    return {
      skills: page.map((skill) => skill.entry),
      ...(next < this.skills.length ? { nextCursor: String(next) } : {}),
    };
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

  search(query: string, limit = 5): Array<Record<string, unknown>> {
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
    const params = object(request.params);
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
          result: registry.list(typeof params.cursor === "string" ? params.cursor : undefined),
        };
      case "skills/get":
        if (typeof params.uri !== "string") throw new Error("uri is required");
        return { jsonrpc: "2.0", id, result: { skill: registry.get(params.uri) } };
      case "resources/read":
        if (typeof params.uri !== "string") throw new Error("uri is required");
        return { jsonrpc: "2.0", id, result: registry.read(params.uri) };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
      case "tools/call": {
        const args = object(params.arguments);
        if (params.name === "search_skills") {
          if (typeof args.query !== "string" || !args.query.trim())
            throw new Error("query is required");
          const results = registry.search(
            args.query,
            typeof args.limit === "number" ? args.limit : undefined,
          );
          return toolResult(id, { results });
        }
        if (params.name === "load_skill") {
          if (typeof args.uri !== "string") throw new Error("uri is required");
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

function toolResult(id: string | number | null, value: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: value,
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
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
        let response: JsonRpcResponse | undefined;
        try {
          response = handleSkillRegistryRequest(registry, JSON.parse(line));
        } catch {
          response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
        }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      newline = pending.indexOf("\n");
    }
  }
  const finalLine = pending.trim();
  if (finalLine) {
    let response: JsonRpcResponse | undefined;
    try {
      response = handleSkillRegistryRequest(registry, JSON.parse(finalLine));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
