interface SkillText {
  description: string;
  body: string;
}

export function parseSkillText(content: string): SkillText {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { description: content, body: content };

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) return { description: content, body: content };

  const frontmatter = lines.slice(1, endIndex);
  let description = "";
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index]!.trimEnd();
    if (!line.startsWith("description:")) continue;
    const value = line.slice("description:".length).trim();
    if (value !== ">" && value !== "|") {
      description = value;
      break;
    }
    const continuation: string[] = [];
    for (let next = index + 1; next < frontmatter.length; next += 1) {
      const candidate = frontmatter[next]!;
      if (candidate.length === 0 || !/^\s/.test(candidate)) break;
      continuation.push(candidate.trim());
    }
    description = continuation.join(" ").trim();
    break;
  }
  return {
    description,
    body: lines
      .slice(endIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}
