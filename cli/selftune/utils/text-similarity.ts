const BASE_TEXT_SIMILARITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "user",
  "when",
  "with",
]);

export function buildStopwordSet(additionalStopwords: string[] = []): Set<string> {
  return new Set([...BASE_TEXT_SIMILARITY_STOPWORDS, ...additionalStopwords]);
}

export function tokenizeText(
  text: string,
  stopwords = BASE_TEXT_SIMILARITY_STOPWORDS,
): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopwords.has(token)),
  );
}

export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

export function extractWhenToUseLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##+\s+when to use\s*$/i.test(line.trim()));
  if (start === -1) return [];

  const extracted: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^##+\s+/.test(line)) break;
    if (/^[-*]\s+/.test(line)) {
      extracted.push(line.replace(/^[-*]\s+/, "").trim());
      continue;
    }
    extracted.push(line);
  }
  return extracted;
}
