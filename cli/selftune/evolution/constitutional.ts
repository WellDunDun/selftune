/**
 * constitutional.ts
 *
 * Deterministic pre-validation gate for evolution proposals. Runs before
 * confidence checks and LLM validation to reject obviously bad proposals
 * cheaply — no LLM calls required.
 *
 * Four principles:
 *   1. Size constraint — char limit + word-count ratio
 *   2. No XML injection — reject embedded XML tags
 *   3. No unbounded broadening — reject bare "all/any/every/everything"
 *   4. Anchor preservation — preserve USE WHEN triggers and $skillName refs
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConstitutionalResult {
  passed: boolean;
  violations: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Extract the sentence containing the match index. Splits on sentence-ending
 * punctuation (`.` `!` `?`) followed by whitespace, but avoids splitting on
 * common abbreviations like "e.g." or "i.e.".
 */
function sentenceContaining(text: string, matchIndex: number): string {
  // Split only when the next token looks like a new sentence.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'‘“])/);
  let offset = 0;
  for (const sentence of sentences) {
    const realOffset = text.indexOf(sentence, offset);
    if (realOffset === -1) break;
    if (matchIndex >= realOffset && matchIndex < realOffset + sentence.length) {
      return sentence;
    }
    offset = realOffset + sentence.length;
  }
  return text; // fallback: treat entire text as one sentence
}

const ENUMERATION_MARKERS = /\b(?:including|such as|like)\b|e\.g\.|,\s*\w+\s*,/i;

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

export function checkConstitution(
  proposed: string,
  original: string,
  _skillName: string,
): ConstitutionalResult {
  const violations: string[] = [];

  // -------------------------------------------------------------------------
  // Principle 1: Size constraint
  // -------------------------------------------------------------------------
  if (proposed.length > 8192) {
    violations.push(`Size: ${proposed.length} chars exceeds 8192 limit`);
  }

  const origWords = wordCount(original);
  const propWords = wordCount(proposed);

  if (origWords > 0) {
    const ratio = propWords / origWords;
    if (ratio > 3.0) {
      violations.push(
        `Size: ${propWords} words is ${ratio.toFixed(1)}x original (${origWords} words), exceeds 3.0x limit`,
      );
    }
    if (ratio < 0.3) {
      violations.push(
        `Size: ${propWords} words is ${ratio.toFixed(1)}x original (${origWords} words), below 0.3x limit`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Principle 2: No XML injection
  // -------------------------------------------------------------------------
  if (/<[a-zA-Z][^>]*>/.test(proposed)) {
    violations.push("XML injection: proposed description contains XML/HTML tags");
  }

  // -------------------------------------------------------------------------
  // Principle 3: No unbounded broadening
  // -------------------------------------------------------------------------
  const broadenPattern = /\b(all|any|every|everything)\b/gi;
  let match: RegExpExecArray | null = broadenPattern.exec(proposed);
  while (match !== null) {
    const sentence = sentenceContaining(proposed, match.index);
    if (!ENUMERATION_MARKERS.test(sentence)) {
      violations.push(
        `Unbounded broadening: "${match[0]}" at position ${match.index} without enumeration qualifier`,
      );
    }
    match = broadenPattern.exec(proposed);
  }

  // -------------------------------------------------------------------------
  // Principle 4: Anchor preservation
  // -------------------------------------------------------------------------
  // Check for USE WHEN triggers
  if (/USE WHEN/i.test(original) && !/USE WHEN/i.test(proposed)) {
    violations.push(
      'Anchor: original contains "USE WHEN" trigger phrase that is missing in proposed',
    );
  }

  // Check for $variable references
  const dollarRefs = original.match(/\$[A-Za-z0-9_-]+/g);
  if (dollarRefs) {
    const proposedDollarRefs = new Set(proposed.match(/\$[A-Za-z0-9_-]+/g) ?? []);
    for (const ref of dollarRefs) {
      if (!proposedDollarRefs.has(ref)) {
        violations.push(`Anchor: original contains "${ref}" reference that is missing in proposed`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Size-only check (for body evolution)
// ---------------------------------------------------------------------------

/**
 * Body-specific constitutional check. Only enforces the word-count ratio
 * (0.3x–3.0x of original). The 1024-char absolute limit does not apply
 * to body text since bodies are typically much larger than descriptions.
 */
export function checkConstitutionSizeOnly(
  proposed: string,
  original: string,
): ConstitutionalResult {
  const violations: string[] = [];

  const origWords = wordCount(original);
  const propWords = wordCount(proposed);

  // Only enforce word-count ratio when the original is substantial enough
  // for the ratio to be meaningful (at least 10 words).
  if (origWords >= 10) {
    const ratio = propWords / origWords;
    if (ratio > 3.0) {
      violations.push(
        `Size: ${propWords} words is ${ratio.toFixed(1)}x original (${origWords} words), exceeds 3.0x limit`,
      );
    }
    if (ratio < 0.3) {
      violations.push(
        `Size: ${propWords} words is ${ratio.toFixed(1)}x original (${origWords} words), below 0.3x limit`,
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
