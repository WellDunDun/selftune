import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityPanel } from "./ActivityTimeline";
import { EvolutionTimeline } from "./EvolutionTimeline";
import { STATUS_STYLE } from "./SkillsLibrary";
import { STATUS_CONFIG } from "../lib/constants";
import type { EvolutionEntry, SkillHealthStatus } from "../types";

describe("shared status contracts", () => {
  it("covers every health state in both library presentations", () => {
    const statuses = ["HEALTHY", "WARNING", "CRITICAL", "UNGRADED", "UNKNOWN"] as const;
    const coverage = {
      HEALTHY: true,
      WARNING: true,
      CRITICAL: true,
      UNGRADED: true,
      UNKNOWN: true,
    } satisfies Record<SkillHealthStatus, boolean>;
    expect(Object.keys(coverage).sort()).toEqual([...statuses].sort());
    for (const status of statuses) {
      expect(STATUS_STYLE[status].label.length).toBeGreaterThan(0);
      expect(STATUS_CONFIG[status].label.length).toBeGreaterThan(0);
    }
  });

  it.each(["deployed", "future_action", "constructor", "__proto__"])(
    "renders recorded action %s without treating inherited object properties as configuration",
    (action) => {
      const entry: EvolutionEntry = {
        timestamp: "2026-09-05T00:00:00Z",
        proposal_id: "proposal-1",
        skill_name: "marketing",
        action,
        details: "Recorded lifecycle event",
      };
      const timeline = renderToStaticMarkup(
        <EvolutionTimeline entries={[entry]} selectedProposalId={null} onSelect={() => {}} />,
      );
      const activity = renderToStaticMarkup(
        <ActivityPanel evolution={[entry]} pendingProposals={[]} unmatchedQueries={[]} />,
      );
      expect(timeline).toContain("#proposal");
      expect(activity).toContain("Recorded lifecycle event");
      expect(timeline).not.toContain("[object Object]");
      expect(activity).not.toContain("[object Object]");
    },
  );
});
