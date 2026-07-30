import { createRootRoute, createRoute } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectsScreen } from "@selftune/dashboard-core/screens/projects";
import { RecipientShareScreen } from "@selftune/dashboard-core/screens/recipient-shares";
import { SkillsLibraryScreen } from "@selftune/dashboard-core/screens/skills";

import {
  APP_CORE_ROUTE_MANIFEST,
  APP_CORE_RECIPIENT_ROUTE_MANIFEST,
  APP_CORE_RECIPIENT_ROUTE_REGISTRY,
  APP_CORE_ROUTE_IDS,
  APP_CORE_ROUTE_REGISTRY,
  APP_CORE_ROUTES,
  APP_CORE_SHELL_NAVIGATION,
  appendAppHostRoutes,
  createAppCoreRecipientRoutesFromComponents,
  createAppCoreRoutes,
  createAppCoreRoutesFromComponents,
  createAppCoreRecipientRoutes,
  matchAppCoreShellRoute,
  EvidenceBodyEvolutionReviewSurface,
  resolveAppCoreRouteManifest,
} from "../index";

function ReplacementSkillsScreen() {
  return <div>Replacement</div>;
}

function ReplacementProjectsScreen() {
  return <div>Replacement projects</div>;
}

function ReplacementRecipientScreen() {
  return <div>Replacement recipient</div>;
}

describe("app-core route composition", () => {
  it("uses the existing shared dashboard-core screens as the canonical source", () => {
    expect(APP_CORE_ROUTES.skills.Component).toBe(SkillsLibraryScreen);
    expect(APP_CORE_ROUTES.projects.Component).toBe(ProjectsScreen);
    expect(APP_CORE_ROUTE_MANIFEST).toEqual([
      {
        id: "skills",
        path: "/skills",
        label: "Skills",
        tooltip: "Browse skills",
        headerTitle: "Skills",
        Component: SkillsLibraryScreen,
      },
      {
        id: "projects",
        path: "/projects",
        label: "Skill Sets",
        tooltip: "Reusable Skill Sets",
        headerTitle: "Skill Sets",
        Component: ProjectsScreen,
      },
    ]);
  });

  it("requires route divergence to be declared through exclude and replace", () => {
    const resolved = resolveAppCoreRouteManifest({
      exclude: ["projects"],
      replace: { skills: ReplacementSkillsScreen },
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: "skills", path: "/skills" });
    expect(resolved[0]?.Component).toBe(ReplacementSkillsScreen);
  });

  it("derives shared shell navigation and headers from the canonical registry", () => {
    expect(APP_CORE_SHELL_NAVIGATION).toEqual(
      APP_CORE_ROUTE_IDS.map((id) => ({
        id,
        path: APP_CORE_ROUTE_REGISTRY[id].path,
        label: APP_CORE_ROUTE_REGISTRY[id].navigation.label,
        tooltip: APP_CORE_ROUTE_REGISTRY[id].navigation.tooltip,
      })),
    );
    expect(matchAppCoreShellRoute("/skills/example")?.header.title).toBe("Skills");
    expect(matchAppCoreShellRoute("/projects")?.header.title).toBe("Skill Sets");
    expect(matchAppCoreShellRoute("/settings")).toBeNull();
  });

  it("mounts every manifest entry beneath a host-owned TanStack root", () => {
    const rootRoute = createRootRoute();
    const routes = createAppCoreRoutes(rootRoute);

    expect(Object.keys(routes)).toEqual(APP_CORE_ROUTE_IDS.map((id) => `${id}Route`));
    for (const entry of APP_CORE_ROUTE_MANIFEST) {
      const mounted = routes[`${entry.id}Route`];
      expect(mounted?.options).toMatchObject({ path: entry.path });
      expect(mounted?.options.component).toBe(entry.Component);
    }
  });

  it("mounts exhaustive host-provided components through canonical route factories", () => {
    const rootRoute = createRootRoute();
    const routes = createAppCoreRoutesFromComponents(rootRoute, {
      skills: ReplacementSkillsScreen,
      projects: ReplacementProjectsScreen,
    });
    const recipientRoutes = createAppCoreRecipientRoutesFromComponents(rootRoute, {
      publicRecipientShare: ReplacementRecipientScreen,
      claimedRecipientShare: ReplacementRecipientScreen,
    });

    expect(routes.skillsRoute?.options).toMatchObject({
      path: "/skills",
      component: ReplacementSkillsScreen,
    });
    expect(routes.projectsRoute?.options).toMatchObject({
      path: "/projects",
      component: ReplacementProjectsScreen,
    });
    expect(recipientRoutes.publicRecipientShareRoute?.options).toMatchObject({
      path: "/share/$claimToken",
      component: ReplacementRecipientScreen,
    });
    expect(recipientRoutes.claimedRecipientShareRoute?.options).toMatchObject({
      path: "/inbox/shares/$invitationId",
      component: ReplacementRecipientScreen,
    });
  });

  it("keeps recipient routes canonical but outside product-shell navigation", () => {
    expect(APP_CORE_RECIPIENT_ROUTE_MANIFEST).toEqual([
      {
        id: "publicRecipientShare",
        path: "/share/:claimToken",
        visibility: "public",
        Component: RecipientShareScreen,
      },
      {
        id: "claimedRecipientShare",
        path: "/inbox/shares/:invitationId",
        visibility: "authenticated",
        Component: RecipientShareScreen,
      },
    ]);
    expect(APP_CORE_SHELL_NAVIGATION.map(({ id }) => id)).not.toContain("publicRecipientShare");
    expect(APP_CORE_RECIPIENT_ROUTE_REGISTRY.publicRecipientShare.visibility).toBe("public");

    const rootRoute = createRootRoute();
    const routes = createAppCoreRecipientRoutes(rootRoute, {
      replace: { publicRecipientShare: ReplacementRecipientScreen },
    });
    expect(
      routes.publicRecipientShareRoute && "path" in routes.publicRecipientShareRoute.options
        ? routes.publicRecipientShareRoute.options.path
        : null,
    ).toBe("/share/$claimToken");
    expect(routes.publicRecipientShareRoute?.options.component).toBe(ReplacementRecipientScreen);
    expect(
      routes.claimedRecipientShareRoute && "path" in routes.claimedRecipientShareRoute.options
        ? routes.claimedRecipientShareRoute.options.path
        : null,
    ).toBe("/inbox/shares/$invitationId");
    expect(routes.claimedRecipientShareRoute?.options.component).toBe(RecipientShareScreen);
  });

  it("appends host routes while rejecting implicit shared-route overrides", () => {
    const rootRoute = createRootRoute();
    const coreRoutes = createAppCoreRoutes(rootRoute);
    const billingRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/billing",
      component: ReplacementSkillsScreen,
    });

    const composed = appendAppHostRoutes(coreRoutes, { billingRoute });
    const routeTree = rootRoute.addChildren(composed);

    expect(composed.billingRoute).toBe(billingRoute);
    expect(routeTree.children).toEqual(Object.values(composed));
    expect(() => appendAppHostRoutes(coreRoutes, { skillsRoute: billingRoute })).toThrow(
      'Host route key "skillsRoute" conflicts with app-core',
    );
  });
});

describe("evidence body-evolution review surface", () => {
  it.each([
    ["loading", "Preparing review"],
    ["insufficient_evidence", "Insufficient evidence"],
    ["provider_unavailable", "Provider unavailable"],
    ["malformed_output", "Malformed provider output"],
    ["regression_blocked", "Regression blocked"],
    ["stale_revision", "Stale target revision"],
    ["accepted", "Accepted"],
    ["rejected", "Rejected"],
    ["deferred", "Deferred"],
    ["rolled_back", "Rolled back"],
  ] as const)("renders the %s lifecycle state without fabricating a candidate", (state, label) => {
    const html = renderToStaticMarkup(
      <EvidenceBodyEvolutionReviewSurface
        review={{
          schemaVersion: 1,
          id: `body-candidate-${state}`,
          state,
          stateSummary: `The lifecycle reported ${state}.`,
        }}
      />,
    );

    expect(html).toContain(label);
    expect(html).toContain(`The lifecycle reported ${state}.`);
    expect(html).not.toContain("Exact body diff");
  });

  it("renders a review-ready exact-revision candidate without an apply action", () => {
    const html = renderToStaticMarkup(
      <EvidenceBodyEvolutionReviewSurface
        review={{
          schemaVersion: 1,
          id: "body-candidate-192",
          state: "candidate_ready",
          target: {
            skillName: "research",
            skillPath: ".agents/skills/research/SKILL.md",
            revision: "sha256:installed-revision",
            section: "Evidence handling",
            scope: "section_local",
          },
          pattern: {
            id: "pattern-1",
            kind: "repeated_correlated_errors",
            summary: "Research runs omit source constraints after invocation.",
            observedAt: "2026-07-23T10:00:00.000Z",
            causalStatus: "non_causal",
          },
          cohort: {
            fingerprint: "cohort-sha256",
            selectorVersion: "evidence-cohort/v1",
            failures: 2,
            comparableSuccesses: 2,
            counterexamples: 1,
            heldout: 1,
            excerpts: [
              {
                id: "failure-1",
                partition: "calibration",
                role: "failure",
                summary: "A failed source constraint check.",
                excerpt: "Require primary sources.",
                sourceReference: "codex://trace/1",
                redaction: "redacted",
              },
            ],
            payloadPreview: {
              bytes: 31,
              limitBytes: 4_096,
              excerptIds: ["failure-1"],
              content: "Require primary sources.",
            },
          },
          candidate: {
            operation: "refine",
            principle: "Preserve source constraints before drafting.",
            applicability: "Research tasks with source requirements.",
            summary: "Adds a section-local constraint reminder.",
            diffText: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new",
            preservedConstraints: ["Keep citations required."],
          },
          evaluation: {
            calibration: {
              state: "passed",
              summary: "Target failure mode improved.",
              conditions: [],
            },
            holdout: { state: "passed", summary: "Blind holdout did not regress.", conditions: [] },
            regression: { state: "passed", summary: "No measured regression." },
          },
          uncertainty: ["The pattern is correlational, not causal."],
          provenance: {
            generator: "local-teacher",
            generatorContractVersion: "body-proposal/v1",
            evidenceFingerprint: "cohort-sha256",
            sourceReferences: ["codex://trace/1"],
          },
          actions: {
            accept: { access: "available" },
            edit: { access: "available" },
            reject: { access: "available" },
            defer: { access: "available" },
          },
        }}
      />,
    );

    for (const text of [
      "Evidence body evolution review",
      "Cohort composition",
      "Selected evidence",
      "Payload preview",
      "Exact body diff",
      "Calibration",
      "Blind holdout",
      "Accept candidate",
      "Edit candidate",
      "Reject candidate",
      "Defer review",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("Apply candidate");
    expect(html).toContain("sha256:installed-revision");
  });
});
