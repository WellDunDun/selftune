import { describe, expect, it } from "bun:test";

import { cloudFeatureGateContent } from "./CloudFeatureGateDialog";

describe("cloudFeatureGateContent", () => {
  it("frames backup as private portability", () => {
    const content = cloudFeatureGateContent("skill-backup", { name: "adversarial-reviewer" });

    expect(content.title).toBe("Keep this skill available everywhere");
    expect(content.previewName).toBe("adversarial-reviewer");
    expect(content.channels).toEqual(["My devices", "Sandboxes"]);
    expect(content.benefits.flat().join(" ")).toContain("Private by default");
  });

  it("distinguishes private sharing from a public link", () => {
    const content = cloudFeatureGateContent("skill-share");

    expect(content.channels).toEqual(["People", "Workspace"]);
    expect(content.description).toContain("invite a person or your workspace");
    expect(content.benefits.flat().join(" ")).toContain("Choose who gets access");
  });

  it("keeps Skill Set portability as the broad gate", () => {
    const content = cloudFeatureGateContent("skill-set", {
      name: "Review pack",
      detail: "3 included skills · Revision 2",
    });

    expect(content.previewName).toBe("Review pack");
    expect(content.previewDetail).toBe("3 included skills · Revision 2");
    expect(content.channels).toEqual(["My devices", "Sandboxes", "People", "Workspace"]);
  });
});
