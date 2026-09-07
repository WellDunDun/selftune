import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSkillSet } from "@selftune/library";

import {
  installSkillSetPlugin,
  previewSkillSetPluginInstall,
  type PluginInstallRuntime,
} from "../src/skill-set-plugin-install.js";

function fixture(root: string) {
  const packagePath = join(root, "skills", "research");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    "---\nname: research\ndescription: Research carefully.\n---\n\n# Research\n",
  );
  const configRoot = join(root, "config");
  const manifest = createSkillSet(
    {
      name: "Research team",
      description: "Shared research workflows",
      harnesses: ["claude_code", "codex"],
      skills: [{ name: "research", package_path: packagePath }],
    },
    { configRoot },
  );
  return { configRoot, manifest };
}

function runtime(
  calls: string[],
  installed: { readonly claude?: string; readonly codex?: string } = {},
  marketplaceRoot?: string,
): PluginInstallRuntime {
  return {
    which: (command) => `/tools/${command}`,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    run: (command, args) => {
      const invocation = [command, ...args].join(" ");
      calls.push(invocation);
      if (args.join(" ") === "plugin list --json") {
        if (command.endsWith("claude")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              installed.claude
                ? [{ id: "research-team@selftune-placeholder", version: installed.claude }]
                : [],
            ),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed.codex
              ? [{ pluginId: "research-team@selftune-placeholder", version: installed.codex }]
              : [],
          }),
          stderr: "",
        };
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        if (!marketplaceRoot) {
          return {
            exitCode: 0,
            stdout: command.endsWith("claude") ? "[]" : '{"marketplaces":[]}',
            stderr: "",
          };
        }
        const name = marketplaceRoot.split("/").at(-1);
        return {
          exitCode: 0,
          stdout: command.endsWith("claude")
            ? JSON.stringify([{ name, path: marketplaceRoot }])
            : JSON.stringify({ marketplaces: [{ name, root: marketplaceRoot }] }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };
}

describe("Skill Set native plugin installation", () => {
  test.each([true, false])(
    "retains current/update decisions for both host formats: current=%s",
    (current) => {
      const root = mkdtempSync(join(tmpdir(), "selftune-plugin-version-state-"));
      try {
        const { configRoot, manifest } = fixture(root);
        const initial = previewSkillSetPluginInstall(manifest.set_id, { configRoot }, runtime([]));
        const calls: string[] = [];
        const base = runtime(
          calls,
          {},
          join(configRoot, "plugin-marketplaces", initial.marketplaceName),
        );
        const version = current ? initial.pluginVersion : "0.0.0-selftune.previous";
        const id = `${initial.pluginName}@${initial.marketplaceName}`;
        const installed: PluginInstallRuntime = {
          ...base,
          run: (command, args) => {
            if (args.join(" ") === "plugin list --json") {
              calls.push([command, ...args].join(" "));
              return {
                exitCode: 0,
                stderr: "",
                stdout: command.endsWith("claude")
                  ? JSON.stringify([{ id, version }])
                  : JSON.stringify({ installed: [{ pluginId: id, version }] }),
              };
            }
            return base.run(command, args);
          },
        };
        const preview = previewSkillSetPluginInstall(manifest.set_id, { configRoot }, installed);
        expect(preview.hosts.map((host) => host.status)).toEqual(
          current
            ? ["already_current", "already_current"]
            : ["update_available", "update_available"],
        );
        const receipt = installSkillSetPlugin(
          {
            setId: manifest.set_id,
            expectedRevisionHash: manifest.revision_hash,
            hosts: ["claude", "codex"],
          },
          { configRoot },
          installed,
        );
        expect(receipt.hosts.map((host) => host.result)).toEqual(
          current ? ["already_current", "already_current"] : ["updated", "updated"],
        );
        if (current) expect(calls.every((call) => call.endsWith("list --json"))).toBe(true);
        else {
          expect(calls).toContain(`/tools/claude plugin update ${id} --scope user`);
          expect(calls).toContain(`/tools/codex plugin remove ${id} --json`);
          expect(calls).toContain(`/tools/codex plugin add ${id} --json`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["claude", "codex"] as const)(
    "blocks writes when %s inventory cannot be inspected",
    (host) => {
      const root = mkdtempSync(join(tmpdir(), "selftune-plugin-invalid-inventory-"));
      try {
        const { configRoot, manifest } = fixture(root);
        for (const stdout of ["{", "null", "{}", '[{"version":"1.0.0"}]']) {
          const calls: string[] = [];
          const base = runtime(calls);
          const invalid: PluginInstallRuntime = {
            ...base,
            run: (command, args) => {
              if (command.endsWith(host) && args.join(" ") === "plugin list --json") {
                calls.push([command, ...args].join(" "));
                return { exitCode: 0, stdout, stderr: "" };
              }
              return base.run(command, args);
            },
          };
          expect(() =>
            installSkillSetPlugin(
              {
                setId: manifest.set_id,
                expectedRevisionHash: manifest.revision_hash,
                hosts: [host],
              },
              { configRoot },
              invalid,
            ),
          ).toThrow("inventory response is invalid");
          expect(existsSync(join(configRoot, "plugin-marketplaces"))).toBe(false);
          expect(existsSync(join(configRoot, "plugin-installs"))).toBe(false);
          expect(calls.every((call) => call.endsWith("list --json"))).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["claude", "codex"] as const)(
    "preserves existing marketplace files when %s preflight fails",
    (host) => {
      const root = mkdtempSync(join(tmpdir(), "selftune-plugin-marketplace-preflight-"));
      try {
        const { configRoot, manifest } = fixture(root);
        const preview = previewSkillSetPluginInstall(manifest.set_id, { configRoot }, runtime([]));
        const marketRoot = join(configRoot, "plugin-marketplaces", preview.marketplaceName);
        mkdirSync(marketRoot, { recursive: true });
        const sentinel = join(marketRoot, "previous.txt");
        writeFileSync(sentinel, "keep previous marketplace");
        const failures = [
          { exitCode: 1, stdout: "", stderr: "host offline" },
          { exitCode: 0, stdout: "null", stderr: "" },
          {
            exitCode: 0,
            stdout:
              host === "claude"
                ? JSON.stringify([{ name: preview.marketplaceName }])
                : JSON.stringify({ marketplaces: [{ name: preview.marketplaceName }] }),
            stderr: "",
          },
          {
            exitCode: 0,
            stdout:
              host === "claude"
                ? JSON.stringify([{ name: preview.marketplaceName, path: join(root, "foreign") }])
                : JSON.stringify({
                    marketplaces: [{ name: preview.marketplaceName, root: join(root, "foreign") }],
                  }),
            stderr: "",
          },
        ];
        for (const failure of failures) {
          const calls: string[] = [];
          const base = runtime(calls);
          const invalid: PluginInstallRuntime = {
            ...base,
            run: (command, args) => {
              if (command.endsWith(host) && args.join(" ") === "plugin marketplace list --json") {
                calls.push([command, ...args].join(" "));
                return failure;
              }
              return base.run(command, args);
            },
          };
          expect(() =>
            installSkillSetPlugin(
              {
                setId: manifest.set_id,
                expectedRevisionHash: manifest.revision_hash,
                hosts: [host],
              },
              { configRoot },
              invalid,
            ),
          ).toThrow();
          expect(readFileSync(sentinel, "utf8")).toBe("keep previous marketplace");
          expect(existsSync(join(configRoot, "plugin-installs"))).toBe(false);
          expect(calls.every((call) => call.endsWith("list --json"))).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("materializes one local marketplace and delegates installation to both host CLIs", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-plugin-install-"));
    const calls: string[] = [];
    try {
      const { configRoot, manifest } = fixture(root);
      const preview = previewSkillSetPluginInstall(manifest.set_id, { configRoot }, runtime(calls));
      expect(preview.hosts.map((host) => host.status)).toEqual(["ready", "ready"]);

      const receipt = installSkillSetPlugin(
        {
          setId: manifest.set_id,
          expectedRevisionHash: preview.revisionHash,
          hosts: ["claude", "codex"],
        },
        { configRoot },
        runtime(calls),
      );

      const marketplaceRoot = join(configRoot, "plugin-marketplaces", preview.marketplaceName);
      expect(receipt.hosts.map((host) => host.result)).toEqual(["installed", "installed"]);
      expect(existsSync(join(marketplaceRoot, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(
        existsSync(
          join(marketplaceRoot, "plugins", "research-team", "skills", "research", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(marketplaceRoot, "plugins", "research-team", ".codex-plugin", "plugin.json"),
            "utf8",
          ),
        ).version,
      ).toBe(preview.pluginVersion);
      expect(calls.some((call) => call.includes("claude plugin marketplace add"))).toBe(true);
      expect(calls.some((call) => call.includes("claude plugin install"))).toBe(true);
      expect(calls.some((call) => call.includes("codex plugin marketplace add"))).toBe(true);
      expect(calls.some((call) => call.includes("codex plugin add"))).toBe(true);
      expect(
        existsSync(join(configRoot, "plugin-installs", `${preview.marketplaceName}.json`)),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects stale confirmation before writing the marketplace", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-plugin-stale-"));
    const calls: string[] = [];
    try {
      const { configRoot, manifest } = fixture(root);
      expect(() =>
        installSkillSetPlugin(
          {
            setId: manifest.set_id,
            expectedRevisionHash: "0".repeat(64),
            hosts: ["claude"],
          },
          { configRoot },
          runtime(calls),
        ),
      ).toThrow(/changed after the install review/);
      expect(existsSync(join(configRoot, "plugin-marketplaces"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unavailable host without attempting installation", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-plugin-host-"));
    try {
      const { configRoot, manifest } = fixture(root);
      const unavailableRuntime: PluginInstallRuntime = {
        which: () => null,
        now: () => new Date("2026-08-09T12:00:00.000Z"),
        run: () => ({ exitCode: 1, stdout: "", stderr: "not available" }),
      };
      const preview = previewSkillSetPluginInstall(
        manifest.set_id,
        { configRoot },
        unavailableRuntime,
      );
      expect(preview.hosts.every((host) => host.status === "unavailable")).toBe(true);
      expect(() =>
        installSkillSetPlugin(
          {
            setId: manifest.set_id,
            expectedRevisionHash: preview.revisionHash,
            hosts: ["codex"],
          },
          { configRoot },
          unavailableRuntime,
        ),
      ).toThrow(/not installed on this machine/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
