import { describe, expect, it } from "vitest";

import { cloudFeatureGateContent } from "./CloudFeatureGateDialog";

describe("cloudFeatureGateContent", () => {
  it("frames backup as private portability", () => {
    const content = cloudFeatureGateContent("skill-backup", { name: "adversarial-reviewer" });

    expect(content.title).toBe("Keep this skill available everywhere");
    expect(content.previewName).toBe("adversarial-reviewer");
    expect(content.channels).toEqual(["My devices", "Sandboxes"]);
    expect(content.benefits.flat().join(" ")).toContain("Private by default");
  });

  it("describes the currently supported reusable link boundary", () => {
    const content = cloudFeatureGateContent("skill-share");

    expect(content.channels).toEqual(["Copy link"]);
    expect(content.description).toContain("expiring link");
    expect(content.benefits.flat().join(" ")).toContain("Direct download");
  });

  it("keeps Skill Set portability as the broad gate", () => {
    const content = cloudFeatureGateContent("skill-set", {
      name: "Review pack",
      detail: "3 included skills · Revision 2",
    });

    expect(content.previewName).toBe("Review pack");
    expect(content.previewDetail).toBe("3 included skills · Revision 2");
    expect(content.channels).toEqual(["My devices", "Sandboxes", "Copy link"]);
  });
});
