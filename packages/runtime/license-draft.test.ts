import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyLicenseDraft, previewLicenseDraft } from "./license-draft";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-license-draft-"));
  roots.push(root);
  writeFileSync(
    join(root, "SKILL.md"),
    "---\nname: coach-notes\ndescription: Complete coach notes.\n---\n\n# Coach Notes\n",
  );
  return root;
}

const terms = {
  copyrightHolder: "Daniel Petro",
  licensedOrganization: "Ithraa Center",
  year: 2026,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("license draft review boundary", () => {
  test("previews SKILL.md and LICENSE without writing", () => {
    const root = fixture();
    const before = readFileSync(join(root, "SKILL.md"), "utf8");

    const preview = previewLicenseDraft(root, terms);

    expect(preview.licenseExpression).toBe("LicenseRef-Ithraa-Center-Proprietary");
    expect(preview.files.map((file) => file.path)).toEqual(["SKILL.md", "LICENSE"]);
    expect(preview.files[0]?.patch).toContain("+license: LicenseRef-Ithraa-Center-Proprietary");
    expect(preview.files[1]?.patch).toContain(
      "+Permission is granted exclusively to Ithraa Center",
    );
    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(before);
    expect(existsSync(join(root, "LICENSE"))).toBe(false);
  });

  test("applies exactly the reviewed draft", () => {
    const root = fixture();
    const preview = previewLicenseDraft(root, terms);

    applyLicenseDraft({ skillPath: root, previewId: preview.previewId, terms });

    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain(
      "license: LicenseRef-Ithraa-Center-Proprietary",
    );
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("Ithraa Center");
  });

  test("rejects a stale preview without writing a license", () => {
    const root = fixture();
    const preview = previewLicenseDraft(root, terms);
    writeFileSync(
      join(root, "SKILL.md"),
      `${readFileSync(join(root, "SKILL.md"), "utf8")}\nchanged\n`,
    );

    expect(() =>
      applyLicenseDraft({ skillPath: root, previewId: preview.previewId, terms }),
    ).toThrow("changed after this draft was reviewed");
    expect(existsSync(join(root, "LICENSE"))).toBe(false);
  });
});
