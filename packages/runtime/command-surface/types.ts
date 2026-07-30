export interface PublicCommandFlag {
  flag: string;
  helpLabel: string;
  description: string;
}

export interface PublicCommandSurface {
  command: string;
  summary: string;
  usage: string;
  flags: readonly PublicCommandFlag[];
  quickReference: string;
  extraHelpSections?: readonly string[];
}

function formatOptionLines(flags: readonly PublicCommandFlag[]): string[] {
  const width = Math.max(...flags.map((flag) => flag.helpLabel.length), 0) + 2;
  return flags.map((flag) => `  ${flag.helpLabel.padEnd(width)}${flag.description}`);
}

export function renderCommandHelp(surface: PublicCommandSurface): string {
  const lines = [
    `${surface.command} — ${surface.summary}`,
    "",
    "Usage:",
    `  ${surface.usage}`,
    "",
    "Options:",
    ...formatOptionLines(surface.flags),
  ];

  for (const section of surface.extraHelpSections ?? []) {
    lines.push("", ...section.split("\n"));
  }

  return lines.join("\n");
}
