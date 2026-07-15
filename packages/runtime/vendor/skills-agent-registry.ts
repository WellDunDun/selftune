import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SKILLS_AGENT_REGISTRY_UPSTREAM =
  "https://github.com/vercel-labs/skills/blob/5527c09adc367612b0bffd9c80e3bc28a6b01b6d/src/agents.ts";

type GlobalRoot =
  | "home"
  | "config"
  | "codex"
  | "claude"
  | "vibe"
  | "hermes"
  | "autohand"
  | "openclaw";

export interface SkillPlacementDefinition {
  id: string;
  displayName: string;
  projectSkillsDir: string;
  globalRoot: GlobalRoot | null;
  globalSkillsDir: string | null;
}

// Vendored from vercel-labs/skills. Keep placement support independent from SelfTune telemetry adapters.
export const SKILL_PLACEMENTS: ReadonlyArray<SkillPlacementDefinition> = [
  {
    id: "aider-desk",
    displayName: "AiderDesk",
    projectSkillsDir: ".aider-desk/skills",
    globalRoot: "home",
    globalSkillsDir: ".aider-desk/skills",
  },
  {
    id: "amp",
    displayName: "Amp",
    projectSkillsDir: ".agents/skills",
    globalRoot: "config",
    globalSkillsDir: "agents/skills",
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".gemini/antigravity/skills",
  },
  {
    id: "antigravity-cli",
    displayName: "Antigravity CLI",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".gemini/antigravity-cli/skills",
  },
  {
    id: "astrbot",
    displayName: "AstrBot",
    projectSkillsDir: "data/skills",
    globalRoot: "home",
    globalSkillsDir: ".astrbot/data/skills",
  },
  {
    id: "autohand-code",
    displayName: "Autohand Code CLI",
    projectSkillsDir: ".autohand/skills",
    globalRoot: "autohand",
    globalSkillsDir: "skills",
  },
  {
    id: "augment",
    displayName: "Augment",
    projectSkillsDir: ".augment/skills",
    globalRoot: "home",
    globalSkillsDir: ".augment/skills",
  },
  {
    id: "bob",
    displayName: "IBM Bob",
    projectSkillsDir: ".bob/skills",
    globalRoot: "home",
    globalSkillsDir: ".bob/skills",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    projectSkillsDir: ".claude/skills",
    globalRoot: "claude",
    globalSkillsDir: "skills",
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    projectSkillsDir: "skills",
    globalRoot: "openclaw",
    globalSkillsDir: "skills",
  },
  {
    id: "cline",
    displayName: "Cline",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "codearts-agent",
    displayName: "CodeArts Agent",
    projectSkillsDir: ".codeartsdoer/skills",
    globalRoot: "home",
    globalSkillsDir: ".codeartsdoer/skills",
  },
  {
    id: "codebuddy",
    displayName: "CodeBuddy",
    projectSkillsDir: ".codebuddy/skills",
    globalRoot: "home",
    globalSkillsDir: ".codebuddy/skills",
  },
  {
    id: "codemaker",
    displayName: "Codemaker",
    projectSkillsDir: ".codemaker/skills",
    globalRoot: "home",
    globalSkillsDir: ".codemaker/skills",
  },
  {
    id: "codestudio",
    displayName: "Code Studio",
    projectSkillsDir: ".codestudio/skills",
    globalRoot: "home",
    globalSkillsDir: ".codestudio/skills",
  },
  {
    id: "codex",
    displayName: "Codex",
    projectSkillsDir: ".agents/skills",
    globalRoot: "codex",
    globalSkillsDir: "skills",
  },
  {
    id: "command-code",
    displayName: "Command Code",
    projectSkillsDir: ".commandcode/skills",
    globalRoot: "home",
    globalSkillsDir: ".commandcode/skills",
  },
  {
    id: "continue",
    displayName: "Continue",
    projectSkillsDir: ".continue/skills",
    globalRoot: "home",
    globalSkillsDir: ".continue/skills",
  },
  {
    id: "cortex",
    displayName: "Cortex Code",
    projectSkillsDir: ".cortex/skills",
    globalRoot: "home",
    globalSkillsDir: ".snowflake/cortex/skills",
  },
  {
    id: "crush",
    displayName: "Crush",
    projectSkillsDir: ".crush/skills",
    globalRoot: "home",
    globalSkillsDir: ".config/crush/skills",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".cursor/skills",
  },
  {
    id: "deepagents",
    displayName: "Deep Agents",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".deepagents/agent/skills",
  },
  {
    id: "devin",
    displayName: "Devin for Terminal",
    projectSkillsDir: ".devin/skills",
    globalRoot: "config",
    globalSkillsDir: "devin/skills",
  },
  {
    id: "dexto",
    displayName: "Dexto",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "droid",
    displayName: "Droid",
    projectSkillsDir: ".factory/skills",
    globalRoot: "home",
    globalSkillsDir: ".factory/skills",
  },
  {
    id: "eve",
    displayName: "Eve",
    projectSkillsDir: "agent/skills",
    globalRoot: null,
    globalSkillsDir: null,
  },
  {
    id: "firebender",
    displayName: "Firebender",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".firebender/skills",
  },
  {
    id: "forgecode",
    displayName: "ForgeCode",
    projectSkillsDir: ".forge/skills",
    globalRoot: "home",
    globalSkillsDir: ".forge/skills",
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".gemini/skills",
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".copilot/skills",
  },
  {
    id: "goose",
    displayName: "Goose",
    projectSkillsDir: ".goose/skills",
    globalRoot: "config",
    globalSkillsDir: "goose/skills",
  },
  {
    id: "hermes-agent",
    displayName: "Hermes Agent",
    projectSkillsDir: ".hermes/skills",
    globalRoot: "hermes",
    globalSkillsDir: "skills",
  },
  {
    id: "inference-sh",
    displayName: "inference.sh",
    projectSkillsDir: ".inferencesh/skills",
    globalRoot: "home",
    globalSkillsDir: ".inferencesh/skills",
  },
  {
    id: "jazz",
    displayName: "Jazz",
    projectSkillsDir: ".jazz/skills",
    globalRoot: "home",
    globalSkillsDir: ".jazz/skills",
  },
  {
    id: "junie",
    displayName: "Junie",
    projectSkillsDir: ".junie/skills",
    globalRoot: "home",
    globalSkillsDir: ".junie/skills",
  },
  {
    id: "iflow-cli",
    displayName: "iFlow CLI",
    projectSkillsDir: ".iflow/skills",
    globalRoot: "home",
    globalSkillsDir: ".iflow/skills",
  },
  {
    id: "kilo",
    displayName: "Kilo Code",
    projectSkillsDir: ".kilocode/skills",
    globalRoot: "home",
    globalSkillsDir: ".kilocode/skills",
  },
  {
    id: "kimi-code-cli",
    displayName: "Kimi Code CLI",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "kiro-cli",
    displayName: "Kiro CLI",
    projectSkillsDir: ".kiro/skills",
    globalRoot: "home",
    globalSkillsDir: ".kiro/skills",
  },
  {
    id: "kode",
    displayName: "Kode",
    projectSkillsDir: ".kode/skills",
    globalRoot: "home",
    globalSkillsDir: ".kode/skills",
  },
  {
    id: "lingma",
    displayName: "Lingma",
    projectSkillsDir: ".lingma/skills",
    globalRoot: "home",
    globalSkillsDir: ".lingma/skills",
  },
  {
    id: "loaf",
    displayName: "Loaf",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "mcpjam",
    displayName: "MCPJam",
    projectSkillsDir: ".mcpjam/skills",
    globalRoot: "home",
    globalSkillsDir: ".mcpjam/skills",
  },
  {
    id: "mistral-vibe",
    displayName: "Mistral Vibe",
    projectSkillsDir: ".vibe/skills",
    globalRoot: "vibe",
    globalSkillsDir: "skills",
  },
  {
    id: "moxby",
    displayName: "Moxby",
    projectSkillsDir: ".moxby/skills",
    globalRoot: "home",
    globalSkillsDir: ".moxby/skills",
  },
  {
    id: "mux",
    displayName: "Mux",
    projectSkillsDir: ".mux/skills",
    globalRoot: "home",
    globalSkillsDir: ".mux/skills",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    projectSkillsDir: ".agents/skills",
    globalRoot: "config",
    globalSkillsDir: "opencode/skills",
  },
  {
    id: "openhands",
    displayName: "OpenHands",
    projectSkillsDir: ".openhands/skills",
    globalRoot: "home",
    globalSkillsDir: ".openhands/skills",
  },
  {
    id: "ona",
    displayName: "Ona",
    projectSkillsDir: ".ona/skills",
    globalRoot: "home",
    globalSkillsDir: ".ona/skills",
  },
  {
    id: "pi",
    displayName: "Pi",
    projectSkillsDir: ".pi/skills",
    globalRoot: "home",
    globalSkillsDir: ".pi/agent/skills",
  },
  {
    id: "qoder",
    displayName: "Qoder",
    projectSkillsDir: ".qoder/skills",
    globalRoot: "home",
    globalSkillsDir: ".qoder/skills",
  },
  {
    id: "qoder-cn",
    displayName: "Qoder CN",
    projectSkillsDir: ".qoder/skills",
    globalRoot: "home",
    globalSkillsDir: ".qoder-cn/skills",
  },
  {
    id: "qwen-code",
    displayName: "Qwen Code",
    projectSkillsDir: ".qwen/skills",
    globalRoot: "home",
    globalSkillsDir: ".qwen/skills",
  },
  {
    id: "replit",
    displayName: "Replit",
    projectSkillsDir: ".agents/skills",
    globalRoot: "config",
    globalSkillsDir: "agents/skills",
  },
  {
    id: "reasonix",
    displayName: "Reasonix",
    projectSkillsDir: ".reasonix/skills",
    globalRoot: "home",
    globalSkillsDir: ".reasonix/skills",
  },
  {
    id: "rovodev",
    displayName: "Rovo Dev",
    projectSkillsDir: ".rovodev/skills",
    globalRoot: "home",
    globalSkillsDir: ".rovodev/skills",
  },
  {
    id: "roo",
    displayName: "Roo Code",
    projectSkillsDir: ".roo/skills",
    globalRoot: "home",
    globalSkillsDir: ".roo/skills",
  },
  {
    id: "tabnine-cli",
    displayName: "Tabnine CLI",
    projectSkillsDir: ".tabnine/agent/skills",
    globalRoot: "home",
    globalSkillsDir: ".tabnine/agent/skills",
  },
  {
    id: "terramind",
    displayName: "Terramind",
    projectSkillsDir: ".terramind/skills",
    globalRoot: "home",
    globalSkillsDir: ".terramind/skills",
  },
  {
    id: "tinycloud",
    displayName: "Tinycloud",
    projectSkillsDir: ".tinycloud/skills",
    globalRoot: "home",
    globalSkillsDir: ".tinycloud/skills",
  },
  {
    id: "trae",
    displayName: "Trae",
    projectSkillsDir: ".trae/skills",
    globalRoot: "home",
    globalSkillsDir: ".trae/skills",
  },
  {
    id: "trae-cn",
    displayName: "Trae CN",
    projectSkillsDir: ".trae/skills",
    globalRoot: "home",
    globalSkillsDir: ".trae-cn/skills",
  },
  {
    id: "warp",
    displayName: "Warp",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "windsurf",
    displayName: "Windsurf",
    projectSkillsDir: ".windsurf/skills",
    globalRoot: "home",
    globalSkillsDir: ".codeium/windsurf/skills",
  },
  {
    id: "zed",
    displayName: "Zed",
    projectSkillsDir: ".agents/skills",
    globalRoot: "home",
    globalSkillsDir: ".agents/skills",
  },
  {
    id: "zcode",
    displayName: "ZCode",
    projectSkillsDir: ".zcode/skills",
    globalRoot: "home",
    globalSkillsDir: ".zcode/skills",
  },
  {
    id: "zencoder",
    displayName: "Zencoder",
    projectSkillsDir: ".zencoder/skills",
    globalRoot: "home",
    globalSkillsDir: ".zencoder/skills",
  },
  {
    id: "zenflow",
    displayName: "Zenflow",
    projectSkillsDir: ".zencoder/skills",
    globalRoot: "home",
    globalSkillsDir: ".zencoder/skills",
  },
  {
    id: "neovate",
    displayName: "Neovate",
    projectSkillsDir: ".neovate/skills",
    globalRoot: "home",
    globalSkillsDir: ".neovate/skills",
  },
  {
    id: "pochi",
    displayName: "Pochi",
    projectSkillsDir: ".pochi/skills",
    globalRoot: "home",
    globalSkillsDir: ".pochi/skills",
  },
  {
    id: "promptscript",
    displayName: "PromptScript",
    projectSkillsDir: ".agents/skills",
    globalRoot: null,
    globalSkillsDir: null,
  },
  {
    id: "adal",
    displayName: "AdaL",
    projectSkillsDir: ".adal/skills",
    globalRoot: "home",
    globalSkillsDir: ".adal/skills",
  },
  {
    id: "universal",
    displayName: "Universal",
    projectSkillsDir: ".agents/skills",
    globalRoot: "config",
    globalSkillsDir: "agents/skills",
  },
];

export interface SkillPlacementPathOptions {
  homeDir?: string;
  configHome?: string;
  codexHome?: string;
  claudeHome?: string;
  vibeHome?: string;
  hermesHome?: string;
  autohandHome?: string;
}

function openClawHome(homeDir: string): string {
  for (const name of [".openclaw", ".clawdbot", ".moltbot"]) {
    const candidate = join(homeDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(homeDir, ".openclaw");
}

function placementRoots(options: SkillPlacementPathOptions): Record<GlobalRoot, string> {
  const homeDir = resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir());
  const configHome = resolve(
    options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(homeDir, ".config"),
  );
  return {
    home: homeDir,
    config: configHome,
    codex: resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homeDir, ".codex")),
    claude: resolve(
      options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude"),
    ),
    vibe: resolve(options.vibeHome ?? process.env.VIBE_HOME ?? join(homeDir, ".vibe")),
    hermes: resolve(options.hermesHome ?? process.env.HERMES_HOME ?? join(homeDir, ".hermes")),
    autohand: resolve(
      options.autohandHome ?? process.env.AUTOHAND_HOME ?? join(homeDir, ".autohand"),
    ),
    openclaw: openClawHome(homeDir),
  };
}

export function resolveGlobalSkillPlacementDirs(options: SkillPlacementPathOptions = {}): string[] {
  const roots = placementRoots(options);
  return [
    ...new Set(
      SKILL_PLACEMENTS.flatMap((placement) =>
        placement.globalRoot && placement.globalSkillsDir
          ? [resolve(roots[placement.globalRoot], placement.globalSkillsDir)]
          : [],
      ),
    ),
  ];
}

export function resolveProjectSkillPlacementDirs(startDir: string): string[] {
  const relativeDirs = new Set(SKILL_PLACEMENTS.map((placement) => placement.projectSkillsDir));
  const paths = new Set<string>();
  let current = resolve(startDir);
  while (true) {
    for (const relativeDir of relativeDirs) paths.add(resolve(current, relativeDir));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...paths];
}
