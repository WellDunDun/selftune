import { afterEach, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const temporaryRoots: string[] = [];

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RegistryStateEntry {
  readonly entryId: string;
  readonly name: string;
  readonly versionHash: string;
  readonly installPath: string;
}

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly json?: unknown;
}

type RegistryHandler = (request: Request) => Response | Promise<Response>;

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `selftune-registry-contract-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function jsonResponse(value: typeof Schema.Json.Type, status = 200): Response {
  return Response.json(value, { status });
}

function configureRegistry(home: string, apiUrl: string): void {
  const configDir = join(home, ".selftune");
  const credentialAccount = "registry-contract-account";
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "credential-store.json"),
    JSON.stringify({ [credentialAccount]: "registry-contract-key" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      agent_type: "unknown",
      cli_path: process.execPath,
      llm_mode: "agent",
      agent_cli: null,
      hooks_installed: false,
      initialized_at: "2026-07-17T00:00:00.000Z",
      alpha: {
        enrolled: true,
        user_id: "registry-contract-user",
        consent_timestamp: "2026-07-17T00:00:00.000Z",
        cloud_api_url: apiUrl,
        credential: { provider: "file", account: credentialAccount },
      },
    }),
  );
}

function writeRegistryState(home: string, state: ReadonlyArray<RegistryStateEntry>): void {
  const configDir = join(home, ".selftune");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "registry-state.json"), JSON.stringify(state));
}

async function runRegistry(home: string, cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRYPOINT, "registry", ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_LOG_DIR: join(home, "logs"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function withRegistryServer<T>(
  handler: RegistryHandler,
  useServer: (apiUrl: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  try {
    return await useServer(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

async function captureRequest(request: Request): Promise<CapturedRequest> {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const json = contentType.includes("application/json") ? await request.json() : undefined;
  return {
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    json,
  };
}

function makeSkillArchive() {
  const root = makeRoot("archive");
  const sourceDir = join(root, "source");
  const archivePath = join(root, "skill.tar.gz");
  mkdirSync(sourceDir);
  writeFileSync(
    join(sourceDir, "SKILL.md"),
    "---\nname: cloud-skill\ndescription: Deploy cloud applications\n---\n",
  );
  const tar = Bun.spawnSync(["tar", "czf", archivePath, "-C", sourceDir, "."]);
  expect(tar.exitCode, Buffer.from(tar.stderr).toString("utf8")).toBe(0);
  const buffer = readFileSync(archivePath);
  return {
    buffer,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy registry CLI contract", () => {
  test("documents exactly seven leaves and only treats the first subcommand as group help", async () => {
    const root = makeRoot("help");
    const home = join(root, "home");
    mkdirSync(home);

    const help = await runRegistry(home, root, "--help", "--unknown");
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    for (const leaf of ["push", "install", "sync", "status", "rollback", "history", "list"]) {
      expect(help.stdout).toContain(`${leaf}`);
    }

    const requests: CapturedRequest[] = [];
    const listHelp = await withRegistryServer(
      async (request) => {
        requests.push(await captureRequest(request));
        return jsonResponse({ entries: [] });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(home, root, "list", "--help");
      },
    );
    expect(listHelp.exitCode).toBe(0);
    expect(JSON.parse(listHelp.stdout)).toEqual({
      message: "No entries in registry. Use 'selftune registry push' to publish a skill.",
    });
    expect(requests).toEqual([
      { method: "GET", pathname: "/api/v1/registry", search: "", json: undefined },
    ]);

    const unknown = await runRegistry(home, root, "-hh", "--json");
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stderr)).toEqual({
      error: {
        code: "UNKNOWN_COMMAND",
        message: "Unknown registry subcommand: -hh",
        suggestion: "selftune registry --help",
        retryable: false,
      },
    });
  });

  test("list preserves JSON output projection and exits on the first registry failure", async () => {
    const root = makeRoot("list");
    const home = join(root, "home");
    mkdirSync(home);
    let responseMode: "success" | "failure" = "success";

    await withRegistryServer(
      () =>
        responseMode === "success"
          ? jsonResponse({
              entries: [
                {
                  name: "deploy",
                  entry_type: "skill",
                  description: "Deploy safely",
                  current_version: { version: "2.1.0" },
                  pass_rate: 0.92,
                  eval_count: 18,
                },
              ],
            })
          : new Response("registry unavailable", { status: 503 }),
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        const success = await runRegistry(home, root, "list", "ignored", "--unknown");
        expect(success.exitCode).toBe(0);
        expect(success.stderr).toBe("");
        expect(JSON.parse(success.stdout)).toEqual({
          entries: [
            {
              name: "deploy",
              type: "skill",
              version: "2.1.0",
              pass_rate: 0.92,
              eval_count: 18,
              description: "Deploy safely",
            },
          ],
          total: 1,
        });

        responseMode = "failure";
        const failure = await runRegistry(home, root, "list");
        expect(failure.exitCode).toBe(1);
        expect(failure.stdout).toBe("");
        expect(JSON.parse(failure.stderr)).toEqual({
          error: "HTTP 503: registry unavailable",
        });
      },
    );
  });

  test("status reads local state before the network and projects version drift", async () => {
    const root = makeRoot("status");
    const home = join(root, "home");
    mkdirSync(home);

    const empty = await runRegistry(home, root, "status", "--unknown");
    expect(empty).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ message: "No registry installations found." })}\n`,
      stderr: "",
    });

    writeRegistryState(home, [
      {
        entryId: "entry-1",
        name: "deploy",
        versionHash: "old-hash",
        installPath: join(root, ".claude", "skills", "deploy"),
      },
    ]);
    const requests: CapturedRequest[] = [];
    const status = await withRegistryServer(
      async (request) => {
        requests.push(await captureRequest(request));
        return jsonResponse({
          entries: [
            {
              entry_id: "entry-1",
              name: "deploy",
              has_update: true,
              current_version: "1.0.0",
              latest_version: "2.0.0",
            },
          ],
        });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(home, root, "status", "ignored", "--help");
      },
    );
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({
      installations: [{ name: "deploy", installed: "1.0.0", latest: "2.0.0", status: "behind" }],
      total: 1,
      updates_available: 1,
    });
    expect(requests[0]).toEqual({
      method: "POST",
      pathname: "/api/v1/registry/sync",
      search: "",
      json: { installations: [{ entry_id: "entry-1", current_version_hash: "old-hash" }] },
    });
  });

  test("sync short-circuits empty state and reports an up-to-date non-empty state", async () => {
    const root = makeRoot("sync");
    const home = join(root, "home");
    mkdirSync(home);

    const empty = await runRegistry(home, root, "sync", "ignored", "--help");
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({
      message: "No registry installations found. Use 'selftune registry install <name>' first.",
    });

    writeRegistryState(home, [
      {
        entryId: "entry-1",
        name: "deploy",
        versionHash: "hash-1",
        installPath: join(root, ".claude", "skills", "deploy"),
      },
      {
        entryId: "entry-2",
        name: "review",
        versionHash: "hash-2",
        installPath: join(root, ".claude", "skills", "review"),
      },
    ]);
    const synced = await withRegistryServer(
      () => jsonResponse({ entries: [] }),
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(home, root, "sync", "--unknown");
      },
    );
    expect(synced.exitCode).toBe(0);
    expect(JSON.parse(synced.stdout)).toEqual({
      message: "All installations up to date",
      count: 2,
    });
  });

  test("history uses the first positional, ignores extras, and maps version statuses", async () => {
    const root = makeRoot("history");
    const home = join(root, "home");
    mkdirSync(home);
    const requests: CapturedRequest[] = [];

    const result = await withRegistryServer(
      async (request) => {
        const captured = await captureRequest(request);
        requests.push(captured);
        if (captured.search) return jsonResponse({ entries: [{ id: "entry-1" }] });
        return jsonResponse({
          versions: [
            {
              version: "2.0.0",
              is_current: true,
              rolled_back: false,
              aggregate_pass_rate: 0.9,
              aggregate_sessions: 10,
              change_summary: "current",
              pushed_at: "2026-01-02T00:00:00Z",
            },
            {
              version: "1.0.0",
              is_current: false,
              rolled_back: true,
              aggregate_pass_rate: null,
              aggregate_sessions: 0,
              change_summary: null,
              pushed_at: "2026-01-01T00:00:00Z",
            },
          ],
        });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(home, root, "history", "deploy skill", "ignored", "--unknown");
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: "deploy skill",
      versions: [
        {
          version: "2.0.0",
          status: "current",
          pass_rate: 0.9,
          sessions: 10,
          summary: "current",
          pushed_at: "2026-01-02T00:00:00Z",
        },
        {
          version: "1.0.0",
          status: "rolled_back",
          pass_rate: null,
          sessions: 0,
          summary: null,
          pushed_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(requests.map(({ method, pathname, search }) => ({ method, pathname, search }))).toEqual([
      { method: "GET", pathname: "/api/v1/registry", search: "?name=deploy%20skill" },
      { method: "GET", pathname: "/api/v1/registry/entry-1/versions", search: "" },
    ]);
  });

  test("rollback keeps the first attached values and sends them after name resolution", async () => {
    const root = makeRoot("rollback");
    const home = join(root, "home");
    mkdirSync(home);
    const requests: CapturedRequest[] = [];

    const result = await withRegistryServer(
      async (request) => {
        const captured = await captureRequest(request);
        requests.push(captured);
        return captured.search
          ? jsonResponse({ entries: [{ id: "entry-1", name: "deploy" }] })
          : jsonResponse({ success: true });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(
          home,
          root,
          "rollback",
          "deploy",
          "ignored",
          "--to=1.2.0",
          "--to=9.9.9",
          "--reason=first",
          "--reason=second",
          "--unknown",
        );
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      name: "deploy",
      message: "Rolled back. Run 'selftune registry sync' to update local installations.",
    });
    expect(requests).toEqual([
      {
        method: "GET",
        pathname: "/api/v1/registry",
        search: "?name=deploy",
        json: undefined,
      },
      {
        method: "POST",
        pathname: "/api/v1/registry/entry-1/rollback",
        search: "",
        json: { target_version: "1.2.0", reason: "first" },
      },
    ]);
  });

  test("install tolerates unknown flags and extras while preserving global state and output", async () => {
    const root = makeRoot("install");
    const home = join(root, "home");
    mkdirSync(home);
    const archive = makeSkillArchive();
    const requests: CapturedRequest[] = [];

    const result = await withRegistryServer(
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/archive") {
          return new Response(Uint8Array.from(archive.buffer));
        }
        const captured = await captureRequest(request);
        requests.push(captured);
        if (captured.method === "GET" && captured.search) {
          return jsonResponse({ entries: [{ id: "entry-1", name: "cloud-skill" }] });
        }
        if (captured.method === "GET") {
          return jsonResponse({
            entry: { id: "entry-1", name: "cloud-skill" },
            versions: [
              {
                id: "version-1",
                version: "1.4.0",
                content_hash: archive.hash,
                is_current: true,
              },
            ],
          });
        }
        if (captured.pathname.endsWith("/sync")) {
          return jsonResponse({
            entries: [
              {
                download_url: `${url.origin}/archive`,
                latest_version: "1.4.0",
                latest_content_hash: archive.hash,
              },
            ],
          });
        }
        return jsonResponse({ success: true });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(
          home,
          root,
          "install",
          "cloud-skill",
          "ignored",
          "--global",
          "--unknown",
          "--help",
        );
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const outputLines = result.stdout.trim().split("\n");
    expect(outputLines[0]).toBe("Installing cloud-skill v1.4.0...");
    expect(JSON.parse(outputLines[1] ?? "")).toEqual({
      success: true,
      name: "cloud-skill",
      version: "1.4.0",
      path: join(home, ".claude", "skills", "cloud-skill"),
      global: true,
    });
    expect(existsSync(join(home, ".claude", "skills", "cloud-skill", "SKILL.md"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, ".selftune", "registry-state.json"), "utf8")),
    ).toEqual([
      expect.objectContaining({
        entryId: "entry-1",
        name: "cloud-skill",
        version: "1.4.0",
        versionId: "version-1",
        versionHash: archive.hash,
        localContentHash: expect.any(String),
        installPath: join(home, ".claude", "skills", "cloud-skill"),
        receiptId: expect.any(String),
        pendingRegistration: expect.objectContaining({
          installPath: join(home, ".claude", "skills", "cloud-skill"),
          installedContentHash: expect.any(String),
          receiptId: expect.any(String),
        }),
      }),
    ]);
    expect(requests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([
      { method: "GET", pathname: "/api/v1/registry" },
      { method: "GET", pathname: "/api/v1/registry/entry-1" },
      { method: "POST", pathname: "/api/v1/registry/sync" },
      { method: "POST", pathname: "/api/v1/registry/entry-1/install" },
    ]);
  });

  test("install rejects a server-controlled traversal name before download or filesystem writes", async () => {
    const root = makeRoot("install-traversal");
    const home = join(root, "home");
    mkdirSync(home);
    const requests: CapturedRequest[] = [];

    const result = await withRegistryServer(
      async (request) => {
        requests.push(await captureRequest(request));
        return jsonResponse({ entries: [{ id: "entry-1", name: "../outside" }] });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(home, root, "install", "requested-skill", "--global", "--json");
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("Invalid registry skill-name '../outside'"),
      },
    });
    expect(requests).toHaveLength(1);
    expect(existsSync(join(home, ".claude", "outside"))).toBe(false);
  });

  test("malformed registry state fails closed before network or filesystem mutation", async () => {
    const root = makeRoot("invalid-state");
    const home = join(root, "home");
    const configDir = join(home, ".selftune");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "registry-state.json"), "{not-json");
    let requestCount = 0;

    const results = await withRegistryServer(
      () => {
        requestCount++;
        return jsonResponse({ entries: [] });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return Promise.all([
          runRegistry(home, root, "install", "deploy", "--global", "--json"),
          runRegistry(home, root, "sync", "--json"),
          runRegistry(home, root, "status", "--json"),
        ]);
      },
    );

    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "INTERNAL_ERROR",
          message: expect.stringContaining("Invalid registry state"),
        },
      });
    }
    expect(requestCount).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "deploy"))).toBe(false);
  });

  test("push uses the first positional and attached flags before printing its JSON result", async () => {
    const root = makeRoot("push");
    const home = join(root, "home");
    const skillDir = join(root, "skill");
    mkdirSync(home);
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: frontmatter-name\ndescription: Deploy safely\n---\n",
    );
    writeFileSync(join(skillDir, "workflow.md"), "Deploy workflow\n");
    let uploadedMetadata: unknown;
    const requests: CapturedRequest[] = [];

    const result = await withRegistryServer(
      async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET") {
          requests.push(await captureRequest(request));
          return jsonResponse({ entries: [] });
        }
        const form = await request.formData();
        uploadedMetadata = JSON.parse(String(form.get("metadata")));
        requests.push({ method: request.method, pathname: url.pathname, search: url.search });
        return jsonResponse({ success: true });
      },
      async (apiUrl) => {
        configureRegistry(home, apiUrl);
        return runRegistry(
          home,
          skillDir,
          "push",
          "explicit-name",
          "ignored-name",
          "--version=1.2.3",
          "--version=9.9.9",
          "--summary=first",
          "--summary=second",
          "--unknown",
          "--help",
        );
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const outputLines = result.stdout.trim().split("\n");
    expect(outputLines[0]).toMatch(/^Pushing explicit-name v1\.2\.3 \(.+ KB, 2 files\)\.\.\.$/);
    expect(JSON.parse(outputLines[1] ?? "")).toMatchObject({
      success: true,
      name: "explicit-name",
      version: "1.2.3",
      files: 2,
    });
    expect(uploadedMetadata).toMatchObject({
      name: "explicit-name",
      entry_type: "skill",
      description: "Deploy safely",
      version: "1.2.3",
      change_summary: "first",
    });
    expect(requests.map(({ method, pathname, search }) => ({ method, pathname, search }))).toEqual([
      {
        method: "GET",
        pathname: "/api/v1/registry",
        search: "?name=explicit-name",
      },
      { method: "POST", pathname: "/api/v1/registry", search: "" },
    ]);
  });

  test("required-input and local-file errors happen before authentication or network access", async () => {
    const root = makeRoot("validation");
    const home = join(root, "home");
    mkdirSync(home);

    const [install, history, rollback, push] = await Promise.all([
      runRegistry(home, root, "install", "--global", "--unknown"),
      runRegistry(home, root, "history", "--unknown"),
      runRegistry(home, root, "rollback", "--to=1.0.0", "--reason=test"),
      runRegistry(home, root, "push", "--version=1.0.0"),
    ]);

    expect(install.exitCode).toBe(1);
    expect(JSON.parse(install.stderr)).toEqual({
      error: "Usage: selftune registry install <name|github:owner/repo[@ref][//path]>",
      guidance: { next_command: "selftune registry list" },
    });
    expect(history.exitCode).toBe(1);
    expect(JSON.parse(history.stderr)).toEqual({
      error: "Usage: selftune registry history <name>",
    });
    expect(rollback.exitCode).toBe(1);
    expect(JSON.parse(rollback.stderr)).toEqual({
      error: "Usage: selftune registry rollback <name> [--to=version] [--reason=text]",
    });
    expect(push.exitCode).toBe(1);
    expect(JSON.parse(push.stderr)).toEqual({
      error: "No SKILL.md found in current directory. Navigate to a skill folder first.",
      guidance: { next_command: "cd <skill-directory>" },
    });
  });
});
