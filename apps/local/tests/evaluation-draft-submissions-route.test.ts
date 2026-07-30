import { describe, expect, it } from "bun:test";

import { createEvaluationDraftSubmissionRoutes } from "../src/routes/evaluation-draft-submissions.js";

const origin = "http://127.0.0.1:3141";
const target = {
  source_id: "source-1",
  snapshot_id: "snapshot-1",
  skill_id: "skill-1",
  suite_id: "suite-1",
  manifest_digest: `sha256:${"a".repeat(64)}`,
};

describe("evaluation draft submission routes", () => {
  it("requires same origin and passes only an exact selected target", async () => {
    let submitted = 0;
    const routes = createEvaluationDraftSubmissionRoutes({
      discover: async () => ({
        draft_id: "draft-1",
        lifecycle: "prepared",
        run_id: null,
        targets: [],
        blockers: [],
      }),
      submit: async (draftId, selection) => {
        submitted++;
        expect(draftId).toBe("draft-1");
        expect(selection).toEqual(target);
        return { run_id: "run-1", status: "scheduled", dispatch: "scheduled" };
      },
    });
    const denied = await routes.handle(
      new Request(`${origin}/api/v2/trace-candidates/draft-1/submit`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify(target),
      }),
      new URL(`${origin}/api/v2/trace-candidates/draft-1/submit`),
      new Set([origin]),
    );
    expect(denied?.status).toBe(403);
    const accepted = await routes.handle(
      new Request(`${origin}/api/v2/trace-candidates/draft-1/submit`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(target),
      }),
      new URL(`${origin}/api/v2/trace-candidates/draft-1/submit`),
      new Set([origin]),
    );
    expect(accepted?.status).toBe(202);
    expect(submitted).toBe(1);
  });

  it("bounds selected target payload before the submission callback", async () => {
    let submitted = false;
    const routes = createEvaluationDraftSubmissionRoutes({
      discover: async () => ({
        draft_id: "draft-1",
        lifecycle: "prepared",
        run_id: null,
        targets: [],
        blockers: [],
      }),
      submit: async () => {
        submitted = true;
        return { run_id: "run-1", status: "scheduled", dispatch: "scheduled" };
      },
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/trace-candidates/draft-1/submit`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(9_000) }),
      }),
      new URL(`${origin}/api/v2/trace-candidates/draft-1/submit`),
      new Set([origin]),
    );
    expect(response?.status).toBe(413);
    expect(submitted).toBeFalse();
  });

  it("rejects malformed encoded draft ids before discovery", async () => {
    let discovered = false;
    const routes = createEvaluationDraftSubmissionRoutes({
      discover: async () => {
        discovered = true;
        return {
          draft_id: "draft-1",
          lifecycle: "prepared",
          run_id: null,
          targets: [],
          blockers: [],
        };
      },
      submit: async () => ({ run_id: "run-1", status: "scheduled", dispatch: "scheduled" }),
    });
    const response = await routes.handle(
      new Request(`${origin}/api/v2/trace-candidates/%E0%A4%A/targets`, { headers: { origin } }),
      new URL(`${origin}/api/v2/trace-candidates/%E0%A4%A/targets`),
      new Set([origin]),
    );
    expect(response?.status).toBe(400);
    expect(discovered).toBeFalse();
  });
});
