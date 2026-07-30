import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  HarnessPackageContribution,
  HarnessPresentation,
  HarnessRuntimeContribution,
} from "@selftune/harness-core/descriptor";
import { svgHarnessIcon } from "@selftune/harness-core/descriptor";

export const openCodePresentation: HarnessPresentation = {
  id: "opencode",
  name: "OpenCode",
  description: "Open-source coding agent with plugin and session import support.",
  icon: svgHarnessIcon(
    "<svg width='32' height='40' viewBox='0 0 32 40' fill='none' xmlns='http://www.w3.org/2000/svg'><g clip-path='url(#clip0_1311_94973)'><path d='M24 32H8V16H24V32Z' fill='#4B4646'/><path d='M24 8H8V32H24V8ZM32 40H0V0H32V40Z' fill='#F1ECEC'/></g><defs><clipPath id='clip0_1311_94973'><rect width='32' height='40' fill='white'/></clipPath></defs></svg>\n",
  ),
  documentation_url: "https://docs.selftune.dev/guides/platform-hooks",
};

export const openCodeRuntime: HarnessRuntimeContribution = {
  id: "opencode",
  detectConnection: ({ homeDir, which }) => {
    const configRoot = join(homeDir, ".config", "opencode");
    const pluginPath = join(configRoot, "plugins", "selftune-opencode-plugin.ts");
    const dataRoot = join(homeDir, ".local", "share", "opencode");
    const databasePath = join(dataRoot, "opencode.db");
    const legacySessionsPath = join(dataRoot, "storage", "session");
    const plugin = existsSync(pluginPath) ? readFileSync(pluginPath, "utf8") : "";
    const hooksInstalled = plugin.includes("selftune-managed") && plugin.includes("opencode hook");
    const importAvailable = existsSync(databasePath) || existsSync(legacySessionsPath);
    return {
      detected: existsSync(configRoot) || existsSync(databasePath) || Boolean(which("opencode")),
      connected: hooksInstalled || importAvailable,
      import_available: importAvailable,
      hooks_supported: true,
      hooks_installed: hooksInstalled,
      config_path: hooksInstalled ? pluginPath : databasePath,
      connected_detail: hooksInstalled ? "Live plugin connected" : "Session import available",
    };
  },
  sourceMerge: {
    invocation: (model) => ({ agent: "opencode", model: model?.trim() || undefined }),
  },
};

export const openCodeHarness: HarnessPackageContribution = {
  presentation: openCodePresentation,
  runtime: openCodeRuntime,
};
