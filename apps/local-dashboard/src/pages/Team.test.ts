import { describe, expect, it } from "vitest";

import { teamFailureContent } from "./Team";

describe("Team failure messaging", () => {
  it("does not tell a linked user to reconnect when the overview endpoint fails", () => {
    expect(teamFailureContent(true, new Error("Cloud returned an invalid response."))).toEqual({
      title: "Team data is temporarily unavailable",
      description: "You’re connected to SelfTune Cloud, but we couldn’t load your workspace.",
      detail: "Cloud returned an invalid response.",
      action: "retry",
    });
  });

  it("offers connection setup only when Desktop confirms there is no Cloud link", () => {
    expect(teamFailureContent(false, null)).toMatchObject({
      title: "Connect Cloud to see your team",
      detail: null,
      action: "connect",
    });
  });
});
