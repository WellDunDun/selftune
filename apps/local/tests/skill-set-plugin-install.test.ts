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
