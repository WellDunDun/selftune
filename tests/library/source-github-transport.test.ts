import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  loadGitHubArchive,
  loadGitHubBlob,
  loadGitHubTree,
} from "../../packages/runtime/source-management/metadata-adapter.js";
import { installFetchSpy } from "../helpers/fetch-spy.js";

let restoreFetch: (() => void) | undefined;
beforeEach(() => {
  restoreFetch = installFetchSpy(() => {
    throw new Error("Unexpected source metadata request");
  });
});
afterEach(() => restoreFetch?.());

test("requests tree, archive, and blob with their API headers and explicit credentials", async () => {
  const requests: Request[] = [];
  restoreFetch?.();
  restoreFetch = installFetchSpy(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.includes("/git/trees/")) {
      return Response.json({ sha: "root", tree: [{ path: "skill", type: "tree", sha: "leaf" }] });
    }
    if (request.url.includes("/tarball/")) return new Response("archive bytes");
    return Response.json({ encoding: "base64", content: "c2tp\n bGw=", size: 5 });
  });
  const options = { githubToken: "test-token" };
  expect(await loadGitHubTree("transport/skills", "feature/test", options)).toEqual({
    sha: "root",
    tree: [{ path: "skill", type: "tree", sha: "leaf" }],
  });
  expect((await loadGitHubArchive("transport/skills", "feature/test", options))?.toString()).toBe(
    "archive bytes",
  );
  expect((await loadGitHubBlob("transport/skills", "blob-id", options))?.toString()).toBe("skill");
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.github.com/repos/transport/skills/git/trees/feature%2Ftest?recursive=1",
    "https://api.github.com/repos/transport/skills/tarball/feature%2Ftest",
    "https://api.github.com/repos/transport/skills/git/blobs/blob-id",
  ]);
  expect(requests.map((request) => request.headers.get("Accept"))).toEqual([
    "application/vnd.github.v3+json",
    "application/vnd.github+json",
    "application/vnd.github+json",
  ]);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(request.headers.get("User-Agent")).toBe("selftune-desktop");
  }
});

test.each([
  "null",
  "[]",
  "{}",
  '{"encoding":"utf8","content":"skill"}',
  '{"encoding":"base64","content":42}',
  '{"encoding":"base64"}',
  "{",
])("rejects malformed GitHub blob response %s", async (body) => {
  restoreFetch?.();
  restoreFetch = installFetchSpy(async (input, init) => {
    expect(new Request(input, init).headers.has("Authorization")).toBe(false);
    return new Response(body);
  });
  expect(await loadGitHubBlob("transport/skills", "bad-blob", { githubToken: null })).toBeNull();
});

test("keeps HTTP failures and empty base64 blobs distinct", async () => {
  restoreFetch?.();
  restoreFetch = installFetchSpy(async () => new Response("unavailable", { status: 503 }));
  expect(await loadGitHubBlob("transport/skills", "missing", { githubToken: null })).toBeNull();
  expect(await loadGitHubArchive("transport/skills", null, { githubToken: null })).toBeNull();
  restoreFetch();
  restoreFetch = installFetchSpy(async () => Response.json({ encoding: "base64", content: "" }));
  expect(await loadGitHubBlob("transport/skills", "empty", { githubToken: null })).toEqual(
    Buffer.alloc(0),
  );
});
