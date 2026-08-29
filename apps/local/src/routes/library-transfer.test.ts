import { describe, expect, it } from "vitest";

import { backedArtifact } from "./library-transfer.js";

describe("library share backup resolution", () => {
  it("selects the requested skill revision from the returned immutable snapshot", () => {
    expect(
      backedArtifact(
        {
          snapshot: {
            snapshotId: "snapshot-1",
            artifacts: [
              { artifactId: "skill/other/hash-1", artifactType: "skill_revision" },
              { artifactId: "skill/reviewer/hash-2", artifactType: "skill_revision" },
            ],
          },
        },
        "reviewer",
      ),
    ).toEqual({ snapshotId: "snapshot-1", artifactId: "skill/reviewer/hash-2" });
  });

  it("does not substitute another skill when the backup response is incomplete", () => {
    expect(
      backedArtifact(
        {
          snapshot: {
            snapshotId: "snapshot-1",
            artifacts: [{ artifactId: "skill/other/hash-1", artifactType: "skill_revision" }],
          },
        },
        "reviewer",
      ),
    ).toBeNull();
  });
});
