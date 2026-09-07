import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ingestDashboardActionEvent } from "@/lib/live-action-feed";
import { LiveActionFeed } from "./live-action-feed";

describe("LiveActionFeed", () => {
  it("renders an ingested run and its output with a link to that exact event", () => {
    const event = {
      event_id: "evt-live-1",
      action: "measure-baseline",
      skill_name: "Taxes",
      skill_path: "/tmp/Taxes/SKILL.md",
      ts: Date.now(),
    } as const;
    ingestDashboardActionEvent({ ...event, stage: "started" });
    ingestDashboardActionEvent({ ...event, stage: "stdout", chunk: "Replaying package evals" });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiveActionFeed />
      </MemoryRouter>,
    );

    expect(html).toContain(
      'href="/live-run?event=evt-live-1&amp;action=measure-baseline&amp;skill=Taxes"',
    );
    expect(html).toContain("Measure baseline");
    expect(html).toContain("Replaying package evals");
  });
});
