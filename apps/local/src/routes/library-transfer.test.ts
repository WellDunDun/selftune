import { describe, expect, it } from "bun:test";

import { backedArtifact, decodeLibraryBackup } from "./library-transfer.js";

describe("library share backup resolution", () => {
  it("keeps the exact requested revision when malformed entries precede it", () => {
    const backup = decodeLibraryBackup({
      snapshot: {
        snapshotId: "snapshot-1",
        artifacts: [
          null,
          42,
          { artifactId: {}, artifactType: "skill_revision" },
          { artifactId: "skill/reviewer-plus/hash", artifactType: "skill_revision" },
          { artifactId: "skill/reviewer/hash", artifactType: "draft" },
          { artifactId: "skill/reviewer/revision", artifactType: "skill_revision" },
        ],
      },
    });
    expect(backedArtifact(backup, "reviewer")).toEqual({
      snapshotId: "snapshot-1",
      artifactId: "skill/reviewer/revision",
    });
  });

  it.each(
    [
      null,
      [],
      {},
      { snapshot: { snapshotId: "", artifacts: [] } },
      { snapshot: { snapshotId: 123, artifacts: [] } },
      { snapshot: { snapshotId: "snapshot", artifacts: "invalid" } },
    ].map((value) => ({ value })),
  )("rejects malformed backup envelopes: $value", ({ value }) => {
    expect(backedArtifact(decodeLibraryBackup(value), "reviewer")).toBeNull();
  });

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
