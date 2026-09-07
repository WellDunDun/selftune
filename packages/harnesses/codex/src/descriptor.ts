import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { CodexHooksFile } from "./adapters/codex/hooks-config.js";

import type {
  HarnessPackageContribution,
  HarnessPresentation,
  HarnessRuntimeContribution,
} from "@selftune/harness-core/descriptor";
import { svgHarnessIcon } from "@selftune/harness-core/descriptor";

export function hasCodexHooksAt(path: string): boolean {
  try {
    const { hooks } = Schema.decodeUnknownSync(Schema.fromJsonString(CodexHooksFile))(
      readFileSync(path, "utf8"),
    );
    return ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].every(
      (event) =>
        hooks?.[event]?.some((group) =>
          group.hooks.some((handler) => {
            const command = handler.command;
            return (
              command !== undefined &&
              command.includes("codex hook") &&
              command.includes("selftune")
            );
          }),
        ) === true,
    );
  } catch {
    return false;
  }
}

export const codexPresentation: HarnessPresentation = {
  id: "codex",
  name: "Codex",
  description: "OpenAI's coding agent with hooks and rollout import.",
  icon: svgHarnessIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#171816"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>\n',
    { fit: "contain", inset: "sm", invert_in_dark: true },
  ),
  documentation_url: "https://docs.selftune.dev/guides/platform-hooks",
};

export const codexRuntime: HarnessRuntimeContribution = {
  id: "codex",
  detectConnection: ({ homeDir, which }) => {
    const root = process.env.CODEX_HOME || join(homeDir, ".codex");
    const hooksPath = join(root, "hooks.json");
    const sessionsPath = join(root, "sessions");
    const hooksInstalled = hasCodexHooksAt(hooksPath);
    const importAvailable = existsSync(sessionsPath);
    return {
      detected: existsSync(root) || Boolean(which("codex")),
      connected: hooksInstalled || importAvailable,
      import_available: importAvailable,
      hooks_supported: true,
      hooks_installed: hooksInstalled,
      config_path: hooksInstalled ? hooksPath : sessionsPath,
      connected_detail: hooksInstalled ? "Live hooks connected" : "Session import available",
    };
  },
  sourceMerge: {
    invocation: (model) => ({ agent: "codex", model: model?.trim() || undefined }),
  },
};

export const codexHarness: HarnessPackageContribution = {
  presentation: codexPresentation,
  runtime: codexRuntime,
};
