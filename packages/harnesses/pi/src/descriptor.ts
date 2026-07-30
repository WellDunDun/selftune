import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  HarnessPackageContribution,
  HarnessPresentation,
  HarnessRuntimeContribution,
} from "@selftune/harness-core/descriptor";
import { svgHarnessIcon } from "@selftune/harness-core/descriptor";

const PI_HOOK_NAMES = ["tool_call", "tool_result", "message", "session_shutdown"] as const;

export const piPresentation: HarnessPresentation = {
  id: "pi",
  name: "Pi",
  description: "Pi coding agent with extension hooks and session import.",
  icon: svgHarnessIcon(
    '<svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="40" rx="4" fill="#1a1a2e"/><text x="16" y="28" font-family="serif" font-size="24" font-weight="bold" fill="#e0e0e0" text-anchor="middle">π</text></svg>\n',
    { fit: "contain", inset: "none" },
  ),
  documentation_url: "https://docs.selftune.dev/guides/platform-hooks",
};

export const piRuntime: HarnessRuntimeContribution = {
  id: "pi",
  detectConnection: ({ homeDir, which }) => {
    const root = join(homeDir, ".pi");
    const extensionPath = join(root, "extensions", "selftune");
    const sessionsPath = join(root, "agent", "sessions");
    const hooksInstalled = PI_HOOK_NAMES.every((hookName) => {
      const hookPath = join(extensionPath, hookName);
      if (!existsSync(hookPath)) return false;
      const content = readFileSync(hookPath, "utf8");
      return content.includes("selftune-managed") && content.includes("pi hook");
    });
    const importAvailable = existsSync(sessionsPath);
    return {
      detected: existsSync(root) || Boolean(which("pi")),
      connected: hooksInstalled || importAvailable,
      import_available: importAvailable,
      hooks_supported: true,
      hooks_installed: hooksInstalled,
      config_path: hooksInstalled ? extensionPath : sessionsPath,
      connected_detail: hooksInstalled ? "Live hooks connected" : "Session import available",
    };
  },
  sourceMerge: {
    invocation: (model) => ({ agent: "pi", model: model?.trim() || undefined }),
  },
};

export const piHarness: HarnessPackageContribution = {
  presentation: piPresentation,
  runtime: piRuntime,
};
