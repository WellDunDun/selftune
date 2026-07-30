import { SKILL_CATEGORY_LABELS, type SkillCategoryId } from "./contract.js";
import type { SkillClassification } from "./types.js";
import { parseSkillText } from "./internal/frontmatter.js";
import { clamp } from "./internal/math.js";

interface CategoryDefinition {
  id: Exclude<SkillCategoryId, "general">;
  label: string;
  terms: readonly string[];
}

interface CategorySearchTerm {
  term: string;
  searchToken: string;
  nameOnly: boolean;
}

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    id: "agent_tooling",
    label: "Agent Tooling",
    terms: [
      "agent",
      "agent skill",
      "skill",
      "prompt",
      "mcp",
      "codex",
      "claude code",
      "harness",
      "selftune",
      "tool call",
    ],
  },
  {
    id: "testing_quality",
    label: "Testing & Quality",
    terms: [
      "test",
      "testing",
      "tdd",
      "quality",
      "review",
      "audit",
      "lint",
      "regression",
      "verify",
      "performance",
      "validation",
    ],
  },
  {
    id: "security",
    label: "Security",
    terms: [
      "security",
      "authentication",
      "authentication",
      "authorization",
      "vulnerability",
      "privacy",
      "encryption",
      "credential",
      "secret",
      "threat",
    ],
  },
  {
    id: "operations_automation",
    label: "Operations & Automation",
    terms: [
      "deploy",
      "deployment",
      "infrastructure",
      "devops",
      "automation",
      "cloudflare",
      "worker",
      "cron",
      "monitoring",
      "observability",
      "server",
      "ci cd",
    ],
  },
  {
    id: "data_ai",
    label: "Data & AI",
    terms: [
      "machine learning",
      "artificial intelligence",
      "data",
      "analytics",
      "ai model",
      "language model",
      "llm",
      "embedding",
      "vector",
      "inference",
      "dataset",
      "database",
    ],
  },
  {
    id: "research",
    label: "Research",
    terms: [
      "research",
      "search",
      "browse",
      "paper",
      "academic",
      "literature",
      "source",
      "citation",
      "investigate",
    ],
  },
  {
    id: "writing_content",
    label: "Writing & Content",
    terms: [
      "write",
      "writing",
      "documentation",
      "document",
      "blog",
      "copywriting",
      "prose",
      "content",
      "editorial",
      "changelog",
    ],
  },
  {
    id: "design",
    label: "Design",
    terms: [
      "design",
      "ui",
      "ux",
      "visual",
      "image",
      "figma",
      "interface",
      "typography",
      "layout",
      "art",
      "illustration",
    ],
  },
  {
    id: "product_business",
    label: "Product & Business",
    terms: [
      "product",
      "prd",
      "business",
      "strategy",
      "roadmap",
      "marketing",
      "sales",
      "finance",
      "customer",
      "pricing",
    ],
  },
  {
    id: "communication",
    label: "Communication",
    terms: [
      "email",
      "slack",
      "calendar",
      "meeting",
      "presentation",
      "message",
      "newsletter",
      "interview",
    ],
  },
  {
    id: "software_development",
    label: "Software Development",
    terms: [
      "code",
      "software",
      "programming",
      "typescript",
      "javascript",
      "react",
      "frontend",
      "backend",
      "api",
      "git",
      "repository",
      "refactor",
      "debug",
      "architecture",
      "domain model",
      "router",
      "durable object",
      "sql",
    ],
  },
] as const;

export function normalizeSkillText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CATEGORY_SEARCH_DEFINITIONS = CATEGORY_DEFINITIONS.map((definition) => ({
  definition,
  terms: definition.terms.map(
    (term): CategorySearchTerm => ({
      term,
      searchToken: ` ${normalizeSkillText(term)} `,
      nameOnly: definition.id === "agent_tooling" && term === "skill",
    }),
  ),
}));

function normalizeSearchText(value: string): string {
  return ` ${normalizeSkillText(value)} `;
}

function containsTerm(text: string, searchToken: string): boolean {
  return text.includes(searchToken);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export function classifySkillCategory(
  name: string,
  contents: ReadonlyArray<string>,
  queryTexts: ReadonlyArray<string>,
): Pick<
  SkillClassification,
  "category" | "category_label" | "confidence" | "reason" | "matched_terms"
> {
  const parsed = contents.map(parseSkillText);
  const nameText = normalizeSearchText(name);
  const descriptionText = normalizeSearchText(parsed.map((value) => value.description).join(" "));
  const bodyText = normalizeSearchText(parsed.map((value) => value.body.slice(0, 4_000)).join(" "));
  const queryText = normalizeSearchText(queryTexts.join(" "));
  const hasDescriptionText = descriptionText !== "  ";
  const scores = CATEGORY_SEARCH_DEFINITIONS.map(({ definition, terms }) => {
    let score = 0;
    const matchedTerms = new Set<string>();
    for (const { term, searchToken, nameOnly } of terms) {
      if (containsTerm(nameText, searchToken)) {
        score += 4;
        matchedTerms.add(term);
      }
      if (!nameOnly && containsTerm(descriptionText, searchToken)) {
        score += 2.5;
        matchedTerms.add(term);
      }
      if (!nameOnly && containsTerm(queryText, searchToken)) {
        score += 1.25;
        matchedTerms.add(term);
      }
      if (!nameOnly && !hasDescriptionText && containsTerm(bodyText, searchToken)) {
        score += 0.5;
        matchedTerms.add(term);
      }
    }
    return { definition, score, matchedTerms: [...matchedTerms] };
  }).toSorted((left, right) => right.score - left.score);

  const best = scores[0];
  const runnerUp = scores[1];
  if (!best || best.score < 2) {
    return {
      category: "general",
      category_label: SKILL_CATEGORY_LABELS.general,
      confidence: 0.35,
      reason: "No category had enough specific local evidence, so this skill remains General.",
      matched_terms: [],
    };
  }

  const margin = Math.max(0, best.score - (runnerUp?.score ?? 0));
  const confidence = clamp(
    0.5 + (best.score / (best.score + 10)) * 0.32 + (margin / (best.score + 1)) * 0.16,
    0.5,
    0.98,
  );
  const matchedTerms = best.matchedTerms.toSorted().slice(0, 6);
  return {
    category: best.definition.id,
    category_label: best.definition.label,
    confidence: round(confidence),
    reason: `Matched ${best.definition.label.toLowerCase()} evidence: ${matchedTerms.join(", ")}.`,
    matched_terms: matchedTerms,
  };
}
