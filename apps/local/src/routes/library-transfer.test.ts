import { describe, expect, it } from "bun:test";

import { backedArtifact } from "./library-transfer.js";

describe("library share backup resolution", () => {
  it("uses the exact backed artifact without equating catalog ID and display name", () => {
    expect(
      backedArtifact(
        {
          subject: {
            skillId: "code reviewer",
            snapshotId: "snapshot-1",
            artifactId: "backup-skill/Code Reviewer/hash-2",
          },
          syncedArtifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/hash-2",
              artifactType: "skill_revision",
            },
          ],
          snapshot: {
            snapshotId: "snapshot-1",
            artifacts: [
              {
                artifactId: "backup-skill/Other Skill/hash-1",
                artifactType: "skill_revision",
              },
              {
                artifactId: "backup-skill/Code Reviewer/hash-2",
                artifactType: "skill_revision",
              },
            ],
          },
        },
        "code reviewer",
      ),
    ).toEqual({
      snapshotId: "snapshot-1",
      artifactId: "backup-skill/Code Reviewer/hash-2",
    });
  });

  it.each([
    {
      name: "a subject mismatch",
      result: {
        subject: {
          skillId: "another skill",
          snapshotId: "snapshot-1",
          artifactId: "backup-skill/Code Reviewer/hash-2",
        },
        syncedArtifacts: [
          {
            artifactId: "backup-skill/Code Reviewer/hash-2",
            artifactType: "skill_revision",
          },
        ],
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/hash-2",
              artifactType: "skill_revision",
            },
          ],
        },
      },
    },
    {
      name: "a partial reference",
      result: {
        subject: {
          skillId: "code reviewer",
          snapshotId: "snapshot-1",
        },
        syncedArtifacts: [
          {
            artifactId: "backup-skill/Code Reviewer/hash-2",
            artifactType: "skill_revision",
          },
        ],
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/hash-2",
              artifactType: "skill_revision",
            },
          ],
        },
      },
    },
    {
      name: "an artifact not present in the referenced snapshot",
      result: {
        subject: {
          skillId: "code reviewer",
          snapshotId: "snapshot-1",
          artifactId: "backup-skill/Code Reviewer/hash-2",
        },
        syncedArtifacts: [
          {
            artifactId: "backup-skill/Code Reviewer/hash-2",
            artifactType: "skill_revision",
          },
        ],
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Another Skill/hash-1",
              artifactType: "skill_revision",
            },
          ],
        },
      },
    },
    {
      name: "a historical artifact that was not part of this backup",
      result: {
        subject: {
          skillId: "code reviewer",
          snapshotId: "snapshot-1",
          artifactId: "backup-skill/Code Reviewer/hash-2",
        },
        syncedArtifacts: [
          {
            artifactId: "backup-skill/Code Reviewer/hash-3",
            artifactType: "skill_revision",
          },
        ],
        snapshot: {
          snapshotId: "snapshot-1",
          artifacts: [
            {
              artifactId: "backup-skill/Code Reviewer/hash-2",
              artifactType: "skill_revision",
            },
            {
              artifactId: "backup-skill/Code Reviewer/hash-3",
              artifactType: "skill_revision",
            },
          ],
        },
      },
    },
  ])("rejects $name", ({ result }) => {
    expect(backedArtifact(result, "code reviewer")).toBeNull();
  });

  it("rejects an artifact from the released-skill namespace", () => {
    expect(
      backedArtifact(
        {
          subject: {
            skillId: "code reviewer",
            snapshotId: "snapshot-1",
            artifactId: "skill/Code Reviewer/hash-2",
          },
          syncedArtifacts: [
            {
              artifactId: "skill/Code Reviewer/hash-2",
              artifactType: "skill_revision",
            },
          ],
          snapshot: {
            snapshotId: "snapshot-1",
            artifacts: [
              {
                artifactId: "skill/Code Reviewer/hash-2",
                artifactType: "skill_revision",
              },
            ],
          },
        },
        "code reviewer",
      ),
    ).toBeNull();
  });
});
