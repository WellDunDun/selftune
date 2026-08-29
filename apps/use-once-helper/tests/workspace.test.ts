import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { makeOsUseOnceWorkspace, STALE_WORKSPACE_TTL_MS } from "../src";

const roots: string[] = [];

function manualTiming(current: () => Date) {
  let heartbeat: (() => void | Promise<void>) | undefined;
  return {
    options: {
      now: current,
      heartbeatIntervalMs: 10,
      leaseAbandonmentMs: 30,
      recoveryObservationMs: 0,
      setInterval(callback: () => void | Promise<void>) {
        heartbeat = callback;
        return callback;
      },
      clearInterval: () => undefined,
      sleep: async () => undefined,
    },
    heartbeat: async () => {
      await heartbeat?.();
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("owned temporary use-once workspace", () => {
  test("stages only user-readable regular files and removes them idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    const workspace = makeOsUseOnceWorkspace({ temporaryRoot: root });
    const staged = await workspace.stage({
      files: [
        { path: "SKILL.md", content: new TextEncoder().encode("# Skill") },
        { path: "references/guide.md", content: new TextEncoder().encode("Guide") },
      ],
    });

    expect((await stat(staged.rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(staged.skillDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(staged.skillDirectory, "SKILL.md"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(staged.skillDirectory, "references/guide.md"), "utf8")).toBe(
      "Guide",
    );
    await staged.cleanup();
    await staged.cleanup();
    expect(await stat(staged.rootDirectory).catch(() => null)).toBeNull();
  });

  test("recovers an expired workspace only after proving its lease abandoned", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    let current = new Date("2026-07-21T00:00:00.000Z");
    const timing = manualTiming(() => current);
    const oldWorkspace = makeOsUseOnceWorkspace({ temporaryRoot: root, ...timing.options });
    const staged = await oldWorkspace.stage({
      files: [{ path: "SKILL.md", content: new TextEncoder().encode("# Skill") }],
    });
    const foreign = join(root, "selftune-use-once-foreign");
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, ".selftune-use-once-owned.json"), "{}", { mode: 0o600 });

    current = new Date(current.getTime() + STALE_WORKSPACE_TTL_MS + 31);
    await oldWorkspace.recoverStale();
    expect(await stat(staged.rootDirectory).catch(() => null)).toBeNull();
    expect((await stat(foreign)).isDirectory()).toBe(true);
  });

  test("never recovers an active workspace older than the marker TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    let current = new Date("2026-07-21T00:00:00.000Z");
    const timing = manualTiming(() => current);
    const workspace = makeOsUseOnceWorkspace({ temporaryRoot: root, ...timing.options });
    const staged = await workspace.stage({
      files: [{ path: "SKILL.md", content: new TextEncoder().encode("# Skill") }],
    });
    current = new Date(current.getTime() + STALE_WORKSPACE_TTL_MS + 31);
    await timing.heartbeat();
    await workspace.recoverStale();
    expect((await stat(staged.rootDirectory)).isDirectory()).toBe(true);
    await staged.cleanup();
  });

  test("concurrent recovery attempts acquire one abandonment claim safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    let current = new Date("2026-07-21T00:00:00.000Z");
    const timing = manualTiming(() => current);
    const workspace = makeOsUseOnceWorkspace({ temporaryRoot: root, ...timing.options });
    const staged = await workspace.stage({
      files: [{ path: "SKILL.md", content: new TextEncoder().encode("# Skill") }],
    });
    current = new Date(current.getTime() + STALE_WORKSPACE_TTL_MS + 31);
    await Promise.all([workspace.recoverStale(), workspace.recoverStale()]);
    expect(await stat(staged.rootDirectory).catch(() => null)).toBeNull();
  });

  test("a heartbeat between confirmation and final delete fences stale recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    let current = new Date("2026-07-21T00:00:00.000Z");
    const timing = manualTiming(() => current);
    const workspace = makeOsUseOnceWorkspace({
      temporaryRoot: root,
      ...timing.options,
      beforeRecoveryDelete: timing.heartbeat,
    });
    const staged = await workspace.stage({
      files: [{ path: "SKILL.md", content: new TextEncoder().encode("# Skill") }],
    });
    current = new Date(current.getTime() + STALE_WORKSPACE_TTL_MS + 31);
    await workspace.recoverStale();
    expect((await stat(staged.rootDirectory)).isDirectory()).toBe(true);
    await staged.cleanup();
  });

  test("unique OS directories keep concurrent stages isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "selftune-helper-test-"));
    roots.push(root);
    const workspace = makeOsUseOnceWorkspace({ temporaryRoot: root });
    const [first, second] = await Promise.all([
      workspace.stage({
        files: [{ path: "SKILL.md", content: new TextEncoder().encode("first") }],
      }),
      workspace.stage({
        files: [{ path: "SKILL.md", content: new TextEncoder().encode("second") }],
      }),
    ]);
    expect(first.rootDirectory).not.toBe(second.rootDirectory);
    expect(await readFile(join(first.skillDirectory, "SKILL.md"), "utf8")).toBe("first");
    expect(await readFile(join(second.skillDirectory, "SKILL.md"), "utf8")).toBe("second");
    await Promise.all([first.cleanup(), second.cleanup()]);
  });
});
