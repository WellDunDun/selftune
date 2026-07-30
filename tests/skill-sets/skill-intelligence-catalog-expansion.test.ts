import { describe, expect, test } from "bun:test";

import {
  suggestCatalogSkillSetExpansions,
  type CatalogExpansionCatalogEntry,
  type CatalogExpansionInstalledSkill,
} from "@selftune/skill-intelligence/catalog-expansion";

function catalog(
  catalogId: string,
  name: string,
  source: string,
  description: string,
): CatalogExpansionCatalogEntry {
  return {
    catalog_id: catalogId,
    name,
    source,
    install_spec: `${source}@${name}`,
    download_url: `https://skills.sh/api/download/${source}/${name}`,
    description,
  };
}

function installed(
  name: string,
  sourceId: string,
  description: string,
): CatalogExpansionInstalledSkill {
  return {
    name,
    package_path: `/skills/${name}`,
    source_id: sourceId,
    description,
  };
}

const reusableEngineeringSkills = [
  installed("diagnose", "mattpocock/skills", "Diagnose failures and establish root cause."),
  installed("tdd", "mattpocock/skills", "Use test driven development and regression tests."),
  installed(
    "codebase-design",
    "mattpocock/skills",
    "Improve software architecture and codebase design.",
  ),
  catalog(
    "mattpocock/skills/to-issues",
    "to-issues",
    "mattpocock/skills",
    "Turn an implementation plan into issues for project planning.",
  ),
];

describe("catalog-backed Skill Set expansion", () => {
  test("builds a broad web set without collapsing independent same-source skills", () => {
    const entries = [
      catalog(
        "cloudflare/skills/cloudflare",
        "cloudflare",
        "cloudflare/skills",
        "Build on the Cloudflare Workers edge runtime and serverless platform.",
      ),
      catalog(
        "cloudflare/skills/wrangler",
        "wrangler",
        "cloudflare/skills",
        "Use the Wrangler deployment CLI for platform operations.",
      ),
      catalog(
        "shadcn/ui/shadcn",
        "shadcn",
        "shadcn/ui",
        "Build frontend components with the shadcn component library.",
      ),
      catalog(
        "vercel-labs/agent-skills/vercel-react-best-practices",
        "vercel-react-best-practices",
        "vercel-labs/agent-skills",
        "Apply React best practices and React performance guidance.",
      ),
      ...reusableEngineeringSkills.filter((entry) => "install_spec" in entry),
    ];
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
      catalog_entries: entries,
      project_signals: {
        project_root: "/projects/web-store",
        dependencies: ["react", "@cloudflare/workers-types"],
        frameworks: ["Cloudflare Workers", "React"],
      },
    });

    const web = expansions.find((expansion) => expansion.profile_id === "web_full_stack");
    expect(web).toMatchObject({
      name: "Cloudflare Full-Stack",
      evidence_state: "exploratory",
      evidence_basis: "project_context_and_catalog",
      project_root: "/projects/web-store",
    });
    expect(web?.skills.map((skill) => skill.name)).toEqual([
      "cloudflare",
      "wrangler",
      "shadcn",
      "vercel-react-best-practices",
      "codebase-design",
      "to-issues",
      "diagnose",
    ]);
    expect(web?.skills.filter((skill) => skill.source === "cloudflare/skills")).toHaveLength(2);
    expect(web?.skills.find((skill) => skill.name === "wrangler")?.install_spec).toBe(
      "cloudflare/skills@wrangler",
    );
    expect(web?.skills.find((skill) => skill.name === "wrangler")?.download_url).toBe(
      "https://skills.sh/api/download/cloudflare/skills/wrangler",
    );
    expect(web?.reason).toContain("not been validated by recurring local usage");
  });

  test("builds a mobile set with simulator tooling and reusable engineering skills", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
      catalog_entries: [
        catalog(
          "flutter/skills/flutter-apply-architecture-best-practices",
          "flutter-apply-architecture-best-practices",
          "flutter/skills",
          "Build cross-platform mobile applications with the Flutter mobile framework.",
        ),
        catalog(
          "dart-lang/skills/dart-run-static-analysis",
          "dart-run-static-analysis",
          "dart-lang/skills",
          "Implement mobile applications in the Dart language.",
        ),
        catalog(
          "evanbacon/serve-sim/serve-sim",
          "serve-sim",
          "evanbacon/serve-sim",
          "Run and inspect applications with iOS simulator tooling.",
        ),
        ...reusableEngineeringSkills.filter((entry) => "install_spec" in entry),
      ],
      project_signals: {
        project_root: "/projects/mobile-app",
        frameworks: ["Flutter"],
        languages: ["Dart"],
        files: ["ios/Runner.xcodeproj", "lib/main.dart"],
      },
    });

    const mobile = expansions.find((expansion) => expansion.profile_id === "mobile");
    expect(mobile?.name).toBe("Mobile Engineering");
    expect(mobile?.skills.map((skill) => skill.name)).toEqual([
      "flutter-apply-architecture-best-practices",
      "dart-run-static-analysis",
      "serve-sim",
      "codebase-design",
      "to-issues",
      "diagnose",
      "tdd",
    ]);
    expect(mobile?.skills.find((skill) => skill.name === "serve-sim")?.install_spec).toBe(
      "evanbacon/serve-sim@serve-sim",
    );
  });

  test("bounds matched signal samples without changing full-count scoring", () => {
    const matchingIntents = Array.from(
      { length: 10 },
      (_, index) => `Flutter mobile signal ${index} ${"context ".repeat(40)}`,
    );
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: [
        {
          ...installed("flutter-core", "flutter/skills", "Flutter mobile framework."),
          capabilities: ["mobile_framework"],
        },
        {
          ...installed("dart-language", "dart-lang/skills", "Dart language guidance."),
          capabilities: ["language"],
        },
        {
          ...installed("serve-sim", "evanbacon/serve-sim", "iOS simulator tooling."),
          capabilities: ["simulator_tooling"],
        },
      ],
      catalog_entries: [],
      project_signals: { intents: matchingIntents },
    });

    const mobile = expansions.find((expansion) => expansion.profile_id === "mobile");
    expect(mobile?.matched_signal_count).toBe(matchingIntents.length);
    expect(mobile?.matched_signals).toHaveLength(8);
    expect(mobile?.matched_signals).toEqual(
      matchingIntents.slice(0, 8).map((signal) => signal.toLowerCase().trim().slice(0, 240)),
    );
    expect(mobile?.matched_signals.every((signal) => signal.length === 240)).toBe(true);
    expect(mobile?.context_score).toBe(
      Number(Math.min(1, matchingIntents.length / 8 + 0.5).toFixed(3)),
    );
  });

  test("treats an installed serve-sim skill as mobile project context", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: [
        ...reusableEngineeringSkills.filter(
          (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
        ),
        installed(
          "serve-sim",
          "evanbacon/serve-sim",
          "Control and inspect an iOS Simulator from an agent.",
        ),
      ],
      catalog_entries: [
        catalog(
          "flutter/skills/flutter-apply-architecture-best-practices",
          "flutter-apply-architecture-best-practices",
          "flutter/skills",
          "Flutter framework.",
        ),
        catalog(
          "dart-lang/skills/dart-run-static-analysis",
          "dart-run-static-analysis",
          "dart-lang/skills",
          "Dart language.",
        ),
      ],
      project_signals: { intents: ["Use serve-sim for this project"] },
    });

    const mobile = expansions.find((expansion) => expansion.profile_id === "mobile");
    expect(mobile?.skills.find((skill) => skill.name === "serve-sim")).toMatchObject({
      provenance: "installed",
      package_path: "/skills/serve-sim",
    });
  });

  test("does not emit a partial web set when a required capability is missing", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: [],
      catalog_entries: [
        catalog("cloudflare/skills/cloudflare", "cloudflare", "cloudflare/skills", "Workers."),
        catalog("cloudflare/skills/wrangler", "wrangler", "cloudflare/skills", "Deploy CLI."),
        catalog("shadcn/ui/shadcn", "shadcn", "shadcn/ui", "Frontend component library."),
      ],
      project_signals: { frameworks: ["Cloudflare Workers", "React"] },
    });

    expect(expansions.some((expansion) => expansion.profile_id === "web_full_stack")).toBe(false);
  });

  test("builds a High-Rigor Review set and reuses core skills across expansions", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
      catalog_entries: [
        catalog(
          "mattpocock/skills/thermonuclear-review",
          "thermonuclear-review",
          "mattpocock/skills",
          "Perform adversarial review and high-rigor code audit.",
        ),
      ],
      project_signals: {
        project_root: "/projects/payment-service",
        intents: ["Review the refactor for regressions and architecture risks"],
      },
    });

    const review = expansions.find((expansion) => expansion.profile_id === "high_rigor_review");
    expect(review?.skills.map((skill) => skill.name)).toEqual([
      "thermonuclear-review",
      "diagnose",
      "tdd",
      "codebase-design",
    ]);
    expect(review?.skills.every((skill) => skill.role.length > 0)).toBe(true);
  });

  test("does not emit an incomplete catalog set or invent missing packages", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: [],
      catalog_entries: [
        catalog(
          "flutter/skills/flutter-apply-architecture-best-practices",
          "flutter-apply-architecture-best-practices",
          "flutter/skills",
          "Build Flutter mobile applications.",
        ),
      ],
      project_signals: { frameworks: ["Flutter"], languages: ["Dart"] },
    });

    expect(expansions).toEqual([]);
  });

  test("keeps reusable skills in multiple context-specific sets", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
      catalog_entries: [
        catalog(
          "cloudflare/skills/cloudflare",
          "cloudflare",
          "cloudflare/skills",
          "Cloudflare Workers edge runtime.",
        ),
        catalog(
          "cloudflare/skills/wrangler",
          "wrangler",
          "cloudflare/skills",
          "Wrangler deployment CLI.",
        ),
        catalog("shadcn/ui/shadcn", "shadcn", "shadcn/ui", "Frontend component library."),
        catalog(
          "vercel-labs/agent-skills/vercel-react-best-practices",
          "vercel-react-best-practices",
          "vercel-labs/agent-skills",
          "React best practices and performance.",
        ),
        catalog(
          "flutter/skills/flutter-apply-architecture-best-practices",
          "flutter-apply-architecture-best-practices",
          "flutter/skills",
          "Flutter mobile framework.",
        ),
        catalog(
          "dart-lang/skills/dart-run-static-analysis",
          "dart-run-static-analysis",
          "dart-lang/skills",
          "Dart language guidance.",
        ),
        catalog(
          "evanbacon/serve-sim/serve-sim",
          "serve-sim",
          "evanbacon/serve-sim",
          "iOS simulator tooling.",
        ),
        catalog(
          "mattpocock/skills/thermonuclear-review",
          "thermonuclear-review",
          "mattpocock/skills",
          "Adversarial high-rigor code review.",
        ),
        ...reusableEngineeringSkills.filter((entry) => "install_spec" in entry),
      ],
      project_signals: {
        frameworks: ["Cloudflare Workers", "React", "Flutter"],
        languages: ["Dart"],
        intents: ["Review mobile and web architecture for regressions"],
      },
    });

    expect(expansions.map((expansion) => expansion.name).toSorted()).toEqual([
      "Cloudflare Full-Stack",
      "High-Rigor Review",
      "Mobile Engineering",
    ]);
    expect(
      expansions.filter((expansion) => expansion.skills.some((skill) => skill.name === "diagnose")),
    ).toHaveLength(3);
    expect(
      expansions
        .flatMap((expansion) =>
          expansion.skills.filter((skill) => skill.name === "diagnose").map((skill) => skill.role),
        )
        .every((role) => role.length > 0),
    ).toBe(true);
  });

  test("deduplicates only through explicit equivalence or bundle metadata", () => {
    const entries: CatalogExpansionCatalogEntry[] = [
      {
        ...catalog(
          "review/source/review-suite",
          "review-suite",
          "review/source",
          "Perform adversarial high-rigor review and code audit.",
        ),
        capabilities: ["rigorous_review"],
      },
      {
        ...catalog(
          "review/source/review-child",
          "review-child",
          "review/source",
          "Perform adversarial high-rigor review and code audit.",
        ),
        capabilities: ["rigorous_review"],
        relation: { bundled_by: "review/source/review-suite" },
      },
    ];
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
      catalog_entries: entries,
      project_signals: { intents: ["High-rigor architecture review"] },
    });

    const review = expansions.find((expansion) => expansion.profile_id === "high_rigor_review");
    expect(review?.skills.map((skill) => skill.name)).toEqual([
      "review-suite",
      "diagnose",
      "tdd",
      "codebase-design",
    ]);
  });

  test("uses broad Bucharest mobile skills instead of incidental Flutter and Dart mentions", () => {
    const mobileSkills: CatalogExpansionInstalledSkill[] = [
      {
        ...installed(
          "flutter-add-integration-test",
          "flutter/skills",
          "Add a Flutter integration test and run it on a device.",
        ),
        harness: "codex",
      },
      {
        ...installed(
          "flutter-apply-architecture-best-practices",
          "flutter/skills",
          "Apply broad Flutter application architecture best practices.",
        ),
        harness: "codex",
      },
      {
        ...installed(
          "dart-run-static-analysis",
          "dart-lang/skills",
          "Run static analysis for a Dart application.",
        ),
        harness: "codex",
      },
      installed("convex-dart", "get-convex/skills", "Use Convex from a Dart or Flutter app."),
      {
        ...installed(
          "serve-sim",
          "evanbacon/serve-sim",
          "Control and inspect a running iOS simulator.",
        ),
        harness: "codex",
      },
      ...reusableEngineeringSkills.filter(
        (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
      ),
    ];
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: mobileSkills,
      catalog_entries: [],
      project_signals: {
        project_root: "/projects/hikayatna",
        intents: ["Build and verify the Flutter mobile app in the iOS simulator"],
      },
    });

    const mobile = expansions.find((expansion) => expansion.profile_id === "mobile");
    expect(mobile?.skills.slice(0, 3).map((skill) => skill.name)).toEqual([
      "flutter-apply-architecture-best-practices",
      "dart-run-static-analysis",
      "serve-sim",
    ]);
    expect(mobile?.skills.every((skill) => skill.provenance === "installed")).toBe(true);
    expect(mobile?.harnesses).toEqual(["codex"]);
  });

  test("does not substitute a narrow audit skill for Thermonuclear Review", () => {
    const expansions = suggestCatalogSkillSetExpansions({
      installed_skills: [
        installed(
          "convex-performance-audit",
          "get-convex/skills",
          "An adversarial high-rigor code audit for Convex performance.",
        ),
        ...reusableEngineeringSkills.filter(
          (entry): entry is CatalogExpansionInstalledSkill => "package_path" in entry,
        ),
      ],
      catalog_entries: [],
      project_signals: { intents: ["Run a high-rigor architecture review"] },
    });

    expect(expansions.some((expansion) => expansion.profile_id === "high_rigor_review")).toBe(
      false,
    );
  });
});
