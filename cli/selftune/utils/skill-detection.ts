export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

export function getInternalPromptTargetSkill(
  text: string,
  knownSkillNames: Iterable<string>,
): string | null {
  if (!text) return null;
  const isInternalSkillPrompt =
    text.includes("You are a skill description optimizer") ||
    text.includes("You are an evaluation assistant") ||
    text.includes("Given this skill description");
  if (!isInternalSkillPrompt) return null;

  const candidates = [
    /Skill Name:\s*([^\n]+)/i,
    /Propose an improved description for the "([^"]+)" skill/i,
    /would each query trigger the "([^"]+)" skill/i,
  ];
  for (const pattern of candidates) {
    const match = text.match(pattern);
    const rawSkillName = match?.[1]?.trim();
    if (!rawSkillName) continue;
    const normalizedTarget = normalizeSkillName(rawSkillName);
    for (const skillName of knownSkillNames) {
      if (normalizeSkillName(skillName) === normalizedTarget) {
        return skillName;
      }
    }
    return rawSkillName;
  }
  return null;
}

export function isWrappedNonUserPart(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<INSTRUCTIONS>")
  );
}
